# Copyright (c) 2026 RV
"""
Transport for UltimateAI gateway research calls (POST /v1/responses).

Only /v1/responses runs the native web_search tool on this gateway
(chat/completions silently ignores web_search_options) and text.format
json_schema is not enforced, so every caller gets structured output via a
record_* function tool. Web search is verified on gpt-5.6-sol; override
via PA_COMPS_MODEL. In-memory results are memoized per key with a TTL.
"""

import json
import os
import queue
import threading
import time

import requests

ENDPOINT = "https://smart.ultimateai.org/v1/responses"
TIMEOUT = 240.0
# Low reasoning effort cut a listing-check session from ~40s to ~24s with no
# loss of output shape; override (medium/high) via PA_RESEARCH_EFFORT.
REASONING_EFFORT = os.environ.get("PA_RESEARCH_EFFORT") or "low"

_CACHE = {}


def _model():
    # Resolved per call: app.py loads .env after this module is imported.
    return os.environ.get("PA_COMPS_MODEL") or "gpt-5.6-sol"


class SearchError(Exception):
    def __init__(self, message, http_status=502):
        super().__init__(message)
        self.http_status = http_status


def configured():
    return bool(os.environ.get("PA_ULTIMATEAI_API_KEY"))


def cached(key, ttl, fn):
    """Memoize fn() under key for ttl seconds (in-memory)."""
    entry = _CACHE.get(key)
    now = time.time()
    if entry and now - entry["at"] < ttl:
        return entry["value"]
    value = fn()
    _CACHE[key] = {"value": value, "at": now}
    return value


def cached_get(key, ttl):
    """Peek the cache without computing (for stream routes that only run
    the research when the cache is cold)."""
    entry = _CACHE.get(key)
    if entry and time.time() - entry["at"] < ttl:
        return entry["value"]
    return None


def cache_put(key, value):
    _CACHE[key] = {"value": value, "at": time.time()}


def clear_cache(prefix=None):
    for k in list(_CACHE):
        if prefix is None or str(k).startswith(prefix):
            del _CACHE[k]


def _research_payload(instructions, task, record_tool, stream=False):
    payload = {
        "model": _model(),
        "instructions": instructions,
        "input": task,
        "tools": [{"type": "web_search"}, record_tool],
        "max_output_tokens": 8000,
    }
    if REASONING_EFFORT:
        payload["reasoning"] = {"effort": REASONING_EFFORT}
    if stream:
        payload["stream"] = True
    return payload


def _post(payload, stream=False):
    try:
        r = requests.post(
            ENDPOINT,
            headers={"Authorization": f"Bearer {os.environ['PA_ULTIMATEAI_API_KEY']}"},
            json=payload,
            timeout=TIMEOUT,
            stream=stream,
        )
    except requests.RequestException as e:
        raise SearchError(f"gateway request failed: {e}") from e
    if r.status_code != 200:
        snippet = r.text.strip()[:160]
        # Cloudflare edge 5xx (522/524/...) comes back as an HTML error page;
        # surface a clean retry hint instead of the markup.
        if snippet.startswith("<"):
            detail = ("gateway edge dropped the session mid-research "
                      "(usually a timeout) — try again")
        else:
            detail = snippet
        raise SearchError(f"UltimateAI API error {r.status_code}: {detail}")
    return r


def _record_from_body(body, record_tool, list_key, sanitize):
    for item in body.get("output") or []:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "function_call" and item.get("name") == record_tool["name"]:
            try:
                args = json.loads(item.get("arguments") or "{}")
            except ValueError:
                continue
            rows = args.get(list_key) if isinstance(args, dict) else None
            return sanitize(rows)
    raise SearchError("search produced no structured results")


def run_research(instructions, task, record_tool, list_key, sanitize):
    """POST to /v1/responses; return sanitize() applied to the record tool's
    payload under list_key."""
    r = _post(_research_payload(instructions, task, record_tool))
    try:
        body = r.json()
    except ValueError as e:
        raise SearchError("gateway returned a non-JSON response") from e
    return _record_from_body(body, record_tool, list_key, sanitize)


def run_research_streaming(instructions, task, record_tool, list_key, sanitize,
                           on_event=None):
    """run_research with stream:true. on_event receives live progress dicts,
    e.g. {"kind": "search", "query": "..."} as each web_search_call starts.
    Falls back to buffered parsing if the gateway doesn't stream."""
    r = _post(_research_payload(instructions, task, record_tool, stream=True),
              stream=True)
    if "text/event-stream" not in (r.headers.get("content-type") or ""):
        try:
            body = r.json()
        except ValueError as e:
            raise SearchError("gateway returned a non-JSON response") from e
        return _record_from_body(body, record_tool, list_key, sanitize)

    final_args = None
    for line in r.iter_lines(decode_unicode=True):
        if not (line and line.startswith("data: ")):
            continue
        try:
            evt = json.loads(line[6:])
        except ValueError:
            continue
        evt_type = evt.get("type") or ""
        if evt_type == "response.output_item.added":
            item = evt.get("item") or {}
            if item.get("type") == "web_search_call" and on_event:
                action = item.get("action") or {}
                on_event({"kind": "search", "query": action.get("query") or ""})
        elif evt_type == "response.function_call_arguments.done":
            final_args = evt.get("arguments")
        elif evt_type == "response.failed":
            err = ((evt.get("response") or {}).get("error") or {})
            raise SearchError(f"gateway session failed: {str(err.get('message') or err)[:150]}")
        elif evt_type in ("response.completed", "response.incomplete"):
            break
    if final_args:
        try:
            args = json.loads(final_args)
        except ValueError as e:
            raise SearchError("search produced no structured results") from e
        rows = args.get(list_key) if isinstance(args, dict) else None
        return sanitize(rows)
    raise SearchError("search produced no structured results")


# Gateway concurrency is capped at 2 simultaneous sessions per key (3+
# return 429), so parallel research runs a 2-worker pool over shards.
MAX_WORKERS = 2


def start_parallel_research(shards, dedupe_key=None):
    """Run shard research sessions concurrently (max 2 workers) and report
    through a queue. Each shard: {name, instructions, task, record_tool,
    list_key, sanitize}. The queue yields progress dicts tagged with the
    shard name, then {"type": "result", "rows": [...]} (merged, deduped by
    dedupe_key(row)), then a None sentinel. A single shard failing returns
    the other's rows; every shard failing yields {"type": "error", ...}.
    The returned queue reader must drain until the sentinel."""
    ev_q = queue.Queue()
    results = [None] * len(shards)
    errors = [None] * len(shards)
    workers = queue.Queue()
    for i, shard in enumerate(shards):
        workers.put((i, shard))

    def shard_worker():
        while True:
            try:
                i, shard = workers.get_nowait()
            except queue.Empty:
                return
            tag = shard.get("name") or f"shard-{i + 1}"

            def shard_event(ev, _tag=tag):
                ev = dict(ev)
                ev["shard"] = _tag
                ev_q.put(ev)

            try:
                results[i] = run_research_streaming(
                    shard["instructions"], shard["task"], shard["record_tool"],
                    shard["list_key"], shard["sanitize"], shard_event)
            except SearchError as e:
                errors[i] = str(e)
                ev_q.put({"type": "progress", "shard": tag, "note": f"{tag} failed: {e}"})
            except Exception as e:  # defensive: a rogue shard must not hang the run
                errors[i] = str(e)[:200]
                ev_q.put({"type": "progress", "shard": tag, "note": f"{tag} failed"})

    def finalizer():
        pool = [threading.Thread(target=shard_worker, daemon=True)
                for _ in range(max(1, min(MAX_WORKERS, len(shards))))]
        for t in pool:
            t.start()
        for t in pool:
            t.join()
        # Shards may return lists (rows, deduped by key) or dicts (merged).
        if all(r is None or isinstance(r, dict) for r in results):
            merged = {}
            for rows in results:
                if isinstance(rows, dict):
                    merged.update(rows)
        else:
            merged, seen = [], set()
            for rows in results:
                for row in rows or []:
                    try:
                        k = dedupe_key(row) if dedupe_key else json.dumps(row, sort_keys=True)
                    except Exception:
                        k = json.dumps(row, sort_keys=True)
                    if k not in seen:
                        seen.add(k)
                        merged.append(row)
        if not merged and errors and all(e is not None for e in errors):
            ev_q.put({"type": "error", "error": errors[0] or "research failed"})
        else:
            if any(e is not None for e in errors):
                ev_q.put({"type": "progress",
                          "note": "partial results — one source was unavailable"})
            ev_q.put({"type": "result", "rows": merged})
        ev_q.put(None)

    threading.Thread(target=finalizer, daemon=True).start()
    return ev_q


def collect_parallel_research(shards, dedupe_key=None):
    """Blocking convenience: run start_parallel_research, drain the queue,
    return the merged rows (or raise SearchError)."""
    ev_q = start_parallel_research(shards, dedupe_key)
    rows, err = None, None
    while True:
        ev = ev_q.get(timeout=TIMEOUT + 30)
        if ev is None:
            break
        if ev.get("type") == "result":
            rows = ev["rows"]
        elif ev.get("type") == "error":
            err = ev.get("error")
    if rows is None:
        raise SearchError(err or "search produced no structured results")
    return rows
