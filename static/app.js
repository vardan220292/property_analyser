/* Copyright (c) 2026 RV
 *
 * Property Analyser — frontend wiring.
 *
 * Plain JS, no framework. All calculation happens in engine.js via
 * calculateAll(); this file only moves values between the DOM and the
 * engine and renders results (cards, tables, Chart.js charts).
 *
 * Draft state persists to localStorage on every edit; explicit Save
 * writes the scenario to the server (SQLite).
 */

(function () {
  'use strict';

  const E = window.PropertyAnalyserEngine;

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  const TOKEN_KEY = 'pa_token';
  const LEGACY_DRAFT_KEY = 'pa_draft_v1'; // pre-login drafts

  const state = {
    inputs: null,        // engine-normalized v3 shape: globals + properties[]
    scenarioId: null,    // null = unsaved draft
    result: null,        // calculateAll() output
    ownedResult: null,   // calculateAll() over purchased-only properties; null when none purchased
    cfYear: 1,           // year selected in the Cash Flow section
    inputTab: 0,         // active Inputs tab: 'portfolio' | 'ppor' | IP index
    viewProp: -1,        // result views: -1 = portfolio, else property index
    compareIds: [],      // scenario ids ticked for comparison
    compareData: [],     // [{name, result}] for the compare view
    currentUser: null,   // {id, email, displayName} once signed in
    suburbs: [],         // reference data rows from /api/suburbs
    bankRates: [],       // investor rate rows from /api/bank-rates
    comps: [],           // comparable sales for the current scenario
    compCandidates: [],  // AI search results pending review (never persisted)
    rentalCandidates: [],  // AI rental-evidence results pending review (never persisted)
    aiRateCandidates: [],  // AI-suggested bank rates pending review (never persisted)
    listingCheck: null,  // transient AI listing-check result for this session
    areaSignals: null,  // transient AI infrastructure signals for this session
  };

  // Drafts are per user so two people on one browser don't clobber
  // each other's in-progress edits.
  const draftKey = () =>
    state.currentUser ? `pa_draft_v1_u${state.currentUser.id}` : LEGACY_DRAFT_KEY;

  const getToken = () => localStorage.getItem(TOKEN_KEY);
  function setToken(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function saveDraft() {
    localStorage.setItem(draftKey(), JSON.stringify({
      v: 3,
      savedAt: Date.now(),
      scenarioId: state.scenarioId,
      inputs: state.inputs,
    }));
  }

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const fmtMoney = (v, dp = 0) => new Intl.NumberFormat('en-AU', {
    style: 'currency', currency: 'AUD', maximumFractionDigits: dp, minimumFractionDigits: dp,
  }).format(v);
  const fmtNum = (v, dp = 0) => new Intl.NumberFormat('en-AU', {
    maximumFractionDigits: dp, minimumFractionDigits: dp,
  }).format(v);
  const fmtPct = (v, dp = 2) => (v * 100).toFixed(dp) + '%';
  const signed = (v) => (v < 0 ? '−' : '') + fmtMoney(Math.abs(v));

  // ------------------------------------------------------------------
  // Form <-> state binding
  // ------------------------------------------------------------------

  // Per-property fields live on the ACTIVE Inputs tab; globals apply to
  // the whole portfolio regardless of tab.
  function scopeGet(key) {
    if (E.PROPERTY_KEYS.has(key) && Number.isInteger(state.inputTab)) {
      return state.inputs.properties[state.inputTab][key];
    }
    return state.inputs[key];
  }

  function scopeSet(key, v) {
    if (E.PROPERTY_KEYS.has(key) && Number.isInteger(state.inputTab)) {
      state.inputs.properties[state.inputTab][key] = v;
    } else {
      state.inputs[key] = v;
    }
  }

  function readField(el) {
    const key = el.dataset.field;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.tagName === 'SELECT') v = el.value;
    else if (el.dataset.pct !== undefined) v = (parseFloat(el.value) || 0) / 100;
    else if (el.type === 'text') {
      // A masked number is a text box underneath — it still has to read
      // back as a number.
      v = el.hasAttribute('data-numeric') ? (parseFloat(el.value) || 0) : el.value.trim();
    } else v = parseFloat(el.value) || 0;
    scopeSet(key, v);
  }

  function writeField(el) {
    const key = el.dataset.field;
    const v = scopeGet(key);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.dataset.pct !== undefined) el.value = (v * 100).toFixed(2).replace(/\.?0+$/, '');
    else el.value = v === null || v === undefined ? '' : v;
  }

  let recalcTimer = null;
  function scheduleRecalc() {
    clearTimeout(recalcTimer);
    recalcTimer = setTimeout(() => {
      recalc();
      saveDraft();
    }, 150);
  }

  // "P&I from day one" makes the interest-only period input irrelevant.
  function syncIoField() {
    const repaySel = $('[data-field="ipRepaymentType"]');
    const ioField = $('[data-field="ipInterestOnlyYears"]');
    if (repaySel && ioField) ioField.disabled = repaySel.value === 'principal_and_interest';
  }

  function bindInputs() {
    $$('[data-field]').forEach((el) => {
      el.addEventListener('input', () => {
        readField(el);
        scheduleRecalc();
        // A property's name shows on the tab strip at the top of the pane
        // and in the pane title — keep both in step with the field.
        if (el.dataset.field === 'label') refreshIpLabels();
      });
    });
    const repaySel = $('[data-field="ipRepaymentType"]');
    if (repaySel) repaySel.addEventListener('change', syncIoField);
  }

  // Taxable-income inputs are masked by default; the eye button toggles.
  // The mask is CSS, not type="password": a password field on the page
  // makes Chrome treat the nearest text box (the address field) as a
  // username and offer to save the address as a password.
  function bindMaskToggles() {
    $$('.masked-wrap').forEach((wrap) => {
      const input = wrap.querySelector('input');
      const btn = wrap.querySelector('.mask-toggle');
      if (!input || !btn) return;
      const mask = () => {
        input.type = 'text';
        input.classList.add('is-masked');
      };
      const reveal = () => {
        input.type = 'number';
        input.classList.remove('is-masked');
      };
      mask();
      btn.addEventListener('click', () => {
        const val = input.value;
        const on = input.classList.contains('is-masked');
        if (on) reveal();
        else mask();
        input.value = val; // changing the type can drop the value
        wrap.classList.toggle('revealed', on);
      });
    });
  }

  function syncForm() {
    $$('[data-field]').forEach(writeField);
    const sel = $('#suburb-select');
    if (sel) sel.value = String(Number(state.inputs.suburbId) || 0);
    syncIoField();
  }

  // ------------------------------------------------------------------
  // Address autocomplete + location (Domain / Esri / Photon, proxied by
  // the backend). Two pickers: the investment property and the PPOR.
  // ------------------------------------------------------------------

  let suggestTimer = null;
  let suggestSeq = 0;
  let locateSeq = 0;

  function matchSuburb(name, postcode) {
    const n = String(name || '').trim().toLowerCase();
    const p = String(postcode || '').trim();
    return state.suburbs.find((s) =>
      s.name.trim().toLowerCase() === n && String(s.postcode).trim() === p) || null;
  }

  function hideSuggest(dd) {
    if (!dd) return;
    dd.classList.add('hidden');
    dd.innerHTML = '';
  }

  function showSuggest(dd, html) {
    if (!dd) return;
    dd.innerHTML = html;
    dd.classList.remove('hidden');
  }

  function renderSuggest(dd, items) {
    if (!items.length) {
      showSuggest(dd, '<div class="addr-hint">No address matches — check the spelling, or type the street and number and we will locate it for you.</div>');
      return;
    }
    showSuggest(dd, items.map((it, i) =>
      `<div class="addr-item" data-addr-pick="${i}">
         <div>${escapeHtml(it.address)}</div>
         <div class="sub">${escapeHtml(it.suburb)} ${escapeHtml(it.postcode)} ${escapeHtml(it.state)}${it.provider === 'photon' ? ' · approx.' : ''}</div>
       </div>`).join(''));
  }

  function metaFrom(item) {
    return {
      domainId: item.domainId, unitNumber: item.unitNumber,
      streetNumber: item.streetNumber, streetName: item.streetName,
      streetType: item.streetType, suburb: item.suburb,
      postcode: item.postcode, state: item.state,
      lat: item.lat, lon: item.lon,
    };
  }

  // One picker per address field: dropdown, debounce, pick and locate.
  function wireAddressPicker(opts) {
    const input = $(opts.inputSel);
    const dd = $(opts.dropdownSel);
    if (!input || !dd) return;
    const picker = { input, dd, items: [], onPick: opts.onPick, scope: opts.scope || 'property' };

    input.addEventListener('input', () => {
      clearTimeout(suggestTimer);
      hideSuggest(dd);
      if (opts.onPick.manual) opts.onPick.manual(); // stale meta after manual edits
      const q = input.value.trim();
      if (q.length < 3) return;
      suggestTimer = setTimeout(() => fetchSuggest(picker, q), 300);
    });
    input.addEventListener('focusout', () => setTimeout(() => hideSuggest(dd), 120));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') hideSuggest(dd);
    });
    input.addEventListener('blur', () => settleAddress(picker));
    dd.addEventListener('mousedown', (ev) => {
      const row = ev.target.closest('[data-addr-pick]');
      if (!row) return;
      ev.preventDefault(); // keep focus so the focusout hide can't race the pick
      const item = picker.items[Number(row.dataset.addrPick)];
      if (item) opts.onPick.chosen(item);
    });
  }

  // Evidence capture (comps / rentals) keeps free-text rows, so the picker
  // only fills the input — no geocode settle, no scenario state to touch.
  function wireEvidenceAddress(inputSel, ddSel) {
    const input = $(inputSel);
    const dd = $(ddSel);
    if (!input || !dd) return;
    const picker = { input, dd, items: [], scope: 'property' };
    dd.addEventListener('mousedown', (ev) => {
      const row = ev.target.closest('[data-addr-pick]');
      if (!row) return;
      ev.preventDefault();
      const item = picker.items[Number(row.dataset.addrPick)];
      if (item) { input.value = item.address; hideSuggest(dd); }
    });
    input.addEventListener('input', () => {
      clearTimeout(suggestTimer);
      hideSuggest(dd);
      const q = input.value.trim();
      if (q.length < 3) return;
      suggestTimer = setTimeout(() => fetchSuggest(picker, q), 300);
    });
    input.addEventListener('focusout', () => setTimeout(() => hideSuggest(dd), 120));
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hideSuggest(dd); });
  }

  // Hints that keep the geocoder in the right place.
  //
  // The map bias must never leak between addresses: biasing one lookup with
  // another address's coordinates dragged "8 atkinson close" to Atkinson
  // Street in Mackay. Each field only ever biases on its OWN coordinates,
  // and only when the text still looks like the address they came from.
  //
  // The scenario state and suburb belong to the investment property, so the
  // PPOR never inherits them — it is a different property, quite possibly in
  // a different state. It only uses hints from its own saved match.
  function sameStreetAs(meta, q) {
    const words = String(q || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const known = [meta.streetName, meta.streetFull, meta.suburb]
      .filter(Boolean).join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!known.length || !words.length) return false;
    return words.some((w) => w.length > 3 && known.includes(w));
  }

  function biasParams(meta, q) {
    const lat = numOrNull(meta.lat);
    const lon = numOrNull(meta.lon);
    if (lat === null || lon === null) return '';
    if (!sameStreetAs(meta, q)) return '';
    return '&lat=' + lat + '&lon=' + lon;
  }

  function addressHints(scope, q) {
    const parts = [];
    if (scope === 'ppor') {
      const meta = state.inputs.pporAddressMeta || {};
      if (meta.suburb) parts.push('&suburb=' + encodeURIComponent(meta.suburb));
      parts.push(biasParams(meta, q));
      return parts.join('');
    }
    const st = (state.inputs && state.inputs.state) || '';
    if (st) parts.push('&state=' + encodeURIComponent(st));
    const meta = scopeGet('addressMeta') || {};
    const sub = meta.suburb || (currentSuburb() || {}).name;
    if (sub) parts.push('&suburb=' + encodeURIComponent(sub));
    parts.push(biasParams(meta, q));
    return parts.join('');
  }

  // Normalise for "is this the same address" checks (spacing/punctuation).
  const normAddr = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // Auto-pick the top suggestion as soon as it strongly matches what is
  // typed — no click needed. A weak match leaves the dropdown for the user
  // to choose from, and picking the same address twice is a no-op.
  function autoPick(picker, q) {
    const nq = normAddr(q);
    if (!picker.items.length || nq.length < 8) return;
    const top = picker.items[0];
    const na = normAddr(top.address);
    if (!na.startsWith(nq) && !na.includes(nq)) return;
    if (picker.lastAuto === top.address) return;
    picker.lastAuto = top.address;
    if (picker.onPick) {
      picker.onPick.chosen(top, true);
      hideSuggest(picker.dd);
    } else {
      picker.input.value = top.address;
      hideSuggest(picker.dd);
    }
  }

  async function fetchSuggest(picker, q) {
    const seq = ++suggestSeq;
    try {
      const items = await api('/api/address/suggest?q=' + encodeURIComponent(q) + addressHints(picker.scope, q));
      if (seq !== suggestSeq) return; // a newer keystroke already won
      picker.items = items || [];
      renderSuggest(picker.dd, picker.items);
      autoPick(picker, q);
    } catch (err) {
      if (seq !== suggestSeq) return;
      showSuggest(picker.dd, '<div class="addr-hint">' + escapeHtml(err.message) + '</div>');
    }
  }

  // A typed address still deserves map coordinates — resolve it on blur.
  async function settleAddress(picker) {
    const q = picker.input.value.trim();
    if (q.length < 6) return;
    const seq = ++locateSeq;
    try {
      const item = await api('/api/address/locate?q=' + encodeURIComponent(q) + addressHints(picker.scope, q));
      if (seq !== locateSeq) return;
      if (!item) return;
      picker.onPick.located(item);
    } catch (err) {
      /* a partial address is not worth complaining about */
    }
  }

  function setMatched(sel, item) {
    const el = $(sel);
    if (!el) return;
    el.textContent = item ? 'Matched: ' + item.address : '';
    el.classList.toggle('hidden', !item);
  }

  // A suggestion can be street-level when the typed address had no suburb.
  // Once one is picked the label carries the suburb, so the house point can
  // be looked up properly.
  async function refineAddress(scope, text, apply) {
    if (!text || text.length < 6) return;
    try {
      const item = await api('/api/address/locate?q=' + encodeURIComponent(text)
        + addressHints(scope, text));
      if (item && item.streetNumber) apply(item);
    } catch (err) { /* keep what we have */ }
  }

  // Saved coordinates go stale: they were picked from a weaker geocoder,
  // or only ever had the street, not the house. The address text is the
  // source of truth, so re-locate anything that isn't house-accurate.
  async function refreshPropertyLocations() {
    const props = (state.inputs && state.inputs.properties) || [];
    let changed = false;
    for (const p of props) {
      const addr = String(p.address || '').trim();
      if (!addr) continue;
      const meta = p.addressMeta || {};
      const lat = numOrNull(meta.lat);
      const lon = numOrNull(meta.lon);
      if (lat !== null && lon !== null && meta.streetNumber) continue;
      try {
        const item = await api('/api/address/locate?q=' + encodeURIComponent(addr) + addressHints('property', addr));
        if (!item) continue;
        p.addressMeta = metaFrom(item);
        changed = true;
      } catch (err) { /* keep whatever we had */ }
    }
    const pporAddr = String((state.inputs && state.inputs.pporAddress) || '').trim();
    if (pporAddr) {
      const meta = state.inputs.pporAddressMeta || {};
      if (!(numOrNull(meta.lat) !== null && meta.streetNumber)) {
        try {
          const item = await api('/api/address/locate?q=' + encodeURIComponent(pporAddr) + addressHints('ppor', pporAddr));
          if (item) {
            state.inputs.pporAddressMeta = metaFrom(item);
            changed = true;
          }
        } catch (err) { /* keep whatever we had */ }
      }
    }
    if (changed) {
      scheduleRecalc();
      if (propertySectionVisible()) renderProperty();
    }
  }

  function pickPropertyAddress(item, auto) {
    $('#address-input').value = item.address; // programmatic — fires no input event
    scopeSet('address', item.address);
    scopeSet('addressMeta', metaFrom(item));
    setMatched('#address-matched', item);
    refreshAiResearchRow();
    const m = matchSuburb(item.suburb, item.postcode);
    if (m) {
      state.inputs.suburbId = m.id; // suburb stays portfolio-level (drives the area report)
      $('#suburb-select').value = String(m.id);
      if (!auto) toast(`Suburb set to ${m.name} — applies to the whole portfolio`);
    } else if (item.suburb) {
      toast(`${item.suburb} ${item.postcode} is not in your suburb data — add it under Area Report`);
    }
    scheduleRecalc(); // re-renders the Area Report and saves the draft
    if (propertySectionVisible()) renderProperty();
    if (!item.streetNumber) {
      refineAddress('property', $('#address-input').value, (refined) => {
        scopeSet('addressMeta', metaFrom(refined));
        setMatched('#address-matched', refined);
        scheduleRecalc();
        if (propertySectionVisible()) renderProperty();
      });
    }
  }

  function pickPporAddress(item) {
    $('#ppor-address-input').value = item.address;
    scopeSet('pporAddress', item.address);
    scopeSet('pporAddressMeta', metaFrom(item));
    setMatched('#ppor-address-matched', item);
    scheduleRecalc();
    if (!item.streetNumber) {
      refineAddress('ppor', $('#ppor-address-input').value, (refined) => {
        scopeSet('pporAddressMeta', metaFrom(refined));
        setMatched('#ppor-address-matched', refined);
        scheduleRecalc();
      });
    }
  }

  wireAddressPicker({
    inputSel: '#address-input',
    dropdownSel: '#addr-dropdown',
    onPick: {
      manual: () => {
        scopeSet('addressMeta', null); // stale after manual edits; re-set on pick
        setMatched('#address-matched', null);
      },
      chosen: (item) => {
        hideSuggest($('#addr-dropdown'));
        pickPropertyAddress(item);
      },
      located: (item) => {
        scopeSet('addressMeta', metaFrom(item));
        setMatched('#address-matched', item);
        scheduleRecalc(); // the resolved point has to be saved
        refreshAiResearchRow();
        if (propertySectionVisible()) renderProperty();
      },
    },
  });

  wireAddressPicker({
    inputSel: '#ppor-address-input',
    dropdownSel: '#ppor-addr-dropdown',
    scope: 'ppor',
    onPick: {
      manual: () => {
        scopeSet('pporAddressMeta', null);
        setMatched('#ppor-address-matched', null);
      },
      chosen: (item) => {
        hideSuggest($('#ppor-addr-dropdown'));
        pickPporAddress(item);
      },
      located: (item) => {
        scopeSet('pporAddressMeta', metaFrom(item));
        setMatched('#ppor-address-matched', item);
        scheduleRecalc(); // the resolved point has to be saved
      },
    },
  });

  wireEvidenceAddress('#comp-address', '#comp-addr-dropdown');
  wireEvidenceAddress('#rental-address', '#rental-addr-dropdown');

  // ------------------------------------------------------------------
  // Navigation
  // ------------------------------------------------------------------

  const TITLES = {
    overview: 'Dashboard', portfolio: 'Portfolio', inputs: 'Inputs', property: 'Property', area: 'Area',
    dealcheck: 'Deal Check', heatmaps: 'Heat maps',
    cashflow: 'Cash Flow',
    projections: 'Projections', exit: 'Exit', borrowing: 'Borrowing',
    actuals: 'Actuals', scenarios: 'Scenarios', workspace: 'Workspace',
    markets: 'Markets', tools: 'Tools', location: 'Location IQ',
  };

  // Responsive collapsible application navigation.
  function setupAppShell() {
    const navbar = $('.navbar'), nav = $('#nav');
    if (!navbar || !nav || $('#app-sidebar')) return;
    const sidebar = document.createElement('aside');
    sidebar.id = 'app-sidebar';
    sidebar.className = 'app-sidebar';
    sidebar.setAttribute('aria-label', 'Application navigation');
    sidebar.innerHTML = '<div class="sidebar-heading"><span class="sidebar-heading-label">WORKSPACE</span><span class="sidebar-heading-rule"></span></div><div class="sidebar-nav"></div><div class="sidebar-footer"><span class="sidebar-footer-mark">PA</span><span class="sidebar-footer-copy"><strong>Property Analyser</strong><small>Investment workspace</small></span></div>';
    sidebar.querySelector('.sidebar-nav').appendChild(nav);
    navbar.insertAdjacentElement('afterend', sidebar);
    const backdrop = document.createElement('button');
    backdrop.type = 'button'; backdrop.id = 'sidebar-backdrop'; backdrop.className = 'sidebar-backdrop';
    backdrop.setAttribute('aria-label', 'Close navigation');
    sidebar.insertAdjacentElement('afterend', backdrop);
    const toggle = $('#sidebar-toggle'), prefKey = 'pa_sidebar_collapsed';
    const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
    let collapsed = false;
    try { collapsed = localStorage.getItem(prefKey) === '1'; } catch (e) {}
    const apply = () => {
      document.body.classList.toggle('sidebar-collapsed', collapsed && !isMobile());
      document.body.classList.toggle('sidebar-open', isMobile() && !collapsed);
      if (toggle) {
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
        toggle.title = collapsed ? 'Expand navigation' : 'Collapse navigation';
      }
    };
    const closeMobile = () => {
      if (!isMobile()) return;
      collapsed = true; document.body.classList.remove('sidebar-open'); apply();
    };
    if (toggle) toggle.addEventListener('click', () => {
      collapsed = !collapsed;
      try { localStorage.setItem(prefKey, collapsed ? '1' : '0'); } catch (e) {}
      apply();
    });
    backdrop.addEventListener('click', closeMobile);
    nav.addEventListener('click', ev => { if (ev.target.closest('a[data-target]')) closeMobile(); });
    window.addEventListener('resize', apply);
    if (isMobile()) collapsed = true;
    apply();
  }

  $('#nav').addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-target]');
    if (!a) return;
    Array.from(document.querySelectorAll('#nav a')).forEach((x) => x.classList.toggle('active', x === a));
    const navGroup = a.closest('details.nav-group');
    if (navGroup) navGroup.open = false;
    $$('.section-page').forEach((s) =>
      s.classList.toggle('active', s.id === 'section-' + a.dataset.target));
    document.body.classList.toggle('on-dashboard', a.dataset.target === 'overview');
    $('#page-title').textContent = TITLES[a.dataset.target];
    if (a.dataset.target === 'workspace') refreshWorkspace();
    if (a.dataset.target === 'actuals') renderActuals();
    if (a.dataset.target === 'property') renderProperty();
    if (a.dataset.target === 'overview') loadDashboard();
    if (a.dataset.target === 'portfolio') loadPortfolio();
    if (a.dataset.target === 'markets') { loadMarkets(); loadMkPrices(); }
    if (a.dataset.target === 'location') initLocationIQ();
    if (a.dataset.target === 'heatmaps') initHeatMapsPage();
    if (a.dataset.target === 'dealcheck') initDealCheckPage();
    if (a.dataset.target === 'area') renderSuburbCompare();
    window.scrollTo(0, 0);
  });

  // Programmatic section switch — same path a real nav click takes, so all
  // per-section side effects (refreshWorkspace, loadDashboard…) still run.
  function goSection(target) {
    const a = document.querySelector('#nav a[data-target="' + target + '"]');
    if (a) a.click();
  }

  // Post-login landing: BAs work out of the Client workspace; everyone else
  // starts on the dashboard (clients never reach here — they redirect to
  // /portal). goSection takes the real nav-click path, which also refreshes
  // that section's data.
  function landAfterLogin() {
    goSection(state.currentUser && state.currentUser.role === 'ba' ? 'workspace' : 'overview');
    startTour();
  }

  // ------------------------------------------------------------------
  // My Portfolio — aggregate every purchased scenario
  // ------------------------------------------------------------------

  let pfoCache = null;
  const PFO_STATUSES = [['considering', 'Considering'], ['under_offer', 'Under offer'], ['purchased', 'Purchased']];

  async function loadPortfolio(force) {
    if (!state.currentUser) return;
    try {
      if (force || !pfoCache) pfoCache = await api('/api/scenarios/portfolio');
      renderPortfolio(pfoCache);
    } catch (err) { toast('Portfolio: ' + err.message); }
  }

  function renderPortfolio(items) {
    const whatIf = localStorage.getItem('pa_pfo_whatif') === '1';
    const tgl = $('#pfo-whatif');
    if (tgl && tgl.checked !== whatIf) tgl.checked = whatIf;
    const statusLabel = Object.fromEntries(PFO_STATUSES);
    const owned = whatIf ? items.slice() : items.filter((i) => i.ownershipStatus === 'purchased');
    const nPurchased = owned.filter((i) => i.ownershipStatus === 'purchased').length;
    const nProspective = owned.length - nPurchased;
    const calcs = owned.map((item) => ({ item, r: E.calculateAll(item.inputs) }));
    const totalValue = calcs.reduce((s, c) => s + (c.r.metrics.purchasePrice || 0), 0);
    const totalDebt = calcs.reduce((s, c) => s + (c.r.metrics.ipLoanAmount || 0), 0);
    const netWorth = totalValue - totalDebt;
    const usableEquity = Math.max(0, totalValue * 0.8 - totalDebt);
    const outright = calcs.filter((c) => (c.r.metrics.ipLoanAmount || 0) <= 1000).length;
    const weekly = calcs.reduce((s, c) => s + ((c.r.rows[0] || {}).afterTaxCashFlow || 0), 0) / 52;
    const splitNote = nPurchased + ' purchased' + (nProspective ? ' + ' + nProspective + ' prospective' : '');

    const cards = [
      ['Total property value', totalValue ? fmtMoney(totalValue) : '—', splitNote + ' propert' + (owned.length === 1 ? 'y' : 'ies'), 'blue'],
      ['Total debt', calcs.length ? fmtMoney(totalDebt) : '—', whatIf ? 'Across all included loans' : 'Across all loans', 'violet'],
      ['Net worth', calcs.length ? fmtMoney(netWorth) : '—', 'Value less debt' + (whatIf ? ' (what-if)' : ''), 'green'],
      ['Usable equity', calcs.length ? fmtMoney(usableEquity) : '—', '80% of value less debt', 'amber'],
      ['Owned outright', calcs.length ? Math.round(outright / calcs.length * 100) + '%' : '—', outright + ' of ' + calcs.length + ' debt-free', 'teal'],
      ['Weekly position', calcs.length ? fmtMoney(Math.abs(weekly)) + (weekly > 0 ? ' out' : ' surplus') : '—', 'After tax, year 1 combined' + (whatIf ? ' (what-if)' : ''), weekly > 0 ? 'bad' : 'good'],
    ];
    $('#pfo-stats').innerHTML = cards.map((x) =>
      '<div class="portfolio-kpi ' + x[3] + '"><div class="portfolio-kpi-label">' + escapeHtml(x[0]) + '</div>' +
      '<div class="portfolio-kpi-value">' + escapeHtml(x[1]) + '</div>' +
      '<div class="portfolio-kpi-note">' + escapeHtml(x[2]) + '</div></div>').join('');

    // Net worth chart: year 0 = today, then summed projections.
    const years = Math.max(1, ...calcs.map((c) => (c.r.rows || []).length), 15);
    const labels = ['Now', ...Array.from({ length: Math.min(15, years) }, (_, i) => 'Y' + (i + 1))];
    const at = (c, y) => y === 0
      ? { v: c.r.metrics.purchasePrice || 0, d: c.r.metrics.ipLoanAmount || 0 }
      : (c.r.rows[y - 1] || {});
    const valueData = labels.map((_, y) => calcs.reduce((s, c) => s + (at(c, y).v || 0), 0));
    const debtData = labels.map((_, y) => calcs.reduce((s, c) => s + (at(c, y).d || 0), 0));
    drawChart('pfo-chart', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Property value', data: valueData, borderColor: COLORS.pri, backgroundColor: COLORS.pri, tension: 0.15, pointRadius: 0 },
          { label: 'Total debt', data: debtData, borderColor: COLORS.red, backgroundColor: COLORS.red, tension: 0.15, pointRadius: 0 },
          { label: 'Net worth', data: valueData.map((v, i) => v - debtData[i]), borderColor: COLORS.green, backgroundColor: COLORS.green, tension: 0.15, pointRadius: 0 },
        ],
      },
      options: baseOpts((v) => (v < 0 ? '−' : '') + fmtMoney(Math.abs(v), 0)),
    });

    // Own & owe table
    const chartHint = $('#pfo-chart-hint');
    if (chartHint) chartHint.textContent = whatIf
      ? "Today's position, then every included property projected together (what-if on)."
      : "Today's position, then every purchased property projected together.";
    const tableHint = $('#pfo-table-hint');
    if (tableHint) tableHint.textContent = whatIf
      ? 'Year-one figures for each included property — badges mark the prospective ones.'
      : "Year-one figures for each purchased property, from its saved scenario.";
    $('#pfo-table').innerHTML = `
      <thead><tr><th>Property</th><th>Price</th><th>Loan</th><th>Equity</th>
      <th>Yr-1 cash flow</th><th>Gross yield</th></tr></thead><tbody>
      ${calcs.map((c) => {
        const p = (c.item.inputs.properties || [{}])[0];
        const m = c.r.metrics;
        const chip = whatIf
          ? ` <span class="status-chip ${escapeHtml(c.item.ownershipStatus || 'considering')}">${escapeHtml(statusLabel[c.item.ownershipStatus] || 'Considering')}</span>` : '';
        return `<tr>
          <td>${escapeHtml(c.item.name)}${chip}</td>
          <td>${fmtMoney(p.purchasePrice || 0)}</td>
          <td>${fmtMoney(m.ipLoanAmount || 0)}</td>
          <td>${fmtMoney((p.purchasePrice || 0) - (m.ipLoanAmount || 0))}</td>
          <td class="${(m.weeklyOutOfPocket || 0) > 0 ? 'neg' : 'pos'}">${fmtMoney(-m.weeklyOutOfPocket)}/yr</td>
          <td>${fmtPct(m.grossYield || 0)}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="6">Mark properties as Purchased (in Inputs) to build your portfolio totals.</td></tr>'}
      </tbody>`;

    // Pipeline board
    const by = { considering: [], under_offer: [], purchased: [] };
    items.forEach((i) => { (by[i.ownershipStatus] || by.considering).push(i); });
    $('#pfo-pipeline').innerHTML = PFO_STATUSES.map(([key, label]) => `
      <div class="pfo-col">
        <div class="pfo-col-head">${escapeHtml(label)} <span>${by[key].length}</span></div>
        ${by[key].map((i) => `
          <div class="pfo-card">
            <div class="pfo-card-name">${escapeHtml(i.name)}</div>
            <div class="pfo-card-sub">${escapeHtml(i.address || '')}</div>
            <div class="pfo-card-actions">
              ${key !== 'considering' ? `<button data-pfo-move="${i.id}" data-pfo-to="considering">← Considering</button>` : ''}
              ${key !== 'under_offer' ? `<button data-pfo-move="${i.id}" data-pfo-to="under_offer">Under offer</button>` : ''}
              ${key !== 'purchased' ? `<button data-pfo-move="${i.id}" data-pfo-to="purchased" class="pos">Purchased →</button>` : ''}
            </div>
          </div>`).join('') || '<div class="source-note">Nothing here yet.</div>'}
      </div>`).join('');
  }

  $('#pfo-pipeline').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-pfo-move]');
    if (!btn) return;
    try {
      await api(`/api/scenarios/${btn.dataset.pfoMove}/status`, {
        method: 'PATCH', body: { status: btn.dataset.pfoTo },
      });
      await loadPortfolio(true);
      toast('Moved to ' + btn.dataset.pfoTo.replace('_', ' '));
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#pfo-whatif').addEventListener('change', (ev) => {
    localStorage.setItem('pa_pfo_whatif', ev.target.checked ? '1' : '0');
    if (pfoCache) renderPortfolio(pfoCache);
  });

  // ------------------------------------------------------------------
  // Markets — ABS macro stats
  // ------------------------------------------------------------------

  let mkCache = null;
  let mkMetric = 'populationGrowth';
  const MK_LABELS = { populationGrowth: 'Population Growth', unemployment: 'Unemployment',
    householdIncome: 'Household Income', businessGrowth: 'Business Growth a Year',
    renters: 'Renters', medianAge: 'Median Age', overseasMigration: 'Overseas Migration per 1,000' };

  async function loadMarkets() {
    try {
      if (!mkCache) mkCache = await api('/api/markets');
      renderMarkets(mkCache);
    } catch (err) { toast('Markets: ' + err.message); }
  }

  function renderMarkets(d) {
    const unit = (k) => (d.national[k] || {}).unit || '';
    $('#mk-cards').innerHTML = Object.keys(MK_LABELS)
      .filter((k) => d.national[k])
      .map((k) => {
        const n = d.national[k];
        const val = n.unit === '$/wk' ? fmtMoney(n.value) + '/wk' : n.value + n.unit;
        return '<div class="card"><div class="label">' + escapeHtml(MK_LABELS[k]) + '</div>' +
          '<div class="value">' + escapeHtml(val) + '</div>' +
          '<div class="card-sub">' + escapeHtml(n.label) +
          (n.live ? ' · <strong>' + (n.liveVia ? 'live via ' + escapeHtml(n.liveVia) : 'live ABS') + '</strong>'
                 : ' · bundled snapshot') + '</div></div>';
      }).join('') ||
      '<div class="empty-note">National market data is not loaded.</div>';

    const stateMetricKeys = Object.keys(d.states.WA || {}).filter((k) => typeof d.states.WA[k] === 'number');
    $('#mk-tabs').innerHTML = stateMetricKeys.map((k) =>
      `<button class="chip ${mkMetric === k ? 'active' : ''}" data-mk-metric="${k}">${escapeHtml(MK_LABELS[k] || k)}</button>`).join('');

    const ranked = Object.entries(d.states)
      .map(([code, s]) => ({ code, name: s.name, value: s[mkMetric],
                             cap: s.capitalVsRest && s.capitalVsRest.capital,
                             rest: s.capitalVsRest && s.capitalVsRest.rest }))
      .filter((s) => s.value != null)
      .sort((a, b) => b.value - a.value);
    const peak = ranked.length ? ranked[0].value : 1;
    $('#mk-states').innerHTML = '<h3 class="mk-h">' + escapeHtml(MK_LABELS[mkMetric] || mkMetric) + ', by state</h3>' +
      ranked.map((s) => `
        <div class="mk-row">
          <span class="mk-code">${escapeHtml(s.code)}</span>
          <div class="mk-bar"><div style="width:${(s.value / peak * 100).toFixed(0)}%"></div></div>
          <strong>${s.value.toFixed(2)}%</strong>
        </div>`).join('');

    const capRows = ranked.filter((s) => s.cap != null);
    $('#mk-capitals').innerHTML = capRows.length
      ? '<h3 class="mk-h">Capital city against the rest of the state</h3>' +
        capRows.map((s) => `
          <div class="mk-row"><span class="mk-code">${escapeHtml(s.code)}</span>
          <span class="mk-cap">${escapeHtml(d.capitals[s.code] || '')}</span>
          <strong>${s.cap.toFixed(2)}%</strong> <span class="mk-rest">vs rest ${s.rest.toFixed(2)}%</span></div>`).join('')
      : '';
  }

  $('#mk-tabs').addEventListener('click', (ev) => {
    const chip = ev.target.closest('button[data-mk-metric]');
    if (!chip) return;
    mkMetric = chip.dataset.mkMetric;
    if (mkCache) renderMarkets(mkCache);
  });

  // Median price history (ABS Total Value of Dwellings, Table 2)
  let mkPriceCache = null;

  async function loadMkPrices() {
    try {
      if (!mkPriceCache) mkPriceCache = await api('/api/markets/prices');
    } catch (err) {
      $('#mk-price-src').textContent = 'Price history unavailable: ' + err.message;
      return;
    }
    const d = mkPriceCache;
    const stateSel = $('#mk-price-state');
    const codes = Object.keys(d.states);
    if (stateSel && !stateSel.options.length) {
      stateSel.innerHTML = codes.map((c) =>
        `<option value="${c}">${escapeHtml((d.capitals[c] || c) + ' — ' + c)}</option>`).join('');
      const cur = (state.inputs && state.inputs.state) || '';
      if (cur && d.states[cur]) stateSel.value = cur;
    }
    renderMkPrices();
  }

  function renderMkPrices() {
    const d = mkPriceCache;
    if (!d || !$('#mk-price-state').value) return;
    const st = $('#mk-price-state').value;
    const kind = $('#mk-price-kind').value;
    const areas = d.states[st];
    if (!areas) return;
    const capital = d.capitals[st] || st;
    const labels = d.periods.map((p) => p.slice(0, 7));
    const toK = (vals) => vals.map((v) => (v == null ? null : Math.round(v / 1000)));
    const datasets = [];
    let yoy = null;
    if (areas.capital && areas.capital[kind]) {
      const vals = areas.capital[kind];
      const last = vals[vals.length - 1], yr = vals[vals.length - 5];
      if (last != null && yr) yoy = (last - yr) / yr * 100;
      datasets.push({ label: `${capital} (capital)`, data: toK(vals),
                      borderColor: '#2563eb', tension: 0.2, pointRadius: 0 });
    }
    if (areas.rest && areas.rest[kind]) {
      datasets.push({ label: `Rest of ${st}`, data: toK(areas.rest[kind]),
                      borderColor: '#94a3b8', borderDash: [5, 4], tension: 0.2, pointRadius: 0 });
    }
    drawChart('chart-mk-prices', {
      type: 'line',
      data: { labels, datasets },
      options: {
        maintainAspectRatio: false,
        scales: { y: { ticks: { callback: (v) => '$' + v + 'k' } } },
        plugins: { legend: { labels: { boxWidth: 12 } } },
      },
    });
    $('#mk-price-src').textContent = d.source
      + (yoy != null ? ` · ${capital} ${yoy >= 0 ? '+' : ''}${yoy.toFixed(1)}% over the last year` : '');
  }

  $('#mk-price-state').addEventListener('change', renderMkPrices);
  $('#mk-price-kind').addEventListener('change', renderMkPrices);

  // ------------------------------------------------------------------
  // Tools — stand-alone calculators
  // ------------------------------------------------------------------

  function bindTools() {
    const num = (id) => Number($(id).value || 0);
    const bind = (ids, fn) => ids.forEach((id) => $(id).addEventListener('input', fn));

    bind(['#t-yield-price', '#t-yield-rent'], () => {
      const price = num('#t-yield-price'), rent = num('#t-yield-rent');
      $('#t-yield-out').textContent = price && rent
        ? `Gross yield ${fmtPct(rent * 52 / price)} — ${fmtMoney(rent * 52)}/yr, ${fmtMoney(rent * 52 / price * 1000)} per $1,000 of price`
        : '';
    });
    bind(['#t-rep-loan', '#t-rep-rate', '#t-rep-term', '#t-rep-type'], () => {
      const loan = num('#t-rep-loan'), rate = num('#t-rep-rate') / 100, term = num('#t-rep-term') || 30;
      if (!loan) { $('#t-rep-out').textContent = ''; return; }
      if ($('#t-rep-type').value === 'interest_only') {
        $('#t-rep-out').textContent = `Interest-only: ${fmtMoney(loan * rate / 12)}/month (${fmtMoney(loan * rate)}/yr)`;
      } else {
        const monthly = E.loanPayment(loan, rate, term);
        $('#t-rep-out').textContent = `P&I: ${fmtMoney(monthly)}/month · total interest over ${term} years ${fmtMoney(monthly * term * 12 - loan)}`;
      }
    });
    bind(['#t-cash-state', '#t-cash-price', '#t-cash-lvr'], () => {
      const price = num('#t-cash-price');
      if (!price) { $('#t-cash-out').textContent = ''; return; }
      const f = E.fundingStructure({ state: $('#t-cash-state').value,
        purchasePrice: price, ipLvr: num('#t-cash-lvr') / 100 });
      $('#t-cash-out').textContent = `Duty ${fmtMoney(f.transferDuty)} · acquisition ${fmtMoney(f.acquisitionCosts)} · loan ${fmtMoney(f.ipLoanStart)} → cash needed ${fmtMoney(f.initialCashInvested)}`;
    });
    bind(['#t-eq-value', '#t-eq-loan'], () => {
      const value = num('#t-eq-value'), loan = num('#t-eq-loan');
      $('#t-eq-out').textContent = value
        ? `Usable equity (80% of ${fmtMoney(value)} less ${fmtMoney(loan)}): ${fmtMoney(Math.max(0, value * 0.8 - loan))}`
        : '';
    });
    bind(['#t-bor-income', '#t-bor-rate', '#t-bor-debts'], () => {
      const income = num('#t-bor-income');
      if (!income) { $('#t-bor-out').textContent = ''; return; }
      const b = E.borrowingCapacity({ owner1TaxableIncome: income,
        ipInterestRate: num('#t-bor-rate') / 100, otherDebtAnnualPayments: num('#t-bor-debts') });
      $('#t-bor-out').textContent = `Estimated borrowing power: ${fmtMoney(b.maxNewLoan)} (buffered rate, indicative only)`;
    });
  }
  bindTools();

  // ------------------------------------------------------------------
  // Suburb side-by-side comparison
  // ------------------------------------------------------------------

  const sbSelected = new Set();

  function renderSuburbCompare() {
    const picker = $('#sb-picker');
    const table = $('#sb-table');
    if (!picker || !table) return;
    const suburbs = (state.suburbs || []).slice(0, 8);
    picker.innerHTML = suburbs.length ? suburbs.map((s) => `
      <label class="chip ${sbSelected.has(s.id) ? 'active' : ''}" style="cursor:pointer">
        <input type="checkbox" data-sb="${s.id}" ${sbSelected.has(s.id) ? 'checked' : ''}
               style="margin-right:.3rem">${escapeHtml(s.name)} ${escapeHtml(s.postcode || '')}
      </label>`).join('')
      : '<span class="source-note">No saved suburbs yet — save one above to compare.</span>';
    const picked = suburbs.filter((s) => sbSelected.has(s.id));
    if (picked.length < 2) {
      table.innerHTML = '<tr><td>Tick at least two suburbs to compare.</td></tr>';
      return;
    }
    const metrics = [
      ['Median sale price', (s) => s.medianPrice != null ? fmtMoney(s.medianPrice) : '—'],
      ['Median rent (3 bed)', (s) => s.medianRent3Bed != null ? fmtMoney(s.medianRent3Bed) + '/wk' : '—'],
      ['Vacancy rate', (s) => s.vacancyPct != null ? s.vacancyPct.toFixed(1) + '%' : '—'],
      ['5-year growth', (s) => s.growth5yrPct != null ? s.growth5yrPct.toFixed(1) + '%' : '—'],
      ['Days on market', (s) => s.medianDaysOnMarket != null ? s.medianDaysOnMarket : '—'],
      ['Approvals ratio', (s) => s.approvalsRatio != null ? Number(s.approvalsRatio).toFixed(2) : '—'],
    ];
    table.innerHTML = `
      <thead><tr><th></th>${picked.map((s) => `<th>${escapeHtml(s.name)} ${escapeHtml(s.postcode || '')}</th>`).join('')}</tr></thead>
      <tbody>${metrics.map(([label, fn]) => `
        <tr><td>${escapeHtml(label)}</td>${picked.map((s) => `<td>${fn(s)}</td>`).join('')}</tr>`).join('')}
      </tbody>`;
  }

  $('#sb-picker').addEventListener('change', (ev) => {
    const cb = ev.target.closest('input[data-sb]');
    if (!cb) return;
    const id = Number(cb.dataset.sb);
    if (cb.checked) {
      if (sbSelected.size >= 3) { cb.checked = false; toast('Compare up to 3 suburbs'); return; }
      sbSelected.add(id);
    } else sbSelected.delete(id);
    renderSuburbCompare();
  });

  // ------------------------------------------------------------------
  // Data export — one JSON with all scenarios, actuals, comps, suburbs
  // ------------------------------------------------------------------

  $('#btn-export-data').addEventListener('click', async () => {
    try {
      const d = await api('/api/scenarios/export');
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'property-analyser-export.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Data exported');
    } catch (err) { toast('Error: ' + err.message); }
  });

  // ------------------------------------------------------------------
  // Location IQ — national map with government data layers
  // ------------------------------------------------------------------

  const VIC_WMS = 'https://opendata.maps.vic.gov.au/geoserver/wms';
  // Census heat maps — one free ABS FeatureServer (2021 Census, SA2 level)
  // powers every metric below. The licence is open; attribution shows on-page.
  const HEAT_SOURCE = {
    url: 'https://services1.arcgis.com/v8Kimc579yljmjSP/arcgis/rest/services/SA2_ABS_SEIFACS_2024_Apr/FeatureServer/0/query',
    ramp: ['#fff5d6', '#fdd49e', '#fc8d59', '#d7301f', '#7f0000'],
  };
  const HEAT_METRICS = [
    { key: 'tenure_4', label: 'Home rented %', group: 'Housing & tenure', unit: '%' },
    { key: 'tenure_owned', label: 'Owned outright %', group: 'Housing & tenure', unit: '%' },
    { key: 'tenure_3', label: 'Owned with mortgage %', group: 'Housing & tenure', unit: '%' },
    { key: 'publich_1_pc', label: 'Public housing %', group: 'Housing & tenure', unit: '%' },
    { key: 'afford_3', label: 'Mortgage stress %', group: 'Housing & tenure', unit: '%',
      note: 'Households paying >30% of income on the mortgage' },
    { key: 'afford_5', label: 'Rent stress %', group: 'Housing & tenure', unit: '%',
      note: 'Households paying >30% of income on rent' },
    { key: 'house_2_pc', label: 'Overcrowded homes %', group: 'Housing & tenure', unit: '%',
      note: 'Households needing extra bedrooms' },
    { key: 'house_3_pc', label: 'Spare bedrooms %', group: 'Housing & tenure', unit: '%' },
    { key: 'hied_1_pc', label: 'Low-income households %', group: 'People & income', unit: '%' },
    { key: 'lf_4', label: 'Unemployment rate', group: 'People & income', unit: '%' },
    { key: 'lf_5', label: 'Participation rate', group: 'People & income', unit: '%',
      note: 'Working-age people in or seeking work' },
    { key: 'arrmig_2', label: 'Recent migrants (5yr) %', group: 'People & income', unit: '%' },
    { key: 'unpaidw_3', label: 'Volunteers %', group: 'People & income', unit: '%' },
    { key: 'vehd_1_pc', label: 'Households without a car %', group: 'People & income', unit: '%' },
    { key: 'hhtype_6', label: 'Avg household size', group: 'People & income', unit: '', dp: 1 },
    { key: 'ing_erp_p_pc', label: 'First Nations residents %', group: 'People & income', unit: '%' },
    { key: 'erp_p_75p_pc', label: 'Population 75+ %', group: 'Life stage', unit: '%' },
    { key: 'erp_sch_1_pc', label: 'School-age (5-19) %', group: 'Life stage', unit: '%' },
    { key: 'leed_4', label: 'Jobs per dwelling', group: 'Economy & disadvantage', unit: '', dp: 2,
      fields: ['leed_4', 'dwell_7'],
      compute: (p) => (Number.isFinite(p.leed_4) && p.dwell_7 > 0)
        ? Math.round(p.leed_4 / p.dwell_7 * 100) / 100 : null },
    { key: 'irsd_score', label: 'Disadvantage score (SEIFA)', group: 'Economy & disadvantage',
      unit: '', invert: true, note: 'Low score = most disadvantaged (coloured red)' },
    { key: 'erp_p_20', label: 'Population', group: 'Economy & disadvantage', unit: '' },
    // Newer official datasets (areastats snapshots) — joined client-side
    // from /api/markets/census/rows; the census FeatureServer doesn't serve
    // these, hence fields: [] keeps them out of the viewport query.
    { key: 'salm_unemp_rate', label: 'Unemployment (SALM)', group: 'People & income', unit: '%', dp: 1,
      dataset: 'salm', fields: [], note: 'DEWR smoothed quarterly series — fresher than the census count' },
    { key: 'erp_total', label: 'Population (ERP)', group: 'Economy & disadvantage', unit: '',
      dataset: 'erp', fields: [], note: 'ABS Regional Population estimate' },
    { key: 'erp_growth_1y_pct', label: 'Population growth 1yr %', group: 'Economy & disadvantage', unit: '%', dp: 1,
      dataset: 'erp', fields: [], note: 'ERP change, latest financial year' },
    { key: 'median_age', label: 'Median age (ERP)', group: 'Life stage', unit: '', dp: 0,
      dataset: 'erp', fields: [], note: 'ABS Regional Population, age & sex' },
    { key: 'approvals_annual', label: 'Dwelling approvals (yr)', group: 'Housing & tenure', unit: '',
      dataset: 'approvals', fields: [], note: 'Total dwelling units approved, latest financial year' },
  ];
  const LQ_HEAT = HEAT_SOURCE;
  const LQ_LAYERS = [
    { group: 'Hazards', key: 'qld-bushfire', label: 'Bushfire prone (QLD)',
      make: () => L.tileLayer(BUSHFIRE_TILES, { maxZoom: 19, opacity: 0.45 }) },
    { group: 'Hazards', key: 'qld-flood', label: 'Flood studies (QLD)',
      make: () => arcgisDynamic('https://spatial-gis.information.qld.gov.au/arcgis/rest/services/FloodCheck/BasicStudies/MapServer') },
    { group: 'Hazards', key: 'vic-bushfire', label: 'Bushfire prone (VIC)',
      make: () => wmsLayer(VIC_WMS, 'open-data-platform:bushfire_prone_area') },
    { group: 'Hazards', key: 'vic-heritage', label: 'Heritage places (VIC)',
      make: () => wmsLayer(VIC_WMS, 'open-data-platform:heritage_register') },
    { group: 'Planning', key: 'vic-zoning', label: 'Planning zones (VIC)',
      make: () => wmsLayer(VIC_WMS, 'open-data-platform:plan_zone') },
    { group: 'Planning', key: 'vic-ugb', label: 'Urban growth boundary (VIC)',
      make: () => wmsLayer(VIC_WMS, 'open-data-platform:ugb_2') },
    { group: 'Planning', key: 'vic-easements', label: 'Easements (VIC)',
      make: () => wmsLayer(VIC_WMS, 'open-data-platform:v_s_easement_approved') },
    { group: 'Boundaries', key: 'vic-lga', label: 'Local government areas (VIC)',
      make: () => wmsLayer(VIC_WMS, 'open-data-platform:lga_polygon', { opacity: 0.35 }) },
    { group: 'Boundaries', key: 'vic-locality', label: 'Suburbs & localities (VIC)',
      make: () => wmsLayer(VIC_WMS, 'open-data-platform:locality_polygon', { opacity: 0.35 }) },
    { group: 'Boundaries', key: 'qld-bounds', label: 'Administrative boundaries (QLD)',
      make: () => arcgisDynamic('https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Boundaries/AdministrativeBoundaries/MapServer', { opacity: 0.35 }) },
    { group: 'Infrastructure', key: 'vic-power', label: 'Electricity distributors (VIC)',
      make: () => wmsLayer(VIC_WMS, 'open-data-platform:electricity_distributor') },
    { group: 'Hazards', key: 'wa-bushfire', label: 'Bushfire prone (WA)',
      make: () => arcgisDynamic('https://services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Bush_Fire_Prone_Areas/MapServer') },
    { group: 'Hazards', key: 'nsw-bushfire', label: 'Bushfire prone (NSW)',
      make: () => arcgisDynamic('https://portal.spatial.nsw.gov.au/server/rest/services/Hosted/NSW_BushFire_Prone_Land/MapServer') },
    { group: 'Hazards', key: 'vic-flood', label: 'Flood history (VIC)',
      make: () => wmsLayer(VIC_WMS, 'open-data-platform:vic_flood_history_public', { opacity: 0.55 }) },
    { group: 'Hazards', key: 'tas-flood', label: 'Flood hazard mapping (TAS)',
      make: () => arcgisDynamic('https://services.thelist.tas.gov.au/arcgis/rest/services/Public/SES_FloodMapping/MapServer', { layers: 'show:10', opacity: 0.55 }) },
    { group: 'Planning', key: 'tas-zones', label: 'Planning scheme zones (TAS)',
      make: () => arcgisDynamic('https://services.thelist.tas.gov.au/arcgis/rest/services/Public/PlanningOnline/MapServer', { layers: 'show:13', opacity: 0.5 }) },
    { group: 'Planning', key: 'wa-zones', label: 'Region scheme zones (WA)',
      make: () => arcgisDynamic('https://services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Property_and_Planning/MapServer', { layers: 'show:48', opacity: 0.5 }) },
    { group: 'Boundaries', key: 'nsw-parcels', label: 'Land parcels (NSW)',
      make: () => arcgisDynamic('https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Land_Parcel_Property_Theme/MapServer', { opacity: 0.5 }) },
    { group: 'Boundaries', key: 'tas-parcels', label: 'Cadastral parcels (TAS)',
      make: () => arcgisDynamic('https://services.thelist.tas.gov.au/arcgis/rest/services/Public/CadastreAndAdministrative/MapServer', { opacity: 0.5 }) },
    { group: 'Boundaries', key: 'sa-basemap', label: 'SA base layers (topographic)',
      make: () => arcgisDynamic('https://maps.sa.gov.au/arcgis/rest/services/BaseMaps/Topographic_wmas/MapServer', { opacity: 0.5 }) },
  ];

  const lq = { map: null, basemap: null, hybridLabels: null, layers: {}, myData: null };

  function wmsLayer(url, layer, opts) {
    return L.tileLayer.wms(url, Object.assign({
      layers: layer, format: 'image/png', transparent: true, opacity: 0.6,
    }, opts || {}));
  }

  // ArcGIS MapServer → Leaflet: each tile becomes an export-image request
  // with the tile's bbox (Web Mercator → EPSG:4326). opts.layers (an ArcGIS
  // "show:id" spec) restricts the export to specific layers.
  function arcgisDynamic(serviceUrl, opts) {
    const layersParam = opts && opts.layers ? `&layers=${opts.layers}` : '';
    const Arc = L.TileLayer.extend({
      getTileUrl(coords) {
        const n = Math.pow(2, coords.z);
        const lonMin = (coords.x / n) * 360 - 180;
        const lonMax = ((coords.x + 1) / n) * 360 - 180;
        const latOf = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
        return serviceUrl + '/export?' +
          `bbox=${lonMin},${latOf(coords.y + 1)},${lonMax},${latOf(coords.y)}` +
          '&bboxSR=4326&size=256,256&format=png32&transparent=true&f=image' +
          layersParam;
      },
    });
    return new Arc(serviceUrl + '/export', Object.assign({
      tileSize: 256, opacity: 0.6, maxZoom: 19,
    }, opts || {}));
  }

  const LQ_BASEMAPS = {
    standard: () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }),
    satellite: () => L.tileLayer(INTEL_BASEMAPS.sat.url,
      { maxZoom: 19, attribution: INTEL_BASEMAPS.sat.attribution }),
    hybrid: () => L.tileLayer(INTEL_BASEMAPS.sat.url,
      { maxZoom: 19, attribution: INTEL_BASEMAPS.sat.attribution }),
  };
  const LQ_HYBRID_LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

  function initLocationIQ() {
    if (!L) { toast('Map library not loaded'); return; }
    if (!lq.map) {
      lq.map = L.map('lq-map', { zoomControl: true }).setView([-25.5, 134.5], 4);
      setLqBasemap('hybrid');
      // Layer panel
      const groups = {};
      LQ_LAYERS.forEach((l) => { (groups[l.group] = groups[l.group] || []).push(l); });
      $('#lq-layers').innerHTML = Object.entries(groups).map(([group, layers]) => `
        <div class="lq-group">
          <div class="lq-group-head">${escapeHtml(group)}</div>
          ${layers.map((l) => `
            <label class="lq-layer"><input type="checkbox" data-lq-layer="${l.key}">
            <span>${escapeHtml(l.label)}</span></label>`).join('')}
        </div>`).join('')
        + `<div class="lq-group"><div class="lq-group-head">My data</div>
           <label class="lq-layer"><input type="checkbox" data-lq-mine>
           <span>My properties (scenarios)</span></label></div>`
        + `<div class="lq-group"><div class="lq-group-head">Heat maps</div>
           <div class="note">ABS census + newer official datasets (SA2 level) — each metric shows its own vintage.</div>
           <select id="lq-heat-metric">${heatGroupOptions().map((g) =>
             `<optgroup label="${escapeHtml(g.group)}">${g.items.map((m) =>
               `<option value="${m.key}">${escapeHtml(m.label)}</option>`).join('')}</optgroup>`).join('')}</select>
           <label class="lq-layer"><input type="checkbox" data-lq-heat>
           <span>Show census heat map</span></label>
           <div id="lq-heat-legend" class="lq-legend"></div></div>`;
      $('#lq-layers').addEventListener('change', (ev) => {
        const cb = ev.target;
        if (cb.dataset.lqLayer) toggleLqLayer(cb.dataset.lqLayer, cb.checked);
        if (cb.dataset.lqMine !== undefined && 'lqMine' in cb.dataset) toggleLqMine(cb.checked);
        if (cb.dataset.lqHeat !== undefined) toggleLqHeat(cb.checked);
        if (cb.id === 'lq-heat-metric' && lq.heat) toggleLqHeat(true); // live metric switch
      });
      // Basemap switcher
      $('#lq-basemap').addEventListener('change', (ev) => setLqBasemap(ev.target.value));
      // Address search — reuses the Domain suggest endpoint
      let seq = 0;
      $('#lq-search').addEventListener('input', (ev) => {
        const q = ev.target.value.trim();
        const box = $('#lq-suggest');
        if (q.length < 3) { box.classList.add('hidden'); return; }
        const s = ++seq;
        api('/api/address/suggest?q=' + encodeURIComponent(q)).then((list) => {
          if (s !== seq) return;
          box.innerHTML = (list || []).map((a) => `
            <div class="addr-item" data-lq-lat="${a.lat || ''}" data-lq-lon="${a.lon || ''}"
                 data-lq-label="${escapeHtml(a.address || '')}">${escapeHtml(a.address || '')}
            <div class="sub">${escapeHtml(a.suburb || '')} ${escapeHtml(a.postcode || '')}</div></div>`).join('');
          box.classList.toggle('hidden', !(list || []).length);
        }).catch(() => { box.classList.add('hidden'); });
      });
      $('#lq-suggest').addEventListener('click', (ev) => {
        const el = ev.target.closest('[data-lq-lat]');
        if (!el) return;
        const lat = Number(el.dataset.lqLat), lon = Number(el.dataset.lqLon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) lq.map.setView([lat, lon], 17);
        $('#lq-search').value = el.dataset.lqLabel || '';
        $('#lq-suggest').classList.add('hidden');
      });
      setTimeout(() => lq.map.invalidateSize(), 80);
      // Minimal automation/testing seam — the map itself stays closed over.
      window.PropertyAnalyserLocationIQ = { map: lq.map };
    } else {
      setTimeout(() => lq.map.invalidateSize(), 80);
    }
  }

  function setLqBasemap(kind) {
    if (!lq.map) return;
    if (lq.basemap) lq.map.removeLayer(lq.basemap);
    if (lq.hybridLabels) { lq.map.removeLayer(lq.hybridLabels); lq.hybridLabels = null; }
    lq.basemap = (LQ_BASEMAPS[kind] || LQ_BASEMAPS.standard)();
    lq.basemap.addTo(lq.map);
    lq.basemap.setZIndex(1);
    if (kind === 'hybrid') {
      lq.hybridLabels = L.tileLayer(LQ_HYBRID_LABELS, { maxZoom: 19, opacity: 0.9 });
      lq.hybridLabels.addTo(lq.map);
      lq.hybridLabels.setZIndex(2);
    }
  }

  function toggleLqLayer(key, on) {
    const def = LQ_LAYERS.find((l) => l.key === key);
    if (!def || !lq.map) return;
    if (on && !lq.layers[key]) lq.layers[key] = def.make().addTo(lq.map);
    if (!on && lq.layers[key]) { lq.map.removeLayer(lq.layers[key]); delete lq.layers[key]; }
  }

  async function toggleLqMine(on) {
    if (!lq.map) return;
    if (!on) {
      if (lq.myData) { lq.map.removeLayer(lq.myData); lq.myData = null; }
      return;
    }
    try {
      const items = await api('/api/scenarios/portfolio');
      const colors = { purchased: '#059669', under_offer: '#f59e0b', considering: '#64748b' };
      lq.myData = L.layerGroup();
      items.forEach((i) => {
        const meta = ((i.inputs.properties || [])[0] || {}).addressMeta || {};
        const lat = Number(meta.lat), lon = Number(meta.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const color = colors[i.ownershipStatus] || '#64748b';
        L.circleMarker([lat, lon], { radius: 8, color, weight: 3, fillOpacity: 0.4 })
          .bindPopup(`<strong>${escapeHtml(i.name)}</strong><br>${escapeHtml(i.address || '')}<br>` +
            `${escapeHtml(i.ownershipStatus.replace('_', ' '))} · ${fmtMoney(((i.inputs.properties || [{}])[0] || {}).purchasePrice || 0)}`)
          .addTo(lq.myData);
      });
      lq.myData.addTo(lq.map);
      if (!items.some((i) => {
        const meta = ((i.inputs.properties || [{}])[0] || {}).addressMeta || {};
        return Number.isFinite(Number(meta.lat));
      })) toast('None of your scenarios have located addresses yet');
    } catch (err) { toast('Could not load your properties: ' + err.message); }
  }

  // Census heat map: 2021 Census socio-economic data by SA2, queried for
  // the current viewport straight from ABS's ArcGIS FeatureServer.
  function heatMetricDef(key) {
    return HEAT_METRICS.find((m) => m.key === key) || null;
  }

  // Newer-dataset rows (areastats) fetched once per session and joined by
  // SA2 code — the FeatureServer payload can't carry them.
  const heatDatasetRows = new Map(); // dataset key -> { promise, data }
  async function heatRowsFor(dataset) {
    let entry = heatDatasetRows.get(dataset);
    if (!entry) {
      entry = { promise: null, data: null };
      entry.promise = fetch(`/api/markets/census/rows?key=${encodeURIComponent(dataset)}`)
        .then((r) => r.json())
        .then((b) => { entry.data = b.ok ? b.data : null; return entry.data; })
        .catch(() => { entry.data = null; return null; });
      heatDatasetRows.set(dataset, entry);
    }
    return entry.promise;
  }

  function heatValue(def, props) {
    if (def.dataset) {
      const snap = (heatDatasetRows.get(def.dataset) || {}).data;
      const row = snap && (snap.rows || {})[String(props.sa2_code_2021)];
      const v = row ? row[def.key] : null;
      return Number.isFinite(v) ? v : null;
    }
    if (def.compute) return def.compute(props);
    const v = props[def.key];
    return Number.isFinite(v) ? v : null;
  }

  function heatFmt(def, v) {
    const dp = def.dp != null ? def.dp : 0;
    return dp ? Number(v).toFixed(dp) : Math.round(v).toLocaleString();
  }

  function heatColor(def, v, min, max) {
    const raw = max > min ? (v - min) / (max - min) : 0;
    const t = def.invert ? 1 - raw : raw;
    return HEAT_SOURCE.ramp[Math.min(HEAT_SOURCE.ramp.length - 1,
      Math.floor(t * HEAT_SOURCE.ramp.length))];
  }

  function heatLegendInto(sel, def, min, max, vintage) {
    const el = $(sel);
    if (!el || !def) return;
    el.innerHTML = `<div class="lq-legend-title">${escapeHtml(def.label)}${vintage
      ? ` <small>· ${escapeHtml(vintage)}</small>` : ''}</div>
      <div class="lq-legend-bar">${HEAT_SOURCE.ramp.map((c) =>
        `<span style="background:${c}"></span>`).join('')}</div>
      <div class="lq-legend-cap"><span>${heatFmt(def, min)}${def.unit}</span>
      <span>${heatFmt(def, max)}${def.unit}</span></div>`;
  }

  function heatLoadingInto(sel, def, box, on) {
    // Skip the flash when this viewport is already cached (instant repaint).
    const cached = box && heatCache.get(heatBoxKey(box));
    if (!on || (cached && cached.data)) return;
    const el = $(sel);
    if (el) el.innerHTML =
      `<div class="lq-legend-title">${escapeHtml(def.label)}</div>
       <div class="heat-loading"><span class="heat-spin"></span>Loading ABS census data…</div>`;
  }

  // Census responses cached per viewport for the session — geometry dominates
  // the payload and every metric paints the same SA2 shapes, so ONE fetch per
  // viewport carries all 21 metrics and switching metrics is an instant
  // repaint. Concurrent paints (both maps) share the in-flight request.
  const heatCache = new Map(); // box key -> { promise, data }
  const HEAT_ALL_FIELDS = ['sa2_name_2021', 'sa2_code_2021'].concat(
    [...new Set(HEAT_METRICS.flatMap((m) => m.fields || [m.key]))]).join(',');
  const heatBoxKey = (box) => box.map((v) => v.toFixed(3)).join(',');

  async function fetchHeatGeojson(box) {
    const key = heatBoxKey(box);
    let entry = heatCache.get(key);
    if (!entry) {
      entry = { promise: null, data: null };
      entry.promise = fetchHeatPages(box).then((d) => { entry.data = d; return d; });
      if (heatCache.size > 40) heatCache.clear(); // bound memory on long sessions
      heatCache.set(key, entry);
    }
    return entry.promise;
  }

  // The FeatureServer caps each response at maxRecordCount 1000 and flags
  // `exceededTransferLimit` — page through or whole-of-state views are
  // silently truncated. Simplification scales with viewport width so a
  // national view doesn't download house-block-level outlines.
  async function fetchHeatPages(box) {
    const width = box[2] - box[0];
    const tolerance = Math.min(0.04, Math.max(0.0008, width / 500));
    const geom = encodeURIComponent(JSON.stringify({
      xmin: box[0], ymin: box[1], xmax: box[2], ymax: box[3],
    }));
    let feats = [], exceeded = true, page = 0;
    while (exceeded && page < 4) {
      const url = `${HEAT_SOURCE.url}?where=1%3D1` +
        `&outFields=${encodeURIComponent(HEAT_ALL_FIELDS)}` +
        `&geometry=${geom}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326` +
        `&maxAllowableOffset=${tolerance}&resultRecordCount=1000` +
        `&resultOffset=${page * 1000}&f=geojson`;
      const resp = await fetch(url);
      const d = await resp.json();
      if (d.error) throw new Error(d.error.message || 'ABS service error');
      feats = feats.concat(d.features || []);
      exceeded = !!(d.properties && d.properties.exceededTransferLimit);
      page += 1;
    }
    return { type: 'FeatureCollection', features: feats };
  }

  // ctl = { layer, legendSel, labels }. Paints the metric over `map`'s
  // viewport; safe to call repeatedly (old layer is replaced, and a paint
  // that finishes after a newer call started abandons instead of clobbering).
  async function paintHeatInto(map, ctl, metricKey) {
    const def = heatMetricDef(metricKey);
    if (!def || !map) return;
    const seq = (ctl.seq = (ctl.seq || 0) + 1);
    let snap = null;
    if (def.dataset) {
      snap = await heatRowsFor(def.dataset);
      if (ctl.seq !== seq) return;
      if (!snap) {
        const el = $(ctl.legendSel);
        if (el) el.innerHTML = '';
        toast('Area dataset unavailable for this metric: ' + def.dataset);
        return;
      }
    }
    const b = map.getBounds();
    const box = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    heatLoadingInto(ctl.legendSel, def, box, true);
    let d;
    try {
      d = await fetchHeatGeojson(box);
    } catch (err) {
      if (ctl.seq !== seq) return;
      const el = $(ctl.legendSel);
      if (el) el.innerHTML = '';
      toast('Census heat map: ' + err.message);
      return;
    }
    if (ctl.seq !== seq) return; // superseded by a newer metric/viewport paint
    const feats = (d.features || []).filter((f) => heatValue(def, f.properties) !== null);
    if (!feats.length) { toast('No area data for this map area — zoom to an urban area'); return; }
    if (ctl.seq !== seq) return;
    const vals = feats.map((f) => heatValue(def, f.properties));
    const min = Math.min(...vals), max = Math.max(...vals);
    const vint = snap ? (snap.vintage || {})[def.key]
      || Object.values(snap.vintage || {})[0] || '' : '';
    if (ctl.layer) { map.removeLayer(ctl.layer); }
    ctl.layer = L.geoJSON(d, {
      filter: (f) => heatValue(def, f.properties) !== null,
      style: (f) => ({ color: '#334155', weight: 0.5, fillOpacity: 0.55,
        fillColor: heatColor(def, heatValue(def, f.properties), min, max) }),
      onEachFeature: (f, layer) => {
        const props = f.properties;
        const v = heatValue(def, props);
        const line = `<strong>${escapeHtml(props.sa2_name_2021)}</strong><br>` +
          `${escapeHtml(def.label)}: <strong>${heatFmt(def, v)}${def.unit}</strong>` +
          (vint ? ` <small>· ${escapeHtml(vint)}</small>` : '') +
          (def.note ? `<br><span style="color:#64748b">${escapeHtml(def.note)}</span>` : '');
        if (ctl.labels) {
          layer.bindTooltip(`<span class="heat-label">${heatFmt(def, v)}${def.unit}</span>`,
            { permanent: true, direction: 'center', className: 'heat-label-tip',
              opacity: 0.9 });
        }
        layer.bindPopup(line);
      },
    });
    ctl.layer.addTo(map);
    heatLegendInto(ctl.legendSel, def, min, max, vint);
  }

  // ------------------------------------------------------------------
  // Dedicated Heat maps page
  // ------------------------------------------------------------------

  const hm = { map: null, metric: 'tenure_4', moveTimer: null,
    ctl: { layer: null, legendSel: '#hm-legend', labels: false } };

  function heatGroupOptions() {
    const groups = [];
    HEAT_METRICS.forEach((m) => {
      let g = groups.find((x) => x.group === m.group);
      if (!g) groups.push(g = { group: m.group, items: [] });
      g.items.push(m);
    });
    return groups;
  }

  // Heat-map address search: fly the map to the located point + drop a pin.
  function heatFlyTo(lat, lon, label) {
    if (!hm.map) { initHeatMapsPage(); }
    if (!hm.map) return;
    const flon = numOrNull(lon), flat = numOrNull(lat);
    if (flon === null || flat === null) return;
    if (hm.marker) hm.map.removeLayer(hm.marker);
    hm.marker = L.marker([flat, flon]).addTo(hm.map)
      .bindPopup(escapeHtml(label || 'Selected address')).openPopup();
    hm.map.flyTo([flat, flon], 13, { duration: 0.8 });
  }

  function initHeatMapsPage() {
    if (!L) { toast('Map library not loaded'); return; }
    if (!hm.map) {
      hm.marker = null;
      hm.map = L.map('hm-map', { zoomControl: true }).setView([-25.5, 134.5], 4);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(hm.map);
      hm.placeLabels = L.tileLayer(LQ_HYBRID_LABELS,
        { maxZoom: 19, opacity: 0.85, pane: 'shadowPane' }).addTo(hm.map);
      hm.map.on('moveend', () => {
        clearTimeout(hm.moveTimer);
        hm.moveTimer = setTimeout(() => {
          if (!$('#section-heatmaps').classList.contains('hidden')) {
            paintHeatInto(hm.map, hm.ctl, hm.metric);
          }
        }, 700);
      });
      // Start on the property you're analysing when it has coordinates.
      const meta = activePropertyIndex() != null
        ? (state.inputs.properties[activePropertyIndex()] || {}).addressMeta : null;
      if (meta && numOrNull(meta.lat) !== null) hm.map.setView([meta.lat, meta.lon], 12);
      wireAddressPicker({
        inputSel: '#hm-address-input',
        dropdownSel: '#hm-addr-dropdown',
        scope: 'property',
        onPick: {
          located: (item) => {
            setMatched('#hm-address-matched', item);
            heatFlyTo(item.lat, item.lon, item.address);
          },
          chosen: (item) => {
            setMatched('#hm-address-matched', item);
            heatFlyTo(item.lat, item.lon, item.address);
          },
        },
      });
      $('#hm-groups').innerHTML = heatGroupOptions().map((g) =>
        `<div class="chip-row-label">${escapeHtml(g.group)}</div>
         <div class="chip-row">${g.items.map((m) =>
           `<button class="chip ${m.key === hm.metric ? 'active' : ''}"
             data-hm-metric="${m.key}" title="${escapeHtml(m.note || m.label)}">${escapeHtml(m.label)}</button>`).join('')}</div>`).join('');
      $('#hm-groups').addEventListener('click', (ev) => {
        const chip = ev.target.closest('button[data-hm-metric]');
        if (!chip) return;
        hm.metric = chip.dataset.hmMetric;
        $$('#hm-groups .chip').forEach((c) =>
          c.classList.toggle('active', c.dataset.hmMetric === hm.metric));
        paintHeatInto(hm.map, hm.ctl, hm.metric);
      });
      $('#hm-labels').addEventListener('change', (ev) => {
        hm.ctl.labels = ev.target.checked;
        paintHeatInto(hm.map, hm.ctl, hm.metric); // cache hit → instant
      });
    }
    setTimeout(() => { hm.map.invalidateSize(); paintHeatInto(hm.map, hm.ctl, hm.metric); }, 80);
  }

  const lqHeatCtl = {
    legendSel: '#lq-heat-legend', labels: false,
    get layer() { return lq.heat; }, set layer(v) { lq.heat = v; },
    get seq() { return lq._heatSeq || 0; }, set seq(v) { lq._heatSeq = v; },
  };

  async function toggleLqHeat(on) {
    if (!lq.map) return;
    if (!on) {
      if (lq.heat) { lq.map.removeLayer(lq.heat); lq.heat = null; }
      const el = $('#lq-heat-legend');
      if (el) el.innerHTML = '';
      return;
    }
    const metric = ($('#lq-heat-metric') || {}).value || 'tenure_4';
    await paintHeatInto(lq.map, lqHeatCtl, metric);
  }

  // ------------------------------------------------------------------
  // Deal Check — ten census verdicts for the active property's SA2
  // ------------------------------------------------------------------

  const dc = { last: null, valuations: new Map(), stateGrowth: new Map() };

  function dealCheckSubject() {
    const meta = activePropertyIndex() != null
      ? (state.inputs.properties[activePropertyIndex()] || {}).addressMeta : null;
    const lat = meta ? numOrNull(meta.lat) : null;
    const lon = meta ? numOrNull(meta.lon) : null;
    return (lat !== null && lon !== null) ? { lat, lon, meta } : null;
  }

  async function fetchDealCheck(lat, lon, postcode) {
    let q = `/api/markets/census/point?lat=${lat}&lon=${lon}`;
    if (postcode) q += '&postcode=' + encodeURIComponent(postcode);
    return api(q);
  }

  function dcSuburb() {
    return (state.suburbs || []).find((s) => s.id === Number(state.inputs.suburbId)) || null;
  }

  // Price benchmark: the linked suburb row first; a VIC Valuer-General sold
  // median when the row is missing one (rent/vacancy stay suburb-only).
  async function dcPriceBenchmark(meta, suburb) {
    if (suburb && Number(suburb.medianPrice) > 0) return suburb;
    const name = meta && meta.suburb, stateName = meta && meta.state;
    if (!name || !stateName) return suburb || null;
    const key = String(stateName).toUpperCase() + '|' + String(name).toLowerCase();
    if (!dc.valuations.has(key)) {
      dc.valuations.set(key,
        api(`/api/valuation?suburb=${encodeURIComponent(name)}&state=${encodeURIComponent(stateName)}`)
          .then((d) => (d && d.available && d.latest && d.latest.median)
            ? Object.assign({}, suburb || {}, {
                name: d.suburb || name, medianPrice: d.latest.median,
                medianPriceSource: d.source || 'VIC Valuer-General sales' })
            : null)
          .catch(() => null));
    }
    const v = await dc.valuations.get(key);
    return v || suburb || null;
  }

  // ABS capital-city median growth over five years (TVD series), used as the
  // state benchmark for the growth_vs_state market verdict.
  async function dcStateGrowth5yr(stateCode) {
    if (!stateCode) return null;
    if (!dc.stateGrowth.has(stateCode)) {
      dc.stateGrowth.set(stateCode,
        api(`/api/markets/prices?state=${encodeURIComponent(stateCode)}`)
          .then((d) => E.stateGrowth5yr(d, stateCode)).catch(() => null));
    }
    return dc.stateGrowth.get(stateCode);
  }

  async function dcEvidence(suburb, comps, rentals) {
    const st = (await dcStateGrowth5yr(state.inputs.state)) || {};
    return { comps: comps || state.comps || [], rentals: rentals || state.rentals || [],
             suburb, stateGrowth5yr: st.pct, stateGrowthLabel: st.label };
  }

  // Census verdicts (server-scored) + deal verdicts (engine, client-scored)
  // + market-evidence verdicts, blended by the engine's shared composer.
  function buildDealCheckBundle(censusData, inputs, result, suburb, idx, evidence) {
    const i = Number.isInteger(idx) ? idx
      : (activePropertyIndex() != null ? activePropertyIndex() : 0);
    return E.dealCheckBundle({
      census: censusData, inputs,
      metrics: (((result || {}).properties || [])[i] || {}).metrics,
      suburb, evidence,
    });
  }

  function dcOrdinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function dcNum(v, dp) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    const d = dp != null ? dp : 0;
    return d ? Number(v).toFixed(d) : Math.round(Number(v)).toLocaleString();
  }

  function dcMoneyOrUnit(v, unit, dp) {
    const n = dcNum(v, dp);
    return n == null ? '—' : (unit === '$' ? '$' + n : n + unit);
  }

  function dcChip(m) {
    const bits = [];
    if (m.vintage) bits.push(m.vintage);
    if (m.percentile != null) bits.push(dcOrdinal(m.percentile) + ' pct');
    const bm = dcNum(m.benchmark, m.dp);
    if (bm != null) bits.push((m.percentile != null ? 'median ' : 'suburb ')
      + bm + (m.unit === '$' ? '' : m.unit));
    const sub = bits.join(' · ') || m.note || '';
    return `<div class="dc-chip" title="${escapeHtml(m.note || '')}">
      <span class="dc-chip-label">${escapeHtml(m.label)}</span>
      <span class="dc-chip-val"><strong>${escapeHtml(dcMoneyOrUnit(m.value, m.unit, m.dp))}</strong>
      ${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span>
    </div>`;
  }

  function dcCard(v) {
    return `<div class="dc-card dc-${v.status}">
      <div class="dc-card-head">
        <span class="dc-pill">${v.status === 'strong' ? 'STRONG' : v.status === 'ok' ? 'OK' : v.status === 'watch' ? 'WATCH' : 'NO DATA'}</span>
        <span class="dc-card-score">${v.score != null ? v.score + '/100' : ''}</span>
      </div>
      <div class="dc-card-q">${escapeHtml(v.question)}</div>
      <div class="dc-card-headline">${escapeHtml(v.headline)}</div>
      ${(v.metrics || []).map(dcChip).join('')}
    </div>`;
  }

  function renderDealCheck(bundle, opts) {
    const o = bundle.overall || {};
    const drivers = o.drivers || {};
    const driverLine = (drivers.for || []).length || (drivers.against || []).length
      ? `<div class="dc-drivers">${[
          (drivers.for || []).length ? `For: ${escapeHtml(drivers.for.join(' · '))}` : '',
          (drivers.against || []).length ? `Against: ${escapeHtml(drivers.against.join(' · '))}` : '',
        ].filter(Boolean).join('</div><div class="dc-drivers">')}</div>` : '';
    const groupHtml = [['area', 'The area — fundamentals'],
                       ['deal', 'The deal — your numbers'],
                       ['market', 'The market — local evidence']].map(([g, label]) => {
      const list = (bundle.verdicts || []).filter((v) => v.group === g);
      if (!list.length) return '';
      return `<div class="chip-row-label">${escapeHtml(label)}</div>
        <div class="dc-grid">${list.map(dcCard).join('')}</div>`;
    }).join('');
    const suburbHint = opts && opts.suburbLinked === false
      ? `<div class="dc-empty" style="margin-bottom:.8rem">Tip — link a suburb or analyse a located VIC address to unlock the price, rent, vacancy and growth checks.</div>` : '';
    $('#dc-body').innerHTML = `
      <div class="dc-banner dc-${o.status || 'nodata'}">
        <div class="dc-banner-word">${escapeHtml(o.verdictWord || '—')}</div>
        <div class="dc-banner-copy">
          <div><strong>${escapeHtml((bundle.sa2 || {}).name || 'Area not located')}</strong> — ${escapeHtml(o.headline || '')}</div>
          ${driverLine}
        </div>
        <div class="dc-banner-score">${o.score != null ? o.score : '—'}<small>/100</small></div>
      </div>
      ${suburbHint}
      ${groupHtml}
      ${dcSourceNote(bundle)}`;
}

  function dcSourceNote(bundle) {
    const fetched = (bundle.fetchedAt
      && new Date(bundle.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) || null;
    const bits = [];
    if (bundle.source) bits.push(escapeHtml(bundle.source));
    bits.push('area percentiles compare this SA2 with all of Australia');
    bits.push('deal verdicts score your numbers against the linked suburb');
    bits.push('market verdicts use your saved comparables, suburb data and the ABS price series');
    bits.push(fetched ? `area metrics fetched live just now (${fetched})` : 'area metrics fetch live on load');
    return `<div class="source-note">${bits.join(' — ')}</div>`;
  }

  async function initDealCheckPage(force) {
    const host = $('#dc-body');
    if (!host) return;
    const suburbRow = dcSuburb();
    const subj = dealCheckSubject();
    if (!subj && !suburbRow) {
      host.innerHTML = `<div class="dc-empty">Locate the property address or link a suburb (Investment inputs → suburb selector) — the deal check scores the area and your numbers.</div>`;
      return;
    }
    let census = (dc.last && subj && dc.last.lat === subj.lat && dc.last.lon === subj.lon)
      ? dc.last.data : null;
    if (subj && !census) {
      host.innerHTML = `<div class="heat-loading"><span class="heat-spin"></span>Scoring the area against national data…</div>`;
      try {
        census = await fetchDealCheck(subj.lat, subj.lon, subj.meta && subj.meta.postcode);
      } catch (err) {
        host.innerHTML = `<div class="dc-empty">Deal check unavailable: ${escapeHtml(err.message)}</div>`;
        return;
      }
    }
    const suburb = await dcPriceBenchmark(subj && subj.meta, suburbRow);
    if (state.scenarioId && !state.comps) {
      try { await loadComps(); } catch (e) { /* evidence is best-effort */ }
    }
    const bundle = buildDealCheckBundle(census, state.inputs, state.result, suburb,
      undefined, await dcEvidence(suburb));
    dc.last = subj ? { lat: subj.lat, lon: subj.lon, data: census, bundle } : { data: census, bundle };
    renderDealCheck(bundle, { suburbLinked: !!suburb });
  }

  window.PropertyAnalyserDealCheck = { run: initDealCheckPage, last: () => dc.last };

  // ------------------------------------------------------------------
  // Announcement strip + first-run tour

  function renderAnalyticsInsight(id, items, note) {
    const host = $('#' + id);
    if (!host) return;
    host.innerHTML = '<div class="analytics-insight-head"><div><span class="page-eyebrow">KEY TAKEAWAYS</span><strong>What this means</strong></div><span>' + escapeHtml(note || 'Based on current assumptions') + '</span></div><div class="analytics-insight-grid">' +
      items.map(x => '<div class="analytics-takeaway ' + (x.tone || '') + '"><small>' + escapeHtml(x.label) + '</small><strong>' + escapeHtml(x.value) + '</strong><span>' + escapeHtml(x.detail || '') + '</span></div>').join('') + '</div>';
  }

  const QUICK_PAGES = [
    ['overview','Dashboard','Portfolio overview'],['inputs','Investment inputs','Edit assumptions'],
    ['property','Property intelligence','Map and property data'],['area','Area & suburb','Market research'],
    ['cashflow','Cash flow','Income and expenses'],['projections','Projections','Long-term outlook'],
    ['exit','Exit & CGT','Sale and capital gains'],['borrowing','Borrowing capacity','Serviceability'],
    ['scenarios','Scenarios','Compare saved cases'],['actuals','Actuals','Actual performance'],['workspace','Client workspace','Buyer agent tools']
  ];

  function wireCommandPalette() {
    const overlay=$('#command-palette'), input=$('#command-search-input'), results=$('#command-results');
    if(!overlay||!input||!results)return;
    let entries=[], active=0;
    const close=()=>{overlay.classList.add('hidden');input.value='';};
    const open=()=>{build('');overlay.classList.remove('hidden');input.focus();};
    const trigger=$('#command-open');if(trigger)trigger.addEventListener('click',open);
    function build(query) {
      const q=String(query||'').trim().toLowerCase();
      entries=[];
      QUICK_PAGES.forEach(p=>{if((p[1]+' '+p[2]).toLowerCase().includes(q))entries.push({type:'page',title:p[1],detail:p[2],target:p[0]});});
      (state.scenarioList||[]).forEach(s=>{if((s.name||'').toLowerCase().includes(q))entries.push({type:'scenario',title:s.name,detail:'Saved scenario',id:s.id});});
      (dash.items||[]).forEach(p=>{if((p.address+' '+p.suburb+' '+p.scenarioName).toLowerCase().includes(q))entries.push({type:'property',title:p.address,detail:[p.suburb,p.scenarioName].filter(Boolean).join(' · '),id:p.scenarioId,index:p.index});});
      if(!q) entries=entries.slice(0,12);
      active=0;
      results.innerHTML=entries.length?entries.slice(0,18).map((e,i)=>'<button type="button" class="command-result '+(i===0?'active':'')+'" data-command-index="'+i+'"><span class="command-result-icon">'+(e.type==='page'?'↗':e.type==='scenario'?'▤':'⌂')+'</span><span><strong>'+escapeHtml(e.title)+'</strong><small>'+escapeHtml(e.detail)+'</small></span><kbd>'+(e.type==='page'?'PAGE':e.type==='scenario'?'SCENARIO':'PROPERTY')+'</kbd></button>').join(''):'<div class="command-empty">No matching pages, properties or scenarios.</div>';
    }
    function choose(i) {
      const e=entries[i];if(!e)return;
      close();
      if(e.type==='page'){const a=document.querySelector('#nav a[data-target="'+e.target+'"]');if(a)a.click();}
      else if(e.type==='scenario')loadScenario(e.id);
      else loadScenario(e.id).then(()=>{if(Number.isInteger(e.index)){state.inputTab=e.index;setActiveTab(e.index);}const a=document.querySelector('#nav a[data-target="property"]');if(a)a.click();});
    }
    input.addEventListener('input',()=>build(input.value));
    results.addEventListener('click',ev=>{const b=ev.target.closest('[data-command-index]');if(b)choose(Number(b.dataset.commandIndex));});
    input.addEventListener('keydown',ev=>{
      if(ev.key==='ArrowDown'||ev.key==='ArrowUp'){ev.preventDefault();active=(active+(ev.key==='ArrowDown'?1:-1)+Math.min(entries.length,18))%Math.min(entries.length,18);results.querySelectorAll('.command-result').forEach((b,i)=>b.classList.toggle('active',i===active));}
      if(ev.key==='Enter'){ev.preventDefault();choose(active);}
      if(ev.key==='Escape')close();
    });
    overlay.addEventListener('mousedown',ev=>{if(ev.target===overlay)close();});
    document.addEventListener('keydown',ev=>{
      if((ev.metaKey||ev.ctrlKey)&&ev.key.toLowerCase()==='k'){ev.preventDefault();overlay.classList.contains('hidden')?open():close();}
      else if(ev.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!ev.metaKey&&!ev.ctrlKey){ev.preventDefault();open();}
      else if(ev.key==='Escape'&&!overlay.classList.contains('hidden'))close();
    });
  }

  // ------------------------------------------------------------------

  const ANNOUNCE_KEY = 'pa_announce_dismissed';

  function wireAnnouncement() {
    const bar = $('#announce');
    const close = $('#announce-close');
    if (!bar || !close) return;
    let dismissed = false;
    try { dismissed = localStorage.getItem(ANNOUNCE_KEY) === '1'; } catch (e) { /* private mode */ }
    if (!dismissed) bar.classList.remove('hidden');
    close.addEventListener('click', () => {
      bar.classList.add('hidden');
      try { localStorage.setItem(ANNOUNCE_KEY, '1'); } catch (e) { /* ignore */ }
    });
  }

  const TOUR_KEY = 'pa_tour_seen';
  const TOUR_STEPS = [
    {
      title: 'Your dashboard',
      body: 'Everything you have analysed in one place — portfolio highlights, cash flow and the long-term position of each property.',
      target: '#dashboard-hero-metrics',
    },
    {
      title: 'Property data',
      body: 'Pick an address in Inputs and the Property tab pulls live Queensland Government data — parcel, planning, flood and bushfire.',
      target: '#nav a[data-target="property"]',
    },
    {
      title: 'Your properties',
      body: 'Every saved property, scored and ready to open. Save a scenario in Inputs and it appears here.',
      target: '#dash-props',
    },
    {
      title: 'Share with clients',
      body: 'Buyers\' agents can turn any scenario into a client link with the same property facts and a PDF.',
      target: '#nav-workspace',
      needsBa: true,
    },
  ];

  function wireTour() {
    document.addEventListener('click', (ev) => {
      if (ev.target.closest('#tour-next')) { tourNext(); return; }
      if (ev.target.closest('#tour-skip') || ev.target.closest('#tour-close')) { endTour(); }
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && $('#tour')) endTour();
    });
  }

  function tourSteps() {
    const isBa = state.currentUser && state.currentUser.role === 'ba';
    return TOUR_STEPS.filter((s) => !s.needsBa || isBa);
  }

  function startTour() {
    let seen = false;
    try { seen = localStorage.getItem(TOUR_KEY) === '1'; } catch (e) { /* ignore */ }
    if (seen) return;
    const steps = tourSteps();
    if (!steps.length) return;
    showTourStep(0, steps);
  }

  function showTourStep(i, steps) {
    const step = steps[i];
    const target = step.target ? document.querySelector(step.target) : null;
    const box = $('#tour');
    const tip = $('#tour-tip');
    if (!box || !tip) return;
    box.classList.remove('hidden');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let hole;
    if (target) {
      const r = target.getBoundingClientRect();
      const pad = 8;
      hole = {
        top: Math.max(0, r.top - pad),
        left: Math.max(0, r.left - pad),
        width: Math.max(24, r.width + pad * 2),
        height: Math.max(24, r.height + pad * 2),
      };
    } else {
      hole = { top: vh / 2 - 40, left: vw / 2 - 60, width: 120, height: 80 };
    }
    tip.style.top = hole.top + 'px';
    tip.style.left = hole.left + 'px';
    tip.style.width = hole.width + 'px';
    tip.style.height = hole.height + 'px';
    $('#tour-title').textContent = step.title;
    $('#tour-body').textContent = step.body;
    $('#tour-dots').innerHTML = steps.map((_, k) =>
      `<span class="${k === i ? 'on' : ''}"></span>`).join('');
    $('#tour-next').textContent = i === steps.length - 1 ? 'Done' : 'Next';

    // Park the card just below the spotlight, kept inside the viewport.
    const card = $('#tour-card');
    const cr = card.getBoundingClientRect();
    let left = hole.left;
    let top = hole.top + hole.height + 12;
    if (top + cr.height > vh - 12) top = hole.top - cr.height - 12;
    left = Math.min(Math.max(12, left), Math.max(12, vw - cr.width - 12));
    top = Math.min(Math.max(12, top), Math.max(12, vh - cr.height - 12));
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  function tourNext() {
    const steps = tourSteps();
    const cur = Number($('#tour') && $('#tour').dataset.step || 0);
    if (cur + 1 >= steps.length) { endTour(); return; }
    const next = cur + 1;
    $('#tour').dataset.step = String(next);
    showTourStep(next, steps);
  }

  function endTour() {
    const box = $('#tour');
    if (box) box.classList.add('hidden');
    try { localStorage.setItem(TOUR_KEY, '1'); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // Dashboard — the portfolio at a glance
  // ------------------------------------------------------------------

  const dash = { items: [], busy: false, details: new Map(), focus: null };

  const ICONS = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12.5 12 4l9 8.5"/><path d="M6 11v8h12v-8"/></svg>',
    pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>',
    trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 6H5v2a3 3 0 0 0 3 3M16 6h3v2a3 3 0 0 1-3 3M9 20h6M12 13v7"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L20 8l-4-4L4 16v4Z"/></svg>',
  };

  function dashIcon(name) { return ICONS[name] || ''; }

  function statChip(icon, tone) {
    return `<span class="stat-chip ${tone || ''}">${dashIcon(icon)}</span>`;
  }

  function fmtWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso).slice(0, 16).replace('T', ' ');
    const diff = Date.now() - d.getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' hr ago';
    const days = Math.round(hrs / 24);
    if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function scoreRing(score) {
    if (score === null || score === undefined) {
      return `<div class="score-ring"><svg viewBox="0 0 44 44">
        <circle class="ring-bg" cx="22" cy="22" r="18"></circle></svg>
        <div class="ring-num">&mdash;</div></div>`;
    }
    const pct = Math.max(0, Math.min(100, score));
    const circ = 2 * Math.PI * 18;
    const off = circ * (1 - pct / 100);
    const colour = pct >= 70 ? 'var(--good)' : pct >= 50 ? 'var(--pri)' : 'var(--amber)';
    return `<div class="score-ring">
      <svg viewBox="0 0 44 44">
        <circle class="ring-bg" cx="22" cy="22" r="18"></circle>
        <circle class="ring-fg" cx="22" cy="22" r="18" stroke="${colour}"
          stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"></circle>
      </svg>
      <div class="ring-num">${Math.round(pct)}</div>
    </div>`;
  }

  async function loadDashboard(force) {
    if (dash.busy) return;
    dash.busy = true;
    try {
      const list = await api('/api/scenarios');
      state.scenarioList = list;
      const wanted = list.slice(0, 12).map((s) => s.id);
      for (const s of list.slice(0, 12)) {
        if (!dash.details.has(s.id)) {
          try {
            dash.details.set(s.id, await api('/api/scenarios/' + s.id));
          } catch (e) { dash.details.set(s.id, null); }
        }
      }
      const items = [];
      list.forEach((s) => {
        const detail = dash.details.get(s.id);
        if (!detail || !detail.inputs) return;
        const suburb = state.suburbs.find((x) => x.id === Number(s.suburbId)) || null;
        let res = null;
        try { res = E.calculateAll(detail.inputs, { suburb }); } catch (e) { return; }
        const rawProps = (detail.inputs && detail.inputs.properties) || [];
        (res.properties || []).forEach((p, i) => {
          const raw = rawProps[i] || {};
          const m = p.metrics || {};
          const price = m.purchasePrice || 0;
          const weekly = m.weeklyOutOfPocket;
          const parts = [];
          if (raw.bedrooms) parts.push(`${raw.bedrooms}-bed`);
          if (price) parts.push(fmtMoney(price));
          if (m.grossYield) parts.push(`${fmtPct(m.grossYield, 2)} gross yield`);
          if (weekly !== null && weekly !== undefined) {
            parts.push(`${fmtMoney(Math.abs(weekly))}/wk ${weekly > 0 ? 'out of pocket' : 'in pocket'}`);
          }
          items.push({
            scenarioId: s.id,
            scenarioName: s.name,
            index: i,
            address: raw.address || s.address || s.name,
            suburb: (raw.addressMeta && raw.addressMeta.suburb) || (suburb ? suburb.name : ''),
            price: price,
            grossYield: m.grossYield,
            weekly: weekly,
            equity: m.tenYearEquity,
            score: p.score ? p.score.score : null,
            band: p.score ? p.score.band : '',
            summary: parts.join(' · '),
            updatedAt: s.updatedAt,
            createdAt: s.createdAt,
          });
        });
      });
      dash.items = items;
      renderDashboard(list);
    } catch (e) {
      setPropertyStatus && setPropertyStatus('');
      $('#dash-stats').innerHTML = '';
      $('#dash-activity').innerHTML = `<div class="empty-note">Could not load your portfolio: ${escapeHtml(e.message)}</div>`;
    } finally {
      dash.busy = false;
    }
  }


  function renderPortfolioSnapshot() {
    const root = $('#portfolio-kpis');
    if (!root) return;
    const result = state.result, props = (result && result.properties) || [], inputs = state.inputs || {};
    const roll = state.ownedResult;   // purchased-only portfolio — what roll-ups count
    const metrics = roll && roll.metrics;
    const ownedCount = roll ? roll.properties.length : 0;
    const money = (v) => Number.isFinite(Number(v)) ? fmtMoney(Number(v)) : '—';
    const weekly = metrics ? Number(metrics.weeklyOutOfPocket || 0) : null;
    const annual = weekly === null ? null : weekly * 52;
    const pporValue = Math.max(0, Number(inputs.pporValue) || 0);
    const pporDebt = Math.max(0, Number(inputs.pporLoanBalance) || 0);
    const totalPropertyAssets = (metrics ? Number(metrics.purchasePrice) || 0 : 0) + pporValue;
    const cards = [
      ['Total property assets', money(totalPropertyAssets), pporValue > 0 ? 'Investment properties + PPOR' : 'Investment property portfolio', 'blue'],
      ['Investment debt', metrics ? money(metrics.ipLoanAmount) : '—', 'Investment-property loan exposure', 'violet'],
      ['Cash required upfront', metrics ? money(metrics.initialCashInvested) : '—', 'Deposit and acquisition costs', 'amber'],
      ['Annual after-tax position', annual === null ? '—' : (annual > 0 ? money(annual) + ' out' : money(Math.abs(annual)) + ' surplus'), 'Year one · weekly position × 52', annual === null ? 'neutral' : annual > 0 ? 'warn' : 'good'],
      ['Gross rental yield', metrics ? fmtPct(metrics.grossYield || 0, 2) : '—', 'Combined scenario yield', 'teal'],
      ['10-year projected equity', metrics ? money(metrics.tenYearEquity) : '—', 'Projected equity at year ten', metrics && metrics.tenYearEquity >= 0 ? 'good' : 'bad']
    ];
    root.innerHTML = cards.map(x => '<div class="portfolio-kpi ' + x[3] + '"><div class="portfolio-kpi-label">' + escapeHtml(x[0]) + '</div><div class="portfolio-kpi-value">' + escapeHtml(x[1]) + '</div><div class="portfolio-kpi-note">' + escapeHtml(x[2]) + '</div></div>').join('');
    const context = $('#portfolio-snapshot-context');
    if (context) context.textContent = (inputs.scenarioName || 'Unsaved scenario') +
      (props.length !== ownedCount
        ? ` — ${ownedCount} of ${props.length} counted (purchased only)`
        : '');
    const hero = $('#dashboard-hero-metrics');
    if (hero) {
      const count = ownedCount + (pporValue > 0 ? 1 : 0);
      const investmentDebt = metrics ? Number(metrics.ipLoanAmount) || 0 : 0;
      const firstProjection = roll && roll.rows && roll.rows[0] || {};
      const projectedDebt = Number(firstProjection.totalDebt);
      const totalDebt = Number.isFinite(projectedDebt) ? projectedDebt : investmentDebt + pporDebt;
      const currentEquity = totalPropertyAssets - totalDebt;
      const weeklyLabel = weekly === null ? '—' : (weekly > 0 ? money(weekly) + ' out' : money(Math.abs(weekly)) + ' surplus');
      hero.innerHTML = [
        ['Properties', String(count), pporValue > 0 ? 'Including your home' : 'Investment properties'],
        ['Property assets', money(totalPropertyAssets), 'Entered purchase / home values'],
        ['Total debt', money(totalDebt), 'Investment + home loans'],
        ['Current model equity', money(currentEquity), 'Assets less entered debt'],
        ['Weekly cash position', weeklyLabel, 'Year-one after-tax estimate']
      ].map(item => '<div class="dashboard-hero-stat"><span>' + escapeHtml(item[0]) + '</span><strong>' + escapeHtml(item[1]) + '</strong><small>' + escapeHtml(item[2]) + '</small></div>').join('');
    }

    const gallery = $('#dashboard-property-gallery');
    const propertyCount = $('#dashboard-property-count');
    const portfolioHomes = [];
    if (pporValue > 0) {
      portfolioHomes.push({
        kind: 'PPOR · HOME', label: inputs.pporAddress || 'Principal place of residence',
        location: (inputs.pporAddressMeta && [inputs.pporAddressMeta.suburb, inputs.pporAddressMeta.state].filter(Boolean).join(', ')) || 'Your home',
        value: pporValue, valueLabel: 'Entered home value', debt: pporDebt, equity: pporValue - pporDebt,
        image: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=900&q=82',
        note: 'Representative home image'
      });
    }
    props.forEach((p, i) => {
      const raw = inputs.properties && inputs.properties[i] || {}, m = p.metrics || {};
      const photoSet = [
        'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=900&q=82',
        'https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=900&q=82',
        'https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?auto=format&fit=crop&w=900&q=82',
        'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=900&q=82'
      ];
      portfolioHomes.push({
        kind: 'INVESTMENT PROPERTY', label: raw.label || raw.address || ('Investment property ' + (i + 1)),
        location: (raw.addressMeta && [raw.addressMeta.suburb, raw.addressMeta.state].filter(Boolean).join(', ')) || raw.address || 'Location not added',
        status: p.ownershipStatus || 'considering',
        value: Number(m.purchasePrice || raw.purchasePrice || 0), valueLabel: 'Purchase price',
        debt: Number(m.ipLoanAmount || 0), equity: Number(m.tenYearEquity || 0),
        yield: m.grossYield, cash: m.weeklyOutOfPocket,
        image: photoSet[i % photoSet.length], note: 'Representative property image'
      });
    });
    if (propertyCount) propertyCount.textContent = portfolioHomes.length + (portfolioHomes.length === 1 ? ' property' : ' properties');
    if (gallery) gallery.innerHTML = portfolioHomes.length ? portfolioHomes.map((p, i) =>
      '<article class="dashboard-home-card">' +
        '<div class="dashboard-home-photo"><img src="' + p.image + '" alt="Representative exterior of ' + escapeHtml(p.label) + '" loading="lazy"><span class="dashboard-home-kind">' + escapeHtml(p.kind) + '</span></div>' +
        '<div class="dashboard-home-content"><div class="dashboard-home-title">' + escapeHtml(p.label) +
        (p.status && p.status !== 'purchased' ? ' <span class="status-chip ' + p.status + '">' + STATUS_LABELS[p.status] + '</span>' : '') +
        '</div><div class="dashboard-home-location">' + escapeHtml(p.location) + '</div>' +
        '<div class="dashboard-home-value">' + money(p.value) + '</div><div class="dashboard-home-value-label">' + escapeHtml(p.valueLabel || 'Entered value') + '</div><div class="dashboard-home-stats">' +
        '<span><small>' + (p.kind.startsWith('PPOR') ? 'Mortgage' : 'Loan balance') + '</small><strong>' + money(p.debt) + '</strong></span>' +
        '<span><small>' + (p.kind.startsWith('PPOR') ? 'Current equity' : '10-yr projected equity') + '</small><strong>' + money(p.equity) + '</strong></span>' +
        (p.yield != null ? '<span><small>Gross yield</small><strong>' + fmtPct(p.yield, 2) + '</strong></span>' : (p.cash != null ? '<span><small>Weekly cash flow</small><strong>' + (p.cash > 0 ? '−' : '+') + money(Math.abs(p.cash)) + '</strong></span>' : '')) +
        '</div><div class="dashboard-home-note">' + p.note + '</div></div></article>'
    ).join('') : '<div class="empty-note">Add your PPOR value or an investment property to build your portfolio view.</div>';

    const ranked = props.map((p, i) => {
      const m = p.metrics || {}, raw = inputs.properties && inputs.properties[i] || {};
      return { label: raw.label || raw.address || ('Property ' + (i + 1)), cash: Number(m.year1AfterTaxCashFlow || 0), yield: m.grossYield };
    }).sort((x, y) => y.cash - x.cash);
    const performance = $('#portfolio-performance');
    if (performance) performance.innerHTML = ranked.length ? ranked.map((p, i) =>
      '<div class="performance-row"><span class="performance-rank">' + (i + 1) + '</span><span class="performance-name">' + escapeHtml(p.label) + '</span><span class="performance-yield">' + (p.yield == null ? '—' : fmtPct(p.yield, 2)) + '</span><strong class="' + (p.cash >= 0 ? 'positive' : 'negative') + '">' + (p.cash >= 0 ? '+' : '−') + fmtMoney(Math.abs(p.cash)) + '/yr</strong></div>'
    ).join('') : '<div class="empty-note">Add an investment property to see its performance here.</div>';

    const health = $('#dashboard-health');
    if (health) {
      const lvr = metrics && Number.isFinite(Number(metrics.ipLvrActual)) ? fmtPct(metrics.ipLvrActual, 1) : '—';
      const yieldValue = metrics ? fmtPct(metrics.grossYield || 0, 2) : '—';
      const cashValue = annual === null ? '—' : (annual > 0 ? money(annual) + ' required' : money(Math.abs(annual)) + ' surplus');
      const warningCount = (result && result.warnings || []).length;
      health.innerHTML = '<div class="dashboard-health-head"><strong>Portfolio health &amp; model checks</strong><span>' + (warningCount ? warningCount + ' items to review' : 'No calculation warnings') + '</span></div>' +
        '<div class="dashboard-health-grid">' +
        '<div><small>Investment LVR</small><strong>' + escapeHtml(lvr) + '</strong></div>' +
        '<div><small>Gross rental yield</small><strong>' + escapeHtml(yieldValue) + '</strong></div>' +
        '<div><small>Annual after-tax cash</small><strong>' + escapeHtml(cashValue) + '</strong></div>' +
        '</div>';
    }

    const alerts = $('#portfolio-alerts'), warnings = (result && result.warnings || []).slice(0, 4);
    if (alerts) alerts.innerHTML = warnings.length ? warnings.map(w => '<div class="portfolio-alert"><span class="alert-dot"></span><span>' + escapeHtml(w) + '</span></div>').join('') : '<div class="portfolio-clear"><span>✓</span><div><strong>No calculation warnings</strong><small>Confirm assumptions with your lender and tax adviser before making decisions.</small></div></div>';
  }
  function renderDashboardMarketIntel() {
    const root = $('#dashboard-market-intel');
    if (!root) return;
    const inputs = state.inputs || {};
    const suburb = currentSuburb() || {};
    const section = (heading, items) =>
      '<div class="dashboard-market-group"><div class="dashboard-market-heading">' + escapeHtml(heading) + '</div>' +
      '<div class="dashboard-market-grid">' + items.join('') + '</div></div>';
    const addItem = (label, value, note) =>
      '<div class="dashboard-market-item"><small>' + escapeHtml(label) + '</small><strong>' + escapeHtml(value) + '</strong><span>' + escapeHtml(note || '') + '</span></div>';

    const groups = [];
    (inputs.properties || []).forEach((p, idx) => {
      if (!p || !p.address) return;
      const meta = p.addressMeta || {};
      const lat = numOrNull(meta.lat);
      const lon = numOrNull(meta.lon);
      const items = [];
      if (lat !== null && lon !== null) {
        const key = idx + ':' + lat.toFixed(4) + ',' + lon.toFixed(4);
        const intelData = intel.cache[key];
        const parcel = intelData && intelData.parcel || {};
        if (intelData && intelData.jurisdiction === 'VIC') {
          items.push(addItem('Land parcel area', parcel.areaSqm ? fmtNum(parcel.areaSqm) + ' m²' : 'Not returned', 'Vicmap Property · CC BY 4.0'));
          items.push(addItem('Property reference', parcel.propertyReference || 'Not matched', 'Victorian cadastral record'));
          items.push(addItem('Council reference', parcel.propertyNumber || 'Not available', 'Vicmap property attribute'));
          items.push(addItem('Bushfire prone', bushfireLabel(intelData), 'CFA designated BPA · Victoria'));
        } else if (intelData && parcel) {
          items.push(addItem('Land parcel area', parcel.areaSqm ? fmtNum(parcel.areaSqm) + ' m²' : 'Not returned', 'Queensland Government spatial data'));
          items.push(addItem('Lot / plan', parcel.lotPlan || 'Not returned', 'Queensland cadastral record'));
          items.push(addItem('Local government', parcel.lga || 'Not returned', 'Queensland Government'));
        } else if (intelData) {
          items.push(addItem('Property parcel', 'Not matched', 'No parcel at this coordinate'));
        } else if (intel.loadErrors[key]) {
          items.push(addItem('Property parcel', 'Unavailable', intel.loadErrors[key]));
        } else {
          items.push(addItem('Property parcel', 'Loading…', 'Address coordinates available'));
          loadDashboardPropertyIntel(p, key);
        }
      } else {
        const sub = currentSuburb();
        items.push(addItem('Property parcel', 'Address needed',
          sub ? 'Not confirmed yet — the Property page shows ' + sub.name + ' suburb data meanwhile'
              : 'Pick the address from the dropdown in Inputs so it can be located'));
      }
      groups.push(section(ipLabel(p, idx) + (meta.suburb ? ' · ' + meta.suburb : ''), items));
    });

    const suburbItems = [];
    if (!suburb.name) suburbItems.push(addItem('Suburb reference', 'Not set', 'Pick the suburb in Inputs to attach market data'));
    if (suburb.medianPrice != null) suburbItems.push(addItem('Suburb median sale', fmtMoney(suburb.medianPrice), sourceNote(suburb, 'medianPrice') || 'Saved suburb reference data'));
    if (suburb.medianRent3Bed != null) suburbItems.push(addItem('3-bed median rent', fmtMoney(suburb.medianRent3Bed) + '/wk', sourceNote(suburb, 'medianRent3Bed') || 'Saved suburb reference data'));
    if (suburb.medianRent4Bed != null) suburbItems.push(addItem('4-bed median rent', fmtMoney(suburb.medianRent4Bed) + '/wk', sourceNote(suburb, 'medianRent4Bed') || 'Saved suburb reference data'));
    if (suburb.vacancyPct != null) suburbItems.push(addItem('Vacancy rate', Number(suburb.vacancyPct).toFixed(1) + '%', sourceNote(suburb, 'vacancyPct') || 'Saved suburb reference data'));
    if (suburb.growth5yrPct != null) suburbItems.push(addItem('5-year price growth', Number(suburb.growth5yrPct).toFixed(1) + '%', sourceNote(suburb, 'growth5yrPct') || 'Saved suburb reference data'));
    if (suburbItems.length) groups.push(section('Suburb reference · ' + (suburb.name || 'none selected'), suburbItems));

    root.innerHTML = groups.length
      ? groups.join('')
      : '<div class="empty-note">No property or suburb intelligence is available yet. Add a located address and suburb market data.</div>';
  }

  function loadDashboardPropertyIntel(property, key) {
    if (!property || !property.addressMeta || !key || intel.loadingKeys.has(key)) return;
    const meta = property.addressMeta;
    const lat = numOrNull(meta.lat), lon = numOrNull(meta.lon);
    if (lat === null || lon === null) return;
    intel.loadingKeys.add(key);
    const jurisdiction = String(meta.state || state.inputs.state || '').toUpperCase()
      .replace('VICTORIA', 'VIC').replace('QUEENSLAND', 'QLD');
    api(intelEndpoint(jurisdiction) + 'lat=' + lat + '&lon=' + lon)
      .then((data) => {
        intel.cache[key] = data;
        delete intel.loadErrors[key];
        renderDashboardMarketIntel();
        if (propertySectionVisible()) renderProperty();
      })
      .catch((err) => {
        intel.loadErrors[key] = err.message;
        renderDashboardMarketIntel();
      })
      .finally(() => { intel.loadingKeys.delete(key); });
  }

  // Focus slot — drag a research card here (or hit Focus) to feature it.
  function dashFocusItem() {
    const f = dash.focus;
    if (!f) return null;
    return dash.items.find((x) =>
      String(x.scenarioId) === String(f.scenarioId) && Number(x.index) === Number(f.index)) || null;
  }

  function renderDashFocus() {
    const el = $('#dash-focus');
    if (!el) return;
    const it = dashFocusItem();
    if (dash.focus && !it) { dash.focus = null; localStorage.removeItem('pa_dash_focus'); }
    syncFocusCardClasses();
    if (!it) {
      el.classList.remove('is-set');
      el.innerHTML = '<div class="dash-focus-empty">Drag a property here — or hit <b>Focus</b> on a card — to feature it.</div>';
      return;
    }
    el.classList.add('is-set');
    el.innerHTML = `
      <div class="dash-focus-head">
        <span class="prop-pin">${dashIcon('pin')}</span>
        <div class="dash-focus-title">
          <div class="prop-addr">${escapeHtml(it.address || it.scenarioName)}</div>
          <div class="prop-sub">${escapeHtml([it.suburb, it.scenarioName].filter(Boolean).join(' · '))}</div>
        </div>
        <button class="icon-btn" data-dash-focus-clear title="Clear focus">&times;</button>
      </div>
      <div class="dash-focus-body">
        ${scoreRing(it.score)}
        <div class="prop-stats">
          <div class="prop-stat"><div class="k">Purchase price</div><div class="v">${fmtMoney(it.price)}</div></div>
          <div class="prop-stat"><div class="k">Gross yield</div><div class="v">${it.grossYield === null || it.grossYield === undefined ? '—' : fmtPct(it.grossYield, 2)}</div></div>
          <div class="prop-stat"><div class="k">Weekly position</div><div class="v">${it.weekly === null || it.weekly === undefined ? '—' : (it.weekly > 0 ? 'Out of pocket ' + fmtMoney(it.weekly) : it.weekly < 0 ? 'Surplus ' + fmtMoney(Math.abs(it.weekly)) : 'Break-even')}</div></div>
          <div class="prop-stat"><div class="k">10-yr equity</div><div class="v">${it.equity === null || it.equity === undefined ? '—' : fmtMoney(it.equity)}</div></div>
        </div>
        <div class="prop-card-actions">
          <button data-dash-load="${it.scenarioId}">Open</button>
          <button class="primary" data-dash-property="${it.scenarioId}" data-dash-index="${it.index}">Analyse</button>
        </div>
      </div>`;
  }

  function setDashFocus(sid, idx) {
    const it = dash.items.find((x) =>
      String(x.scenarioId) === String(sid) && Number(x.index) === Number(idx));
    if (!it) { toast('That property is no longer in your research list'); return; }
    dash.focus = { scenarioId: it.scenarioId, index: it.index };
    localStorage.setItem('pa_dash_focus', JSON.stringify(dash.focus));
    renderDashFocus();
  }

  function clearDashFocus() {
    dash.focus = null;
    localStorage.removeItem('pa_dash_focus');
    renderDashFocus();
  }

  function syncFocusCardClasses() {
    document.querySelectorAll('#dash-props .prop-card').forEach((card) => {
      const on = dash.focus
        && String(card.dataset.dragScenario) === String(dash.focus.scenarioId)
        && Number(card.dataset.dragIndex) === Number(dash.focus.index);
      card.classList.toggle('is-focused', !!on);
    });
  }

  function renderDashboard(list) {
    if (!dash.focus) {
      try {
        const f = JSON.parse(localStorage.getItem('pa_dash_focus') || 'null');
        if (f && f.scenarioId !== undefined && f.index !== undefined) dash.focus = f;
      } catch (e) { dash.focus = null; }
    }
    const items = dash.items;
    const scored = items.filter((i) => i.score !== null && i.score !== undefined);
    const avg = scored.length
      ? scored.reduce((s, i) => s + i.score, 0) / scored.length : null;
    const best = scored.length
      ? scored.reduce((a, b) => (b.score > a.score ? b : a)) : null;
    const week = Date.now() - 7 * 86400000;
    const thisWeek = items.filter((i) => new Date(i.updatedAt || i.createdAt || 0).getTime() > week).length;
    const cur = state.result ? state.result.metrics : null;
    const curProps = (state.result && state.result.properties) || [];
    const portfolioValue = curProps.reduce((s, p) => s + ((p.metrics && p.metrics.purchasePrice) || 0), 0);
    const avgYield = curProps.length
      ? curProps.reduce((s, p) => s + ((p.metrics && p.metrics.grossYield) || 0), 0) / curProps.length : 0;

    const stats = [
      {
        label: 'Properties analysed',
        icon: 'home',
        value: String(items.length),
        foot: thisWeek
          ? `+${thisWeek} this week`
          : (items.length ? 'Active research phase' : 'Nothing analysed yet'),
        footGood: thisWeek > 0,
      },
      {
        label: 'Avg investment score',
        icon: 'pulse',
        value: avg === null ? '—' : String(Math.round(avg)),
        bar: avg === null ? null : avg,
        foot: avg === null ? 'Needs suburb data to score' : (items.length ? 'across ' + scored.length + ' scored' : ''),
      },
      {
        label: 'Best score',
        icon: 'trophy',
        value: best ? best.score.toFixed(1) : '—',
        valueClass: best ? 'amber' : '',
        pill: best ? 'TOP' : '',
        foot: best ? best.address : 'No scored properties yet',
      },
      {
        label: 'Purchase value',
        icon: 'calendar',
        value: cur ? fmtMoney(portfolioValue) : '—',
        foot: cur
          ? `${curProps.length} propert${curProps.length === 1 ? 'y' : 'ies'} · avg yield ${fmtPct(avgYield, 2)}`
          : 'Current scenario purchase total',
      },
    ];

    $('#dash-stats').innerHTML = stats.map((s) => `
      <div class="stat-card">
        ${statChip(s.icon, s.label === 'Best score' ? 'amber' : s.label === 'Purchase value' ? 'blue' : s.label === 'Avg investment score' ? 'green' : '')}
        <div class="stat-label">${escapeHtml(s.label)}</div>
        <div class="stat-value ${s.valueClass || ''}">${escapeHtml(s.value)}${s.pill ? ` <span class="pill">${s.pill}</span>` : ''}</div>
        ${s.bar !== null && s.bar !== undefined
          ? `<div class="stat-bar"><span style="width:${Math.max(2, Math.min(100, s.bar))}%"></span></div>` : ''}
        <div class="stat-foot">${escapeHtml(s.foot)}</div>
      </div>`).join('');

    // ---- recent activity ----
    const activity = (list || []).slice(0, 6).map((s) => {
      const created = s.createdAt && s.updatedAt && s.createdAt === s.updatedAt;
      return `<div class="activity-row">
        <span class="activity-icon">${dashIcon(created ? 'home' : 'edit')}</span>
        <span class="activity-text">
          <span class="activity-title"><a data-dash-load="${s.id}">${created ? 'Added' : 'Updated'} ${escapeHtml(s.address || s.name)}</a></span>
          <span class="activity-time">${escapeHtml(fmtWhen(s.updatedAt || s.createdAt))} · ${escapeHtml(s.name)}</span>
        </span>
      </div>`;
    }).join('');
    $('#dash-activity').innerHTML = activity
      || '<div class="empty-note">No saved properties yet — set one up in Inputs and hit Save.</div>';

    // ---- property cards ----
    $('#dash-props').innerHTML = items.map((it, i) => `
      <div class="prop-card" draggable="true" data-drag-scenario="${it.scenarioId}" data-drag-index="${it.index}">
        <div class="prop-hero ${i % 3 === 1 ? 'alt' : i % 3 === 2 ? 'deep' : ''}">
          <span class="prop-pin">${dashIcon('pin')}</span>
          <div class="prop-addr">${escapeHtml(it.address || it.scenarioName)}</div>
          <div class="prop-sub">${escapeHtml([it.suburb, it.scenarioName].filter(Boolean).join(' · '))}</div>
        </div>
        <div class="prop-body">
          <div class="prop-score-row">
            ${scoreRing(it.score)}
            <div>
              <div class="score-band">${escapeHtml(it.band || 'Not scored')}</div>
              <div class="score-band-sub">Investment score · ${escapeHtml(fmtWhen(it.updatedAt || it.createdAt))}</div>
            </div>
          </div>
          <div class="prop-summary">${escapeHtml(it.summary || '')}</div>
          <div class="prop-stats">
            <div class="prop-stat"><div class="k">Purchase price</div><div class="v">${fmtMoney(it.price)}</div></div>
            <div class="prop-stat"><div class="k">Gross yield</div><div class="v">${it.grossYield === null || it.grossYield === undefined ? '—' : fmtPct(it.grossYield, 2)}</div></div>
            <div class="prop-stat"><div class="k">Weekly position</div><div class="v">${it.weekly === null || it.weekly === undefined ? '—' : (it.weekly > 0 ? 'Out of pocket ' + fmtMoney(it.weekly) : it.weekly < 0 ? 'Surplus ' + fmtMoney(Math.abs(it.weekly)) : 'Break-even')}</div></div>
            <div class="prop-stat"><div class="k">10-yr equity</div><div class="v">${it.equity === null || it.equity === undefined ? '—' : fmtMoney(it.equity)}</div></div>
          </div>
          <div class="prop-card-actions">
            <button data-dash-load="${it.scenarioId}">Open</button>
            <button data-dash-focus="${it.scenarioId}" data-dash-index="${it.index}">Focus</button>
            <button class="primary" data-dash-property="${it.scenarioId}" data-dash-index="${it.index}">Analyse</button>
          </div>
        </div>
      </div>`).join('')
      || `<div class="empty-note">No properties analysed yet. Add one in <b>Inputs</b> and save it — it will show up here with its score.</div>`;

    // ---- score distribution ----
    const bins = [
      { label: '0-40', min: -0.01, max: 40 },
      { label: '41-60', min: 40, max: 60 },
      { label: '61-80', min: 60, max: 80 },
      { label: '81-100', min: 80, max: 100.01 },
    ];
    const counts = bins.map((b) => scored.filter((s) => s.score > b.min && s.score <= b.max).length);
    drawChart('chart-dash-scores', {
      type: 'bar',
      data: {
        labels: bins.map((b) => b.label),
        datasets: [{
          label: 'Properties',
          data: counts,
          backgroundColor: bins.map((_, i) => [COLORS.red, COLORS.amber, COLORS.pri, COLORS.green][i]),
          borderRadius: 6,
          maxBarThickness: 72,
        }],
      },
      options: baseOpts((v) => fmtNum(v)),
    });
    renderDashFocus();
    renderPortfolioSnapshot();
  }

  function wireDashboard() {
    const periodControl = $('#dashboard-period');
    if (periodControl) periodControl.addEventListener('change', () => {
      dashboardProjectionYears = Math.max(1, Number(periodControl.value) || 20);
      if (state.result) renderOverview();
    });
    const refresh = $('#dash-refresh');
    if (refresh) refresh.addEventListener('click', () => loadDashboard(true));
    const openInputs = () => {
      const a = document.querySelector('#nav a[data-target="inputs"]');
      if (a) a.click();
      const ip = $('#address-input');
      if (ip) setTimeout(() => ip.focus(), 250);
    };
    ['#dash-add', '#dash-add-inline'].forEach((selector) => {
      const add = $(selector);
      if (add) add.addEventListener('click', openInputs);
    });
    const propertyIntelBtn = $('#dash-property-intel');
    if (propertyIntelBtn) propertyIntelBtn.addEventListener('click', () => {
      const a = document.querySelector('#nav a[data-target="property"]');
      if (a) a.click();
    });
    const scenarios = $('#dash-scenarios');
    if (scenarios) scenarios.addEventListener('click', () => {
      const a = document.querySelector('#nav a[data-target="scenarios"]');
      if (a) a.click();
    });
    document.addEventListener('click', (ev) => {
      const open = ev.target.closest('[data-dash-load]');
      if (open) {
        loadScenario(Number(open.dataset.dashLoad));
        return;
      }
      const an = ev.target.closest('[data-dash-property]');
      if (an) {
        loadScenario(Number(an.dataset.dashProperty)).then(() => {
          const idx = Number(an.dataset.dashIndex) || 0;
          if (Number.isInteger(idx) && state.inputs.properties[idx]) {
            state.inputTab = idx;
            setActiveTab(idx);
          }
          const a = document.querySelector('#nav a[data-target="property"]');
          if (a) a.click();
        });
        return;
      }
      const foc = ev.target.closest('[data-dash-focus]');
      if (foc) { setDashFocus(foc.dataset.dashFocus, foc.dataset.dashIndex); return; }
      if (ev.target.closest('[data-dash-focus-clear]')) { clearDashFocus(); return; }
    });

    // Focus-slot drag & drop (native HTML5 DnD, no library).
    document.addEventListener('dragstart', (ev) => {
      const card = ev.target.closest ? ev.target.closest('.prop-card[data-drag-scenario]') : null;
      if (!card) return;
      ev.dataTransfer.setData('text/plain', card.dataset.dragScenario + ':' + card.dataset.dragIndex);
      ev.dataTransfer.effectAllowed = 'copy';
      card.classList.add('dragging');
    });
    document.addEventListener('dragend', () => {
      document.querySelectorAll('.prop-card.dragging').forEach((c) => c.classList.remove('dragging'));
    });
    const focusZone = $('#dash-focus');
    if (focusZone) {
      focusZone.addEventListener('dragover', (ev) => { ev.preventDefault(); focusZone.classList.add('drop-hover'); });
      focusZone.addEventListener('dragleave', () => focusZone.classList.remove('drop-hover'));
      focusZone.addEventListener('drop', (ev) => {
        ev.preventDefault();
        focusZone.classList.remove('drop-hover');
        const parts = String(ev.dataTransfer.getData('text/plain') || '').split(':');
        if (parts[0]) setDashFocus(parts[0], parts[1] === undefined ? 0 : parts[1]);
      });
    }
  }

  // ------------------------------------------------------------------
  // Property intelligence — live Queensland open data (see qld_intel.py)
  // ------------------------------------------------------------------

  const INTEL_BASEMAPS = {
    sat: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    },
    topo: {
      url: 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Basemaps/QldMap_Topo/MapServer/tile/{z}/{y}/{x}',
      attribution: '&copy; Queensland Government spatial information',
    },
  };
  const BUSHFIRE_TILES =
    'https://tiles.arcgis.com/tiles/vkTwD8kHw2woKBqV/arcgis/rest/services/Bushfire_Prone_Areas/MapServer/tile/{z}/{y}/{x}';

  const intel = {
    cache: {},      // cache key -> payload
    loadingKeys: new Set(),
    loadErrors: {}, // cache key -> last error message
    map: null,
    base: null,     // current basemap tile layer
    bushfire: null, // QLD bushfire-prone tile layer
    bushfireVic: null, // VIC bushfire-prone WMS layer
    bushfireKind: null, // 'qld' | 'vic' — which layer the chip toggles
    parcel: null,   // layer group: parcel outline
    flood: null,    // layer group: flood study extent
    marker: null,   // circle marker
    overlays: { parcel: true, bushfire: false, flood: false },
    seq: 0,
  };

  // The chip toggles whichever bushfire layer matches the property's state.
  function bushfireLayer() {
    if (!window.L) return null;
    if (intel.bushfireKind === 'vic') {
      if (!intel.bushfireVic) {
        intel.bushfireVic = L.tileLayer.wms(
          'https://opendata.maps.vic.gov.au/geoserver/wms', {
            layers: 'open-data-platform:bushfire_prone_area',
            format: 'image/png8', transparent: true, opacity: 0.45, maxZoom: 19,
          });
      }
      return intel.bushfireVic;
    }
    if (intel.bushfireKind === 'wa') {
      if (!intel.bushfireWa) {
        intel.bushfireWa = arcgisDynamic(
          'https://services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Bush_Fire_Prone_Areas/MapServer',
          { opacity: 0.45 });
      }
      return intel.bushfireWa;
    }
    if (intel.bushfireKind === 'nsw') {
      if (!intel.bushfireNsw) {
        intel.bushfireNsw = arcgisDynamic(
          'https://portal.spatial.nsw.gov.au/server/rest/services/Hosted/NSW_BushFire_Prone_Land/MapServer',
          { opacity: 0.45 });
      }
      return intel.bushfireNsw;
    }
    if (!intel.bushfire) {
      intel.bushfire = L.tileLayer(BUSHFIRE_TILES, { maxZoom: 19, opacity: 0.45 });
    }
    return intel.bushfire;
  }

  // TAS/VIC flood overlays are state tile layers; QLD uses the intel.flood
  // group of study polygons, so a null here means "use the group".
  function floodLayer() {
    if (!window.L) return null;
    if (intel.floodKind === 'vic') {
      if (!intel.floodVic) {
        intel.floodVic = wmsLayer('https://opendata.maps.vic.gov.au/geoserver/wms',
          'open-data-platform:vic_flood_history_public', { opacity: 0.55 });
      }
      return intel.floodVic;
    }
    if (intel.floodKind === 'tas') {
      if (!intel.floodTas) {
        intel.floodTas = arcgisDynamic(
          'https://services.thelist.tas.gov.au/arcgis/rest/services/Public/SES_FloodMapping/MapServer',
          { layers: 'show:10', opacity: 0.55 });
      }
      return intel.floodTas;
    }
    return null;
  }

  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function activePropertyIndex() {
    return Number.isInteger(state.inputTab) ? state.inputTab : 0;
  }

  function propertySectionVisible() {
    const el = document.querySelector('#section-property');
    return !!el && el.classList.contains('active');
  }

  function setPropertyStatus(text) {
    const el = $('#property-status');
    if (el) el.textContent = text || '';
  }

  // ArcGIS rings are clockwise; GeoJSON wants counter-clockwise outer rings.
  function esriPolygonToGeoJSON(geom) {
    if (!geom || !geom.rings || !geom.rings.length) return null;
    const rings = geom.rings.map((r) => r.map(([x, y]) => [x, y]).reverse());
    return { type: 'Polygon', coordinates: rings };
  }

  // ------------------------------------------------------------------
  // Property documents — due-diligence files shared with clients
  // ------------------------------------------------------------------

  function fmtBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  async function loadDocs() {
    const list = $('#doc-list');
    if (!list) return;
    if (!state.scenarioId) {
      list.innerHTML = '<div class="source-note">Save the scenario first — documents attach to a saved property.</div>';
      return;
    }
    try {
      const docs = await api(`/api/scenarios/${state.scenarioId}/attachments`);
      renderDocs(docs);
    } catch (err) {
      list.innerHTML = '<div class="source-note">Could not load documents: ' + escapeHtml(err.message) + '</div>';
    }
  }

  function renderDocs(docs) {
    const list = $('#doc-list');
    if (!list) return;
    list.innerHTML = (docs || []).length ? docs.map((d) => `
      <div class="doc-row">
        <a href="/api/attachments/${d.id}/file" target="_blank" rel="noopener">${escapeHtml(d.displayName)}</a>
        <span class="source-note">${fmtBytes(d.bytes)}</span>
        <button data-doc-del="${d.id}" class="danger" title="Remove this document">Remove</button>
      </div>`).join('')
      : '<div class="source-note">No documents yet — clients see everything listed here on their shared link.</div>';
  }

  $('#doc-add').addEventListener('click', () => {
    if (!state.scenarioId) { toast('Save the scenario first'); return; }
    $('#doc-file').click();
  });

  $('#doc-file').addEventListener('change', async () => {
    const files = [...$('#doc-file').files];
    $('#doc-file').value = '';
    if (!files.length) return;
    if (!state.scenarioId) { toast('Save the scenario first'); return; }
    let uploaded = 0;
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f);
      try {
        const resp = await fetch(`/api/scenarios/${state.scenarioId}/attachments`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + getToken() },
          body: fd,
        });
        const body = await resp.json();
        if (!body.ok) throw new Error(body.error || 'upload failed');
        renderDocs(body.data);
        uploaded += 1;
      } catch (err) {
        $('#doc-msg').textContent = `${f.name}: ${err.message}`;
        toast(`Could not upload ${f.name}: ${err.message}`);
      }
    }
    if (uploaded) {
      $('#doc-msg').textContent = `Uploaded ${uploaded} document${uploaded === 1 ? '' : 's'} — visible on existing client links`;
      toast('Documents uploaded');
    }
  });

  $('#doc-list').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-doc-del]');
    if (!btn) return;
    if (!confirm('Remove this document? Clients will no longer see it.')) return;
    try {
      await api('/api/attachments/' + btn.dataset.docDel, { method: 'DELETE' });
      loadDocs();
      toast('Document removed');
    } catch (err) { toast('Error: ' + err.message); }
  });

  // Suburb reference cards reuse the Area page's saved suburb data so a
  // not-yet-confirmed property still shows real market context.
  function suburbReferenceCards(suburb) {
    const items = [
      ['Suburb', suburb.name + (suburb.postcode ? ' ' + suburb.postcode : ''),
        'Saved suburb reference data'],
      ['Median sale', suburb.medianPrice != null ? fmtMoney(suburb.medianPrice) : null,
        sourceNote(suburb, 'medianPrice') || 'Saved suburb reference data'],
      ['3-bed median rent', suburb.medianRent3Bed != null
        ? fmtMoney(suburb.medianRent3Bed) + '/wk' : null,
        sourceNote(suburb, 'medianRent3Bed') || 'Saved suburb reference data'],
      ['4-bed median rent', suburb.medianRent4Bed != null
        ? fmtMoney(suburb.medianRent4Bed) + '/wk' : null,
        sourceNote(suburb, 'medianRent4Bed') || 'Saved suburb reference data'],
      ['Vacancy rate', suburb.vacancyPct != null
        ? Number(suburb.vacancyPct).toFixed(1) + '%' : null,
        sourceNote(suburb, 'vacancyPct') || 'Saved suburb reference data'],
      ['5-year growth', suburb.growth5yrPct != null
        ? Number(suburb.growth5yrPct).toFixed(1) + '%' : null,
        sourceNote(suburb, 'growth5yrPct') || 'Saved suburb reference data'],
    ].filter((i) => i[1] !== null);
    return items.map(([l, v, s]) => card(l, escapeHtml(v), escapeHtml(s))).join('');
  }

  // VIC Valuer-General sold medians (free data; other states are paid
  // products). Shows a clearly-labelled suburb-median guide next to the
  // parcel cards — works before AND after the address is confirmed.
  const valGuideCache = {};

  async function loadValuationGuide(meta) {
    const el = $('#valuation-guide');
    if (!el) return;
    const suburb = String((meta && meta.suburb) || '').trim();
    const st = String((meta && meta.state) || state.inputs.state || '').toUpperCase();
    const postcode = String((meta && meta.postcode) || '').trim();
    if (!suburb || !st) { el.innerHTML = ''; return; }
    const key = st + ':' + suburb.toLowerCase() + ':' + postcode;
    if (valGuideCache[key] === undefined) {
      try {
        valGuideCache[key] = await api('/api/valuation?suburb='
          + encodeURIComponent(suburb) + '&state=' + st
          + (postcode ? '&postcode=' + encodeURIComponent(postcode) : ''));
      } catch (err) { valGuideCache[key] = null; }
    }
    const d = valGuideCache[key];
    if (!d || !d.available || !d.latest) { el.innerHTML = ''; return; }
    const l = d.latest, g = d.guide;
    const hasSeries = Object.keys(d.series || {}).length > 0;
    const medianLabel = hasSeries
      ? 'Sold median — ' + escapeHtml(l.dwellingType || 'houses')
      : 'Median — suburb record';
    const sourceLabel = escapeHtml((l.period || '') + ' · '
      + (d.source || (hasSeries ? 'VIC Valuer-General' : 'suburb record — refresh with AI suburb evidence')));
    el.innerHTML = '<div class="cards">'
      + card(medianLabel, fmtMoney(l.median), sourceLabel)
      + (g ? card('Indicative range', fmtMoney(g.low) + ' – ' + fmtMoney(g.high),
                  'Suburb median ±10% — a guide, not a valuation') : '')
      + '</div>';
  }

  // QLD intel endpoint doubles as the default for unset states; the six
  // remaining jurisdictions route to state_intel.
  function intelEndpoint(jurisdiction) {
    if (jurisdiction === 'VIC') return '/api/intel/vic-property';
    if (!jurisdiction || jurisdiction === 'QLD') return '/api/intel/property';
    return '/api/intel/state-property?state=' + encodeURIComponent(jurisdiction) + '&';
  }

  function renderProperty() {
    const idx = activePropertyIndex();
    const p = state.inputs.properties[idx];
    if (!p) return;
    loadDocs();
    const meta = p.addressMeta || {};
    const lat = numOrNull(meta.lat);
    const lon = numOrNull(meta.lon);

    const mapWrap = $('#section-property .prop-map-wrap');
    if (mapWrap) mapWrap.classList.toggle('is-unlocated', lat === null || lon === null);
    loadValuationGuide(meta);
    if (lat === null || lon === null) {
      // Not confirmed yet — don't blank the page. Suburb-level reference
      // data shows until the parcel lookup can run.
      const suburb = currentSuburb();
      setPropertyStatus(p.address
        ? (suburb
          ? 'Suburb view — showing ' + suburb.name + ' reference data until this address is confirmed. Pick it from the dropdown in Inputs (or type the full address and click away) to load the parcel.'
          : 'No map coordinates for this address — pick it from the dropdown in Inputs (or type the full address and click away) so we can locate the parcel.')
        : 'No address yet. Add one in Inputs — suburb reference data shows meanwhile.');
      $('#property-cards').innerHTML = suburb ? suburbReferenceCards(suburb) : '';
      $('#property-details').innerHTML = suburb
        ? '<div class="note">Suburb-level data for ' + escapeHtml(suburb.name)
          + ' — parcel, land-use and flood detail load once the address is confirmed.</div>'
        : '';
      $('#property-sources').innerHTML = '';
      clearIntelMap();
      return;
    }

    const key = idx + ':' + lat.toFixed(4) + ',' + lon.toFixed(4);
    if (intel.cache[key]) {
      renderIntel(intel.cache[key]);
      return;
    }

    const jurisdiction = String(meta.state || state.inputs.state || '').toUpperCase()
      .replace('VICTORIA', 'VIC').replace('QUEENSLAND', 'QLD');
    setPropertyStatus(jurisdiction === 'VIC' ? 'Loading Victorian Government property data…'
      : (!jurisdiction || jurisdiction === 'QLD') ? 'Loading live Queensland data…'
      : `Loading ${jurisdiction} Government property data…`);
    const seq = ++intel.seq;
    api(intelEndpoint(jurisdiction) + 'lat=' + lat + '&lon=' + lon)
      .then((d) => {
        if (seq !== intel.seq) return;
        const keys = Object.keys(intel.cache);
        if (keys.length > 20) delete intel.cache[keys[0]];
        intel.cache[key] = d;
        renderIntel(d);
      })
      .catch((err) => {
        if (seq !== intel.seq) return;
        if (jurisdiction !== 'VIC' && jurisdiction !== 'QLD'
            && /not found|bad JSON/.test(err.message)) {
          // new frontend + old server process: state-property route missing
          setPropertyStatus(`${jurisdiction} intelligence needs a server restart to activate — restart the Flask app and reload.`);
          return;
        }
        setPropertyStatus('Could not load property data: ' + err.message);
      });
  }

  function clearIntelMap() {
    if (!intel.map) return;
    [intel.parcel, intel.flood].forEach((grp) => {
      if (grp) grp.clearLayers();
    });
    if (intel.marker) {
      intel.map.removeLayer(intel.marker);
      intel.marker = null;
    }
  }

  function intelCard(label, value, sub, cls) {
    return card(label, escapeHtml(value), sub ? escapeHtml(sub) : '', cls);
  }

  function bushfireLabel(d) {
    const b = d && d.bushfire;
    if (!b || b.prone === null || b.prone === undefined) return 'Unknown';
    return b.prone ? 'Yes — designated BPA' : 'No';
  }

  function renderVicIntel(d) {
    intel.bushfireKind = 'vic';
    intel.floodKind = 'vic';
    const topoEl = $('#prop-base-topo');
    if (topoEl) topoEl.classList.add('hidden');
    const bfChip = $('#prop-ov-bushfire');
    if (bfChip) {
      bfChip.classList.remove('hidden');
      bfChip.textContent = 'Bushfire prone (VIC)';
    }
    const flChip = $('#prop-ov-flood');
    if (flChip) {
      flChip.classList.remove('hidden');
      flChip.textContent = 'Flood history (VIC)';
    }
    const p = d.parcel || {};
    const area = p.areaSqm ? fmtNum(p.areaSqm) + ' m²' : 'Not available';
    $('#property-cards').innerHTML = [
      intelCard('Land parcel area', area, 'Vicmap cadastral polygon area'),
      intelCard('Property reference', p.propertyReference || 'Not found', 'Vicmap property feature identifier'),
      intelCard('Council reference', p.propertyNumber || '—', p.councilCode ? 'Council code ' + p.councilCode : ''),
      intelCard('Property type code', p.propertyTypeCode || '—', 'Raw Vicmap classification code'),
      intelCard('Multi-assessment', p.multiAssessment || '—', 'Vicmap property attribute'),
      intelCard('Parcel status', p.statusCode || '—', 'Vicmap status code'),
      intelCard('Bushfire prone area', bushfireLabel(d), 'CFA designated BPA · toggle the map overlay'),
    ].join('');
    const rows = [];
    const row = (k, v) => { if (v !== null && v !== undefined && v !== '') rows.push('<div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(String(v)) + '</div>'); };
    row('Property reference (PFI)', p.propertyReference);
    row('Property unique feature identifier', p.propertyUfi);
    row('Council property number', p.propertyNumber);
    row('Council code', p.councilCode);
    row('Property type code', p.propertyTypeCode);
    row('Multi-assessment flag', p.multiAssessment);
    row('Status code', p.statusCode);
    row('Parcel area', p.areaSqm == null ? null : fmtNum(p.areaSqm) + ' m²');
    $('#property-details').innerHTML = rows.length ? '<div class="kv">' + rows.join('') + '</div>' : '<div class="empty-note">No parcel attributes were returned for this point.</div>';
    const shown = state.inputs.properties[activePropertyIndex()] || {};
    setPropertyStatus((shown.address ? shown.address + ' · ' : '') + 'Vicmap Property · CC BY 4.0 · fetched ' + String(d.fetchedAt || '').replace('T', ' ').slice(0, 16) + (p.propertyReference ? '' : ' · no parcel match at this coordinate'));
    $('#property-sources').innerHTML = 'Source: ' + (d.sources || []).map((s) => '<a href="' + escapeHtml(s.url) + '" target="_blank" rel="noopener">' + escapeHtml(s.label) + '</a> · ' + escapeHtml(s.licence || '')).join(' · ');
    renderIntelMap(d);
  }

  const STATE_INTEL_JURISDICTIONS = new Set(['NSW', 'ACT', 'TAS', 'WA', 'SA', 'NT']);

  // Generic renderer for the six state_intel jurisdictions. Parcel cards
  // from the normalized {id, areaSqm, locality, extra} shape, bushfire chip
  // only for WA, flood/topo chips hidden (QLD-only layers).
  function renderStateIntel(d) {
    const p = d.parcel || {};
    const cards = [
      intelCard('Parcel', p.id || 'Boundary only — no public attributes', d.provider || ''),
      intelCard('Land area', p.areaSqm ? fmtNum(p.areaSqm) + ' m²' : '—',
        'Cadastral polygon area'),
    ];
    if (d.zoning) {
      const z = d.zoning;
      cards.push(intelCard('Zoning', [z.category, z.name].filter(Boolean).join(' — ') || '—',
        (z.licence || 'State zoning overlay') + ' · planning scheme'));
    }
    if (p.locality) {
      cards.push(intelCard('Location', p.locality, 'Cadastral record address/locality'));
    }
    if (d.bushfire) {
      intel.bushfireKind = String(d.jurisdiction).toLowerCase();
      // ACT has the point check but no tileable layer — card only, no chip.
      const hasBfTiles = d.jurisdiction === 'NSW' || d.jurisdiction === 'WA';
      const bfChip = $('#prop-ov-bushfire');
      if (bfChip) {
        bfChip.classList.toggle('hidden', !hasBfTiles);
        if (hasBfTiles) bfChip.textContent = `Bushfire prone (${d.jurisdiction})`;
      }
      cards.push(intelCard('Bushfire prone area', bushfireLabel(d),
        `${d.bushfire.layer || 'Designated bushfire-prone layer'}${hasBfTiles ? ' · toggle the map overlay' : ''}`));
    } else {
      const bfChip = $('#prop-ov-bushfire');
      if (bfChip) bfChip.classList.add('hidden');
    }
    if (d.flood) {
      intel.floodKind = 'tas';
      const flChip = $('#prop-ov-flood');
      if (flChip) {
        flChip.classList.remove('hidden');
        flChip.textContent = 'Flood mapping (TAS)';
      }
      cards.push(intelCard('Flood hazard mapping',
        d.flood.prone ? 'Yes — mapped 1% AEP riverine hazard' : 'Not in mapped hazard',
        `${d.flood.layer || 'SES flood mapping'} · toggle the map overlay`));
    } else if (d.jurisdiction === 'TAS') {
      // SES flood layers are rasters: overlay-only, no point-query card.
      intel.floodKind = 'tas';
      const flChip = $('#prop-ov-flood');
      if (flChip) {
        flChip.classList.remove('hidden');
        flChip.textContent = 'Flood mapping (TAS)';
      }
    } else {
      const flChip = $('#prop-ov-flood');
      if (flChip) flChip.classList.add('hidden');
    }
    const errs = d.errors || [];
    if (errs.length) {
      cards.push(intelCard('Unavailable layers', errs.map((e) => e.layer).join(', '),
        errs.map((e) => (e.error || '').slice(0, 90)).join(' · ')));
    }
    $('#property-cards').innerHTML = cards.join('');

    const rows = [];
    const row = (k, v) => {
      if (v !== null && v !== undefined && v !== '') {
        rows.push('<div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(String(v)) + '</div>');
      }
    };
    Object.entries(p.extra || {}).forEach(([k, v]) => {
      row(k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()), v);
    });
    if (p.locality) row('Locality/address', p.locality);
    $('#property-details').innerHTML = rows.length
      ? '<div class="kv">' + rows.join('') + '</div>' : '';
    const topoEl = $('#prop-base-topo');
    if (topoEl) topoEl.classList.add('hidden');

    const failed = errs.map((e) => e.layer).join(', ');
    const shown = state.inputs.properties[activePropertyIndex()] || {};
    setPropertyStatus(
      `${shown.address ? shown.address + ' · ' : ''}${d.provider || d.jurisdiction + ' Government open data'}`
      + ` · fetched ${String(d.fetchedAt || '').replace('T', ' ').slice(0, 16)}`
      + (p.id ? '' : ' · no parcel match at this coordinate')
      + (failed ? ` · unavailable: ${failed}` : ''));
    $('#property-sources').innerHTML = 'Source: ' + (d.sources || []).map((s) =>
      `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.label)}</a>`
      + ` · ${escapeHtml(s.licence || '')}`).join(' · ');
    renderIntelMap(d);
  }

  function renderIntel(d) {
    intel.bushfireKind = 'qld';
    const bfChip = $('#prop-ov-bushfire');
    if (bfChip) {
      bfChip.classList.remove('hidden');
      bfChip.textContent = 'Bushfire prone';
    }
    ['#prop-ov-flood', '#prop-base-topo'].forEach((sel) => {
      const el = $(sel);
      if (el) el.classList.remove('hidden');
    });
    if (d && d.jurisdiction === 'VIC') { renderVicIntel(d); return; }
    if (d && STATE_INTEL_JURISDICTIONS.has(String(d.jurisdiction || '').toUpperCase())) {
      renderStateIntel(d);
      return;
    }
    const p = d.parcel || {};
    const lu = d.landUse || {};
    const rp = d.regionalPlan || {};
    const aoi = d.areasOfInterest || {};
    const flood = d.flood || {};
    const studies = flood.studies || [];
    const catchments = flood.catchments || [];
    const living = aoi.priorityLiving || [];
    const agri = aoi.priorityAgricultural || [];
    const env = aoi.strategicEnvironmental || [];

    const area = p.areaSqm ? fmtNum(p.areaSqm) + ' m²' : '—';
    const tenureSub = [p.tenure, p.surveyAccurate ? 'survey accurate' : 'positional accuracy not flagged']
      .filter(Boolean).join(' · ');

    $('#property-cards').innerHTML = [
      intelCard('Lot on plan', p.lotPlan || 'Not found',
        p.lot ? `Lot ${p.lot} on plan ${p.plan}` : 'No cadastral parcel at this point'),
      intelCard('Land area', area, tenureSub),
      intelCard('Location', p.locality || '—', p.lga ? p.lga + ' Council' : ''),
      intelCard('Land use', lu.tertiary || lu.secondary || lu.primary || '—',
        lu.primary ? `${lu.primary} · ALUM ${lu.code || ''}${lu.year ? ' (' + lu.year + ')' : ''}` : ''),
      intelCard('Regional plan', rp.name || '—',
        rp.version ? `${rp.version}${rp.status ? ' · ' + rp.status : ''}` : ''),
      intelCard('Priority living area', living.length ? living.join(', ') : 'Not in one',
        living.length ? 'Area of regional interest' : 'State planning designation'),
      intelCard('Flood study', studies.length ? studies.length + (studies.length === 1 ? ' study' : ' studies') : 'None here',
        studies.length ? studies.map((s) => s.name).join(' · ') : 'No flood study mapped over this parcel'),
      intelCard('Bushfire prone area', 'Use the overlay',
        'QFES state-wide mapping — toggle it on the map'),
    ].join('');

    const rows = [];
    const row = (k, v) => { if (v) rows.push(`<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div>`); };
    row('Parcel name', p.featureName);
    row('Tenure', p.tenure);
    row('Local government area', p.lga);
    row('Locality', p.locality);
    row('Parcel status', p.parcelState);
    if (p.isStrata) row('Strata lots', String(p.strataCount || ''));
    row('Volumetric lot', p.isVolumetric ? 'Yes' : 'No');
    row('Multi-parcel', p.isMulti ? 'Yes' : 'No');
    row('Priority agricultural area', agri.length ? agri.join(', ') : '');
    row('Strategic environmental area', env.length ? env.join(', ') : '');
    row('Flood catchment', catchments.join(', '));
    studies.forEach((s) => {
      row(s.kind, [s.name, s.area, s.consultant].filter(Boolean).join(' · '));
    });
    $('#property-details').innerHTML = rows.length
      ? `<div class="kv">${rows.join('')}</div>`
      : '';

    const failed = (d.errors || []).map((e) => e.layer).join(', ');
    const shown = state.inputs.properties[activePropertyIndex()] || {};
    setPropertyStatus(
      `${shown.address ? shown.address + ' · ' : ''}Queensland Government open data · fetched ${String(d.fetchedAt || '').replace('T', ' ').slice(0, 16)}`
      + (failed ? ` · unavailable: ${failed}` : ''));

    $('#property-sources').innerHTML = 'Check it yourself: ' + (d.sources || []).map((s) =>
      `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.label)}</a>`).join(' · ');

    renderIntelMap(d);
  }

  function renderIntelMap(d) {
    const el = document.getElementById('property-map');
    if (!el || !window.L) return;

    if (!intel.map) {
      intel.map = L.map(el, { zoomControl: true, scrollWheelZoom: true });
      intel.base = L.tileLayer(INTEL_BASEMAPS.sat.url, {
        maxZoom: 19, attribution: INTEL_BASEMAPS.sat.attribution,
      }).addTo(intel.map);
      intel.parcel = L.layerGroup();
      intel.flood = L.layerGroup();
      bindIntelControls();
    }
    setTimeout(() => intel.map.invalidateSize(), 60);

    intel.parcel.clearLayers();
    intel.flood.clearLayers();
    if (intel.marker) intel.map.removeLayer(intel.marker);

    const { lat, lon } = d.coords;
    const pt = [lat, lon];
    intel.marker = L.circleMarker(pt, {
      radius: 7, color: '#e11d48', weight: 3, fillColor: '#e11d48', fillOpacity: 0.35,
    }).addTo(intel.map);

    const poly = esriPolygonToGeoJSON(d.parcelGeometry);
    if (poly) {
      const layer = L.geoJSON(poly, {
        style: { color: cssVar('--pri') || '#6366f1', weight: 3, fillOpacity: 0.12 },
      });
      intel.parcel.addLayer(layer);
      intel.map.fitBounds(layer.getBounds().pad(0.35));
    } else {
      intel.map.setView(pt, 18);
    }

    const floodPoly = esriPolygonToGeoJSON(d.flood && d.flood.extent);
    if (floodPoly) {
      intel.flood.addLayer(L.geoJSON(floodPoly, {
        style: { color: '#0284c7', weight: 2, dashArray: '5 4', fillOpacity: 0.08 },
      }));
    }

    applyIntelOverlays();
  }

  function applyIntelOverlays() {
    if (!intel.map) return;
    if (intel.overlays.parcel && intel.parcel) {
      if (!intel.map.hasLayer(intel.parcel)) intel.parcel.addTo(intel.map);
    } else if (intel.parcel && intel.map.hasLayer(intel.parcel)) {
      intel.map.removeLayer(intel.parcel);
    }
    const activeBf = bushfireLayer();
    [intel.bushfire, intel.bushfireVic, intel.bushfireWa, intel.bushfireNsw]
      .forEach((l) => {
        if (l && l !== activeBf && intel.map.hasLayer(l)) intel.map.removeLayer(l);
      });
    if (intel.overlays.bushfire && activeBf) {
      if (!intel.map.hasLayer(activeBf)) activeBf.addTo(intel.map);
    } else if (activeBf && intel.map.hasLayer(activeBf)) {
      intel.map.removeLayer(activeBf);
    }
    const floodTile = floodLayer();
    [intel.floodVic, intel.floodTas].forEach((l) => {
      if (l && l !== floodTile && intel.map.hasLayer(l)) intel.map.removeLayer(l);
    });
    if (intel.overlays.flood && floodTile) {
      if (!intel.map.hasLayer(floodTile)) floodTile.addTo(intel.map);
    } else if (floodTile && intel.map.hasLayer(floodTile)) {
      intel.map.removeLayer(floodTile);
    }
    if (intel.overlays.flood && !floodTile && intel.flood) {
      if (!intel.map.hasLayer(intel.flood)) intel.flood.addTo(intel.map);
    } else if (!floodTile && intel.flood && intel.map.hasLayer(intel.flood)) {
      intel.map.removeLayer(intel.flood);
    }
  }

  function bindIntelControls() {
    $$('.prop-map-controls .chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.base) {
          const key = btn.dataset.base;
          if (!INTEL_BASEMAPS[key]) return;
          $$('.prop-map-controls .chip[data-base]').forEach((b) =>
            b.classList.toggle('active', b === btn));
          if (intel.map && intel.base) intel.map.removeLayer(intel.base);
          const meta = INTEL_BASEMAPS[key];
          intel.base = L.tileLayer(meta.url, { maxZoom: 19, attribution: meta.attribution });
          if (intel.map) {
            intel.base.addTo(intel.map);
            intel.base.bringToBack();
          }
          return;
        }
        const ov = btn.dataset.ov;
        if (!ov) return;
        intel.overlays[ov] = !intel.overlays[ov];
        btn.classList.toggle('active', intel.overlays[ov]);
        applyIntelOverlays();
      });
    });
  }


  const charts = {};
  function drawChart(id, config) {
    if (charts[id]) charts[id].destroy();
    const el = document.getElementById(id);
    if (!el) return;
    charts[id] = new Chart(el, config);
  }

  // Charts inside the collapsed dashboard details panel are initially measured
  // at zero width. Resize them after the user expands the panel.
  document.querySelectorAll('.dashboard-secondary-details details').forEach((details) => {
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      requestAnimationFrame(() => {
        ['chart-ov-cash', 'chart-ov-cum'].forEach((id) => {
          if (charts[id]) charts[id].resize();
        });
      });
    });
  });

  const COLORS = {
    pri: '#6366f1', red: '#f43f5e', green: '#10b981', amber: '#f59e0b',
    purple: '#8b5cf6', teal: '#14b8a6', gray: '#94a3b8', pink: '#ec4899',
  };

  const cssVar = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const baseOpts = (yFmt = fmtMoney) => {
    const tick = cssVar('--chart-tick') || '#64748b';
    const grid = cssVar('--chart-grid') || 'rgba(15, 23, 42, 0.08)';
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: tick, boxWidth: 12, font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: tick, font: { size: 11 } }, grid: { color: grid } },
        y: { ticks: { color: tick, font: { size: 11 }, callback: (v) => yFmt(v) }, grid: { color: grid } },
      },
    };
  };

  // ------------------------------------------------------------------
  // Recalculation + render dispatch
  // ------------------------------------------------------------------

  // Short source-label for the sidebar foot, by scenario state.
  const STATE_RATE_SHORT = {
    QLD: 'QRO & ATO', NSW: 'Revenue NSW & ATO', VIC: 'SRO VIC & ATO',
    SA: 'Revenue SA & ATO', WA: 'WA Treasury & ATO', TAS: 'SRO TAS & ATO',
    NT: 'NT TRO & ATO', ACT: 'ACT Revenue & ATO',
  };

  function renderRateFoot() {
    const el = document.querySelector('.sidebar-foot');
    if (!el) return;
    const st = (state.inputs && state.inputs.state) || 'QLD';
    el.innerHTML = 'AUD &middot; estimates only, not tax advice.<br>Rates: ' +
      (STATE_RATE_SHORT[st] || 'QRO & ATO') + ' (Nov 2026)';
  }


  // Decision panels — concise, data-led guidance for each major workflow.
  function decisionPanel(id, eyebrow, title, body, stats) {
    const host = document.getElementById(id);
    if (!host) return;
    let panel = host.querySelector(':scope > .decision-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'decision-panel';
      host.insertBefore(panel, host.children[1] || null);
    }
    panel.innerHTML = `
      <div class="decision-panel-copy">
        <div class="decision-eyebrow">${escapeHtml(eyebrow)}</div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(body)}</p>
      </div>
      <div class="decision-stat-grid">${(stats || []).map(s => `
        <div class="decision-stat">
          <span>${escapeHtml(s.label)}</span>
          <strong>${escapeHtml(s.value)}</strong>
          ${s.note ? `<small>${escapeHtml(s.note)}</small>` : ''}
        </div>`).join('')}</div>`;
  }

  function renderDecisionPanels() {
    if (!state.result) return;
    const m = state.result.metrics;
    const idx = activePropertyIndex();
    const p = state.inputs.properties[idx] || {};
    const propName = p.label || p.address || 'Investment property';
    const propView = viewData();
    const cashRows = propView.rows || [];
    const first = cashRows[0] || {};
    const last = cashRows[cashRows.length - 1] || {};
    const x = propView.exit || state.result.exit || {};
    const suburb = currentSuburb();

    decisionPanel('section-inputs','SETUP CHECKPOINT','Your investment at a glance',
      'A live summary of the assumptions currently driving the model. Change any input below and the figures recalculate automatically.',
      [
        {label:'Purchase price',value:fmtMoney(m.purchasePrice)},
        {label:'Cash required',value:fmtMoney(m.initialCashInvested)},
        {label:'Weekly after-tax',value:signed(m.weeklyOutOfPocket)},
        {label:'Gross yield',value:fmtPct(m.grossYield)}
      ]);

    decisionPanel('section-property','PROPERTY PROFILE',propName,
      p.address ? 'Address and government spatial layers are used to build this property view. Treat missing layers as unknown, not as a clear result.' : 'Add and locate the full property address in Investment Inputs to load parcel and Queensland spatial information.',
      [
        {label:'Address',value:p.address || 'Not entered'},
        {label:'Location match',value:(p.addressMeta && p.addressMeta.lat != null) ? 'Coordinates found' : 'Pending'},
        {label:'Map layers',value:'Parcel · flood · bushfire',note:'Availability depends on location'}
      ]);

    decisionPanel('section-area','SUBURB RESEARCH',suburb ? suburb.name + ' · ' + suburb.postcode : 'Select a suburb to begin',
      suburb ? 'Use the score as a screening aid, then validate the underlying sales, rental evidence and risk factors before making an offer.' : 'Choose the suburb in Investment Inputs. Market indicators and the investment score will appear here when reference data is available.',
      suburb ? [
        {label:'Median price',value:suburb.medianPrice ? fmtMoney(suburb.medianPrice) : 'No data'},
        {label:'3-bed rent',value:suburb.medianRent3Bed ? fmtMoney(suburb.medianRent3Bed)+'/wk' : 'No data'},
        {label:'Vacancy',value:suburb.vacancyPct != null ? suburb.vacancyPct.toFixed(1)+'%' : 'No data'},
        {label:'5-year growth',value:suburb.growth5yrPct != null ? suburb.growth5yrPct.toFixed(1)+'%' : 'No data'}
      ] : []);

    decisionPanel('section-cashflow','CASH FLOW DECISION','What does it cost to hold?',
      'Positive after-tax cash flow is a surplus; negative cash flow means cash you need to contribute. Select a year below to inspect every line item.',
      [
        {label:'Year 1 after-tax',value:signed(first.afterTaxCashFlow || 0)},
        {label:'Weekly contribution',value:fmtMoney(Math.max(0,-(first.afterTaxCashFlow || 0))/52)},
        {label:'Annual rent',value:fmtMoney(first.grossRent || 0)},
        {label:'Annual operating costs',value:fmtMoney(first.operatingExpenses || 0)}
      ]);

    decisionPanel('section-projections','LONG-TERM OUTLOOK','Where could the investment be heading?',
      'The model compares projected property value with debt over your selected holding period. These are assumptions-based projections, not forecasts.',
      [
        {label:'Ending property value',value:fmtMoney(last.propertyValue || 0)},
        {label:'Ending debt',value:fmtMoney(last.totalDebt || 0)},
        {label:'Ending equity',value:fmtMoney(last.netEquity || 0)},
        {label:'Cumulative after-tax CF',value:signed(last.cumulativeAfterTaxCashFlow || 0)}
      ]);

    decisionPanel('section-exit','EXIT CHECKPOINT','What might you walk away with?',
      'Estimated proceeds are shown after selling costs, CGT and loan payouts. Review the cost-base working and tax assumptions below before relying on the result.',
      [
        {label:'Sale price',value:fmtMoney(x.salePrice || 0)},
        {label:'Estimated CGT',value:fmtMoney(x.capitalGainsTax || 0)},
        {label:'Loan payouts',value:fmtMoney((x.ipLoanBalanceAtSale || 0)+(x.equityLoanBalanceAtSale || 0))},
        {label:'Net sale proceeds',value:fmtMoney(x.netSaleProceeds || 0)}
      ]);

    const compare = state.compareData || [];
    decisionPanel('section-scenarios','DECISION COMPARISON','Compare the trade-offs, not just the purchase price',
      'Select up to three saved scenarios below. Focus on upfront cash, ongoing contribution, equity and estimated exit position together.',
      [
        {label:'Selected scenarios',value:String(compare.length)+'/3'},
        {label:'Current scenario cash',value:fmtMoney(m.initialCashInvested)},
        {label:'Current weekly position',value:signed(m.weeklyOutOfPocket)},
        {label:'10-year equity',value:fmtMoney(m.tenYearEquity)}
      ]);
  }

  function recalc() {
    try {
      state.result = E.calculateAll(state.inputs, { suburb: currentSuburb() });
      const oi = E.ownedInputs(state.inputs);
      state.ownedResult = oi ? E.calculateAll(oi, { suburb: currentSuburb() }) : null;
      updateInputGuide();
    } catch (err) {
      console.error('calculation failed', err);
      toast('Calculation error — check inputs');
      return;
    }
    renderRateFoot();
    renderWarnings();
    renderPortfolioSnapshot();
    renderDashboardMarketIntel();
    renderOverview();
    renderArea();
    renderCashFlow();
    renderProjections();
    renderExit();
    renderBorrowing();
    if (state.compareData.length) renderCompare();
    renderDecisionPanels();
  }

  // Warnings anchored to the input or section they concern. Anything that
  // doesn't match falls back to the banner above the tabs.
  const WARNING_ANCHORS = [
    { match: 'switch from interest-only', field: 'ipInterestOnlyYears', prop: true },
    { match: '1 July 2027', section: 'exit' },
    { match: 'APRA-style estimate', section: 'borrowing' },
    { match: 'DTI comfort limit', section: 'borrowing' },
    { match: 'Surplus is negative', section: 'borrowing' },
    { match: 'Funding shortfall', field: 'equityReleased', prop: true },
    { match: '80% of your PPOR', field: 'pporValue' },
    { match: 'loan tracing', field: 'equityLoanPurposePercent' },
    { match: 'LVR above 95%', field: 'ipLvr', prop: true },
    { match: 'half-share', field: 'ownershipType' },
    { match: 'Second-hand residential', field: 'plantEquipmentEligible', prop: true },
  ];

  const WARN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>';

  function renderWarnings() {
    const top = [];
    const byField = new Map();
    const bySection = new Map();
    const deferredProps = new Set();
    for (const w of state.result.warnings || []) {
      const a = WARNING_ANCHORS.find((x) => w.includes(x.match));
      if (a && a.field) {
        if (a.prop) {
          // Per-property warning: chip the field only when that IP's tab is
          // active; otherwise the IP tab's amber dot flags it.
          const m = w.match(/^IP (\d+) — /);
          const idx = m ? Number(m[1]) - 1 : 0;
          if (state.inputTab !== idx) { deferredProps.add(idx); continue; }
        }
        if (!byField.has(a.field)) byField.set(a.field, []);
        byField.get(a.field).push(w);
      } else if (a && a.section) {
        if (!bySection.has(a.section)) bySection.set(a.section, []);
        bySection.get(a.section).push(w);
      } else {
        top.push(w);
      }
    }

    const box = $('#warnings');
    const renderBanner = () => {
      box.classList.toggle('hidden', !top.length);
      box.innerHTML = top.map((w) => `<div class="warning-item">${escapeHtml(w)}</div>`).join('');
    };
    renderBanner();

    // clear previous inline markers
    $$('.field-warn').forEach((el) => el.remove());
    $$('.field.has-warn').forEach((el) => el.classList.remove('has-warn'));
    $$('details.advanced.has-warn').forEach((el) => el.classList.remove('has-warn'));
    $$('.section-note').forEach((el) => el.remove());
    $$('#nav a.has-warn').forEach((el) => el.classList.remove('has-warn'));

    for (const [field, msgs] of byField) {
      const input = document.querySelector(`[data-field="${field}"]`);
      const wrap = input ? input.closest('.field') : null;
      if (!wrap) { top.push(...msgs); renderBanner(); continue; }
      wrap.classList.add('has-warn');
      const chip = document.createElement('div');
      chip.className = 'field-warn';
      chip.innerHTML = msgs.map((m) => `<div class="fw-row">${WARN_SVG}<span>${escapeHtml(m)}</span></div>`).join('');
      wrap.appendChild(chip);
      const details = wrap.closest('details.advanced');
      if (details) details.classList.add('has-warn');
      const nav = $('#nav a[data-target="inputs"]');
      if (nav) nav.classList.add('has-warn');
    }

    for (const [sec, msgs] of bySection) {
      const page = document.getElementById('section-' + sec);
      if (!page) { top.push(...msgs); renderBanner(); continue; }
      const note = document.createElement('div');
      note.className = 'section-note';
      note.innerHTML = msgs.map((m) => `<div class="fw-row">${WARN_SVG}<span>${escapeHtml(m)}</span></div>`).join('');
      page.prepend(note);
      const nav = $(`#nav a[data-target="${sec}"]`);
      if (nav) nav.classList.add('has-warn');
    }

    // Amber dots on IP tabs carrying warnings; Inputs nav dot when any
    // property-level warning is deferred to a hidden tab.
    const warns = propWarnIndexes();
    $$('#prop-tabs .prop-tab[data-prop-tab]').forEach((el) => {
      const n = Number(el.dataset.propTab);
      el.classList.toggle('has-warn', Number.isInteger(n) && warns.has(n));
    });
    if (deferredProps.size) {
      const nav = $('#nav a[data-target="inputs"]');
      if (nav) nav.classList.add('has-warn');
    }
  }

  // ------------------------------------------------------------------
  // Property tabs (Inputs) + per-property view selectors
  // ------------------------------------------------------------------

  function ipLabel(p, i) { return (p && p.label) || `Investment property ${i + 1}`; }

  const STATUS_LABELS = { considering: 'Considering', under_offer: 'Under offer', purchased: 'Purchased' };

  // The label is shown on the tab strip at the top of the Inputs pane and in
  // the pane title, so renaming a property has to redraw both.
  function refreshIpLabels() {
    buildPropTabs();
    const tab = state.inputTab;
    if (Number.isInteger(tab) && state.inputs.properties[tab]) {
      $('#ip-pane-title').textContent = ipLabel(state.inputs.properties[tab], tab);
    }
  }

  function propWarnIndexes() {
    const set = new Set();
    ((state.result && state.result.propertyWarnings) || []).forEach((list, i) => {
      if (list && list.length) set.add(i);
    });
    return set;
  }

  function propTabStripHtml(opts) {
    opts = opts || {};
    const props = state.inputs.properties;
    const warns = propWarnIndexes();
    const plain = (val, label) =>
      `<span class="prop-tab ${state.inputTab === val ? 'active' : ''}" data-prop-tab="${val}">${label}</span>`;
    const ipTabs = props.map((p, i) => {
      const remove = !opts.selector && props.length > 1
        ? `<button class="prop-remove" data-prop-remove="${i}" title="Remove this property">×</button>`
        : '';
      return `<span class="prop-tab ${state.inputTab === i ? 'active' : ''} ${warns.has(i) ? 'has-warn' : ''}" data-prop-tab="${i}">${escapeHtml(ipLabel(p, i))}${remove}</span>`;
    }).join('');
    if (opts.selector) return ipTabs; // intel strip: investment properties only
    const atCap = props.length >= E.MAX_PROPERTIES;
    return plain('portfolio', 'Portfolio') + plain('ppor', 'PPOR') + ipTabs +
      `<button class="prop-tab prop-tab-add" data-prop-add ${atCap ? 'disabled' : ''}>+ Add property</button>`;
  }

  function buildPropTabs() {
    const bar = $('#prop-tabs');
    if (bar) bar.innerHTML = propTabStripHtml();
    const intelBar = $('#prop-tabs-intel');
    if (intelBar) intelBar.innerHTML = propTabStripHtml({ selector: true });
  }


  function updateInputGuide() {
    const host=$('#input-guide'); if(!host||!state.inputs) return;
    const props=state.inputs.properties||[], idx=Number.isInteger(state.inputTab)?state.inputTab:-1;
    const data=idx>=0?(props[idx]||{}):state.inputs;
    const fields=idx>=0?[['address','Property address'],['purchasePrice','Purchase price'],['weeklyRent','Weekly rent']]:[['state','Purchase state'],['projectionYears','Hold period'],['owner1TaxableIncome','Your taxable income']];
    const done=v=>v!==''&&v!==null&&v!==undefined&&v!==0;
    const count=fields.filter(x=>done(data[x[0]])).length, pct=Math.round(count/fields.length*100);
    const active=state.inputTab==='portfolio'?'portfolio':state.inputTab==='ppor'?'ppor':'property';
    host.innerHTML='<div class="input-guide-head"><div><div class="page-eyebrow">GUIDED SETUP</div><h2>Build your investment scenario</h2><p>Start with the essentials. Advanced assumptions stay available when you need them.</p></div><div class="guide-progress"><strong>'+pct+'%</strong><span>'+count+' of '+fields.length+' essentials set</span><i><b style="width:'+pct+'%"></b></i></div></div><div class="guide-steps"><button type="button" data-guide-step="portfolio" class="'+(active==='portfolio'?'active':'')+'"><span>01</span><strong>Portfolio</strong><small>Ownership, income &amp; hold period</small></button><button type="button" data-guide-step="ppor" class="'+(active==='ppor'?'active':'')+'"><span>02</span><strong>Home &amp; equity</strong><small>PPOR value and funding</small></button><button type="button" data-guide-step="property" class="'+(active==='property'?'active':'')+'"><span>03</span><strong>Investment property</strong><small>Address, price and rental income</small></button></div><div class="guide-checklist">'+fields.map(x=>'<span class="'+(done(data[x[0]])?'done':'')+'">'+(done(data[x[0]])?'✓':'○')+' '+x[1]+'</span>').join('')+'</div>';
    host.querySelectorAll('[data-guide-step]').forEach(btn=>btn.addEventListener('click',()=>{const step=btn.dataset.guideStep;setActiveTab(step==='portfolio'?'portfolio':step==='ppor'?'ppor':0);}));
  }

  function setActiveTab(tab) {
    state.inputTab = tab;
    const pageId = tab === 'portfolio' ? 'prop-page-portfolio'
      : tab === 'ppor' ? 'prop-page-ppor' : 'prop-page-ip';
    $$('.prop-page').forEach((p) => p.classList.toggle('active', p.id === pageId));
    if (Number.isInteger(tab) && state.inputs.properties[tab]) {
      $('#ip-pane-title').textContent = ipLabel(state.inputs.properties[tab], tab);
    }
    buildPropTabs();
    updateInputGuide();
    syncForm();       // rebind the per-property fields to the newly active IP
    renderWarnings(); // chips are transient DOM; re-anchor for the active tab
    if (propertySectionVisible()) renderProperty();
  }

  // Tab clicks work from both the Inputs strip and the Property intelligence
  // strip — they share the same active-property concept.
  document.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-prop-add]')) { addProperty(); return; }
    const rm = ev.target.closest('[data-prop-remove]');
    if (rm) {
      ev.stopPropagation();
      removeProperty(Number(rm.dataset.propRemove));
      return;
    }
    const t = ev.target.closest('#prop-tabs [data-prop-tab], #prop-tabs-intel [data-prop-tab]');
    if (!t) return;
    const val = t.dataset.propTab;
    setActiveTab(val === 'portfolio' || val === 'ppor' ? val : Number(val));
  });

  function addProperty() {
    const props = state.inputs.properties;
    if (props.length >= E.MAX_PROPERTIES) {
      toast(`Up to ${E.MAX_PROPERTIES} investment properties per scenario`);
      return;
    }
    const srcIdx = Number.isInteger(state.inputTab) ? state.inputTab : props.length - 1;
    const clone = JSON.parse(JSON.stringify(props[srcIdx]));
    clone.label = '';
    clone.address = '';
    clone.addressMeta = null;
    clone.ownershipStatus = 'considering';
    props.push(clone);
    saveDraft();
    setActiveTab(props.length - 1);
    recalc();
    toast('Property added (duplicate) — set its address, then tweak the details');
  }

  function removeProperty(idx) {
    const props = state.inputs.properties;
    if (props.length <= 1) return;
    const label = ipLabel(props[idx], idx);
    if (!confirm(`Remove ${label} and all its inputs?`)) return;
    props.splice(idx, 1);
    if (state.viewProp === idx) state.viewProp = -1;
    else if (state.viewProp > idx) state.viewProp -= 1;
    if (Number.isInteger(state.inputTab)) {
      if (state.inputTab === idx) state.inputTab = Math.max(0, idx - 1);
      else if (state.inputTab > idx) state.inputTab -= 1;
    }
    saveDraft();
    setActiveTab(state.inputTab);
    recalc();
    toast(`${label} removed`);
  }

  // Result views: -1 = portfolio, else one property's own numbers.
  function viewData(opts) {
    // opts.owned: portfolio roll-ups read the purchased-only result. Only
    // meaningful in the portfolio view — a selected per-property view always
    // uses the full result (filtering re-indexes properties, so state.viewProp
    // indexes into ownedResult would point at the wrong property).
    const owned = opts && opts.owned && state.viewProp < 0;
    const r = (owned && state.ownedResult) ? state.ownedResult : state.result;
    if (owned && !state.ownedResult) {
      return { ownedEmpty: true, isPortfolio: true, property: null, exit: null,
        rows: [], upfront: null, propInputs: null, metrics: null };
    }
    if (state.viewProp >= 0 && r.properties[state.viewProp]) {
      const p = r.properties[state.viewProp];
      return {
        property: p,
        exit: p.exit,
        rows: p.rows,
        upfront: p.upfront,
        propInputs: r.inputs.properties[state.viewProp],
        metrics: p.metrics,
        isPortfolio: false,
      };
    }
    return {
      property: null,
      exit: r.exit,
      rows: r.rows,
      upfront: r.upfront,
      propInputs: null,
      metrics: r.metrics,
      isPortfolio: true,
    };
  }

  function fillViewSelect(sel, includePpor) {
    if (!sel) return;
    const props = state.result.properties || [];
    if (typeof state.viewProp === 'number' && state.viewProp >= props.length) state.viewProp = -1;
    const viewPpor = state.viewProp === 'ppor';
    const effective = viewPpor ? -1 : state.viewProp;
    sel.innerHTML = '<option value="-1">Portfolio (all)</option>' +
      (includePpor ? '<option value="ppor">PPOR (your home)</option>' : '') +
      props.map((p, i) =>
        `<option value="${i}" ${effective === i ? 'selected' : ''}>${escapeHtml(ipLabel(p, i))}</option>`).join('');
    sel.value = String(includePpor && viewPpor ? 'ppor' : effective);
  }

  function onViewSelectChange(v) {
    state.viewProp = v === 'ppor' ? 'ppor' : Number(v);
    renderOverview();
    renderCashFlow();
    renderProjections();
    renderExit();
  }

  function card(label, value, sub, cls) {
    return `<div class="card"><div class="label">${label}</div>
      <div class="value ${cls || ''}">${value}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  }

  // ------------------------------------------------------------------
  // Overview
  // ------------------------------------------------------------------

  let dashboardProjectionYears = 20;

  function renderOverview() {
    const roll = state.ownedResult;   // purchased-only portfolio — what roll-ups show
    const m = roll ? roll.metrics : null;
    const coc = m && m.cashOnCashReturn === null
      ? 'n/a (fully geared)' : m ? fmtPct(m.cashOnCashReturn, 1) : '—';
    const wop = m ? m.weeklyOutOfPocket : null;
    const legacyCards = $('#overview-cards');
    if (legacyCards) legacyCards.innerHTML = !m
      ? '<div class="empty-note">No purchased properties yet — set a property\'s ownership status to Purchased in Inputs and it becomes the portfolio here.</div>'
      : card('Purchase price', fmtMoney(m.purchasePrice), `Duty ${fmtMoney(m.transferDuty)}${state.inputs.buyerType === 'foreign' ? ' incl. foreign surcharge' : ''}`) +
      card('Gross yield', fmtPct(m.grossYield), `Net ${fmtPct(m.netYield)}`) +
      card('Weekly out-of-pocket', fmtMoney(Math.max(0, wop)) + (wop < 0 ? ' in' : ''), 'after tax, year 1', wop > 0 ? 'bad' : 'good') +
      card('Cash required upfront', fmtMoney(m.initialCashInvested), `Total funds ${fmtMoney(m.requiredFunds)}`) +
      card('IP loan', fmtMoney(m.ipLoanAmount), `LVR ${fmtPct(m.ipLvrActual, 1)}`) +
      card('10-year equity', fmtMoney(m.tenYearEquity), `Week ${fmtMoney(Math.max(0, m.tenYearWeeklyOutOfPocket))}`) +
      card('Cash-on-cash (yr 1)', coc, 'after-tax CF / cash in') +
      card('Borrowing capacity', fmtMoney(state.result.borrowing.maxNewLoan), 'est. max additional loan');

    renderOverviewProps();

    const allRows = (roll && roll.rows) || [];
    const rows = allRows.slice(0, Math.max(1, dashboardProjectionYears));
    const periodControl = $('#dashboard-period');
    if (periodControl && periodControl.value !== String(dashboardProjectionYears)) periodControl.value = String(dashboardProjectionYears);
    const labels = rows.map((r) => 'Y' + r.year + ' · ' + r.calendarYear);
    drawChart('chart-ov-equity', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Property value', data: rows.map((r) => r.propertyValue), borderColor: COLORS.pri, backgroundColor: COLORS.pri, tension: 0.15, pointRadius: 0 },
          { label: 'Total debt', data: rows.map((r) => r.totalDebt), borderColor: COLORS.red, backgroundColor: COLORS.red, tension: 0.15, pointRadius: 0 },
          { label: 'Net equity', data: rows.map((r) => r.netEquity), borderColor: COLORS.green, backgroundColor: COLORS.green, tension: 0.15, pointRadius: 0 },
        ],
      },
      options: baseOpts(),
    });
    // Decision-useful annual cash contribution: positive means cash required,
    // negative means an after-tax surplus. This also makes the IO -> P&I step-up visible.
    drawChart('chart-ov-cash', {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Cash required (+) / surplus (−)',
          data: rows.map((r) => -r.afterTaxCashFlow),
          backgroundColor: rows.map((r) => r.afterTaxCashFlow < 0 ? COLORS.amber : COLORS.green),
          borderRadius: 5,
          maxBarThickness: 34,
        }],
      },
      options: {
        ...baseOpts((v) => (v < 0 ? '−' : '') + fmtMoney(Math.abs(v), 0)),
        plugins: { ...baseOpts().plugins, tooltip: { callbacks: { label: (ctx) => ' ' + ctx.dataset.label + ': ' + signed(ctx.parsed.y) } } },
      },
    });

    // Sale waterfall-style breakdown: sale price less costs, tax and both loans.
    const exitView = viewData({ owned: true });
    const exitLabels = ['Sale price', 'Selling costs', 'CGT', 'IP loan payout', 'Equity loan payout', 'Cash received'];
    const exitValues = exitView.ownedEmpty ? [] : [
      exitView.exit.salePrice, -exitView.exit.sellingCosts, -exitView.exit.capitalGainsTax,
      -exitView.exit.ipLoanBalanceAtSale, -exitView.exit.equityLoanBalanceAtSale,
      exitView.exit.netSaleProceeds];
    const allocationProps = ((roll && roll.properties) || []).map((p, i) => ({
      label: ipLabel(p, i),
      value: Number((p.metrics || {}).purchasePrice || 0),
    })).filter((p) => p.value > 0);
    const pporAllocation = Number(state.inputs && state.inputs.pporValue) || 0;
    if (pporAllocation > 0) allocationProps.unshift({ label: 'PPOR · Home', value: pporAllocation });
    const allocationCanvas = document.getElementById('chart-ov-allocation');
    if (allocationCanvas) {
      const allocationBox = allocationCanvas.closest('.chart-box');
      if (allocationBox) allocationBox.classList.toggle('is-empty', !allocationProps.length);
      if (allocationProps.length) {
        drawChart('chart-ov-allocation', {
          type: 'doughnut',
          data: {
            labels: allocationProps.map((p) => p.label),
            datasets: [{
              label: 'Purchase value',
              data: allocationProps.map((p) => p.value),
              backgroundColor: ['#2874d0', '#0f9b8e', '#805ad5', '#e5a12b', '#df6672', '#3b9b72'],
              borderColor: cssVar('--card') || '#ffffff',
              borderWidth: 3,
              hoverOffset: 8,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '62%',
            plugins: {
              legend: { position: 'bottom', labels: { color: cssVar('--chart-tick') || '#64748b', usePointStyle: true, padding: 14 } },
              tooltip: { callbacks: { label: (ctx) => ' ' + ctx.label + ': ' + fmtMoney(ctx.parsed) } },
            },
          },
        });
      } else if (charts['chart-ov-allocation']) {
        charts['chart-ov-allocation'].destroy();
        delete charts['chart-ov-allocation'];
      }
    }
    drawChart('chart-ov-cum', {
      type: 'bar',
      data: {
        labels: exitLabels,
        datasets: [{
          label: 'Estimated amount',
          data: exitValues,
          backgroundColor: exitValues.map((v, i) => i === 0 ? COLORS.pri : i === 5 ? COLORS.green : COLORS.red),
          borderRadius: 5,
        }],
      },
      options: {
        ...baseOpts((v) => (v < 0 ? '−' : '') + fmtMoney(Math.abs(v), 0)),
        indexAxis: 'y',
        plugins: { ...baseOpts().plugins, legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ' ' + signed(ctx.parsed.x) } } },
        scales: {
          x: { ticks: { color: cssVar('--chart-tick') || '#64748b', callback: (v) => (v < 0 ? '−' : '') + fmtMoney(Math.abs(v), 0) }, grid: { color: cssVar('--chart-grid') || 'rgba(15, 23, 42, 0.08)' } },
          y: { ticks: { color: cssVar('--chart-tick') || '#64748b' }, grid: { display: false } },
        },
      },
    });
    renderGrowthScenarios();
  }

  // 3 / 5 / 7 % capital-growth bands — same inputs, growth swapped.
  function renderGrowthScenarios() {
    const owned = E.ownedInputs(state.inputs);
    if (!owned) {
      $('#growth-table').innerHTML =
        '<div class="empty-note">Growth bands cover purchased properties — mark a property as Purchased in Inputs to project it.</div>';
      return;
    }
    const gs = E.growthScenarios(owned);
    $('#growth-table').innerHTML = `
      <thead><tr><th>Capital growth</th><th>10-yr equity</th><th>Exit proceeds</th>
      <th>Net position at sale</th><th>IRR</th></tr></thead><tbody>
      ${gs.map((s) => `<tr>
        <td><strong>${(s.growth * 100).toFixed(0)}%</strong></td>
        <td>${fmtMoney(s.tenYearEquity)}</td>
        <td>${fmtMoney(s.netSaleProceeds)}</td>
        <td>${signed(s.totalNetPosition)}</td>
        <td>${s.irr == null ? '—' : (s.irr * 100).toFixed(1) + '%'}</td>
      </tr>`).join('')}
      </tbody>`;
  }

  // Per-property summary table on the Overview page.
  function renderOverviewProps() {
    const t = $('#overview-props');
    if (!t) return;
    const props = state.result.properties || [];
    const pporValue = Number(state.inputs.pporValue) || 0;
    if (!props.length && pporValue <= 0) { t.innerHTML = ''; return; }
    t.innerHTML = `
      <thead><tr><th>Property</th><th>Price</th><th>Rent (wk)</th><th>Loan / LVR</th>
      <th>Yr-1 out-of-pocket (wk)</th><th>10-yr equity</th><th>IRR</th><th>Score</th><th>Sells</th></tr></thead><tbody>
      ${props.map((p) => {
        const m = p.metrics;
        const y1 = p.rows[0] || {};
        const irrTxt = m.irrApproximation === null ? 'n/a' : fmtPct(m.irrApproximation, 1);
        const score = p.score ? `${p.score.score} <span class="sub">${escapeHtml(p.score.band)}</span>` : '—';
        return `<tr>
          <td>${escapeHtml(ipLabel(p, p.index))}${p.ownershipStatus && p.ownershipStatus !== 'purchased' ? ` <span class="status-chip ${p.ownershipStatus}">${STATUS_LABELS[p.ownershipStatus]}</span>` : ''}</td>
          <td>${fmtMoney(m.purchasePrice)}</td>
          <td>${fmtMoney((y1.weeklyRent || 0))}</td>
          <td>${fmtMoney(m.ipLoanAmount)} @ ${fmtPct(m.ipLvrActual, 0)}</td>
          <td>${fmtMoney(Math.max(0, m.weeklyOutOfPocket))}</td>
          <td>${fmtMoney(m.tenYearEquity)}</td>
          <td>${irrTxt}</td>
          <td>${score}</td>
          <td>Y${m.saleYear}</td>
        </tr>`;
      }).join('')}
      ${pporValue > 0 ? `<tr class="portfolio-ppor-row"><td>PPOR · Home</td><td>${fmtMoney(pporValue)}</td><td>—</td><td>${fmtMoney(Number(state.inputs.pporLoanBalance)||0)}</td><td>—</td><td>${fmtMoney(pporValue-(Number(state.inputs.pporLoanBalance)||0))}</td><td>—</td><td>Home</td><td>—</td></tr>` : ''}
      </tbody>`;
  }

  // ------------------------------------------------------------------
  // Cash flow section
  // ------------------------------------------------------------------

  // PPOR cash flow: the home's own running costs + household loan
  // commitments. Pre-tax only — the deductible share of the top-up
  // interest is already assessed inside the portfolio's tax numbers.
  function renderCashFlowPpor() {
    const rows = (state.result.ppor && state.result.ppor.rows) || [];
    const sel = $('#cf-year');
    const keep = Math.min(state.cfYear, rows.length);
    sel.innerHTML = rows.map((r) => `<option value="${r.year}" ${r.year === keep ? 'selected' : ''}>Year ${r.year} (${r.calendarYear})</option>`).join('');
    state.cfYear = keep;
    const row = rows[keep - 1];

    renderAnalyticsInsight('cf-insight',[
      {label:'Effective rental income',value:fmtMoney(row.effectiveRent),detail:'After vacancy allowance'},
      {label:'Net operating income',value:fmtMoney(row.netOperatingIncome),detail:'Before loan principal'},
      {label:'After-tax cash flow',value:signed(row.afterTaxCashFlow),detail:'Year '+row.year+' · '+(row.afterTaxCashFlow>=0?'surplus':'cash contribution required'),tone:row.afterTaxCashFlow>=0?'good':'warn'},
      {label:'Total debt service',value:fmtMoney(row.ipInterest+row.equityLoanInterest+row.ipPrincipalRepayment+row.equityLoanPrincipalRepayment),detail:'Interest plus principal'}
    ],'Year '+row.year+' · '+row.calendarYear);
    const deductShare = state.result.inputs.equityLoanPurposePercent;

    $('#cf-subtitle').textContent =
      `Your home — owner-occupied, no rent. Top-up interest is deductible only for the investment share (${fmtPct(deductShare, 0)}); that refund already shows in the portfolio view.`;

    const line = (label, annual, bold) =>
      `<tr ${bold ? 'style="font-weight:600"' : ''}><td>${label}</td><td>${fmtMoney(annual)}</td><td>${fmtMoney(annual / 52)}</td></tr>`;

    $('#cf-table').innerHTML = `
      <thead><tr><th>Line item</th><th>Annual</th><th>Weekly</th></tr></thead><tbody>
      ${line('Council rates', -row.councilRates)}
      ${line('Water rates', -row.waterRates)}
      ${line('Insurance', -row.insurance)}
      ${line('Maintenance', -row.maintenance)}
      ${line('PPOR loan interest', -row.pporLoanInterest)}
      ${line('PPOR loan principal', -row.pporLoanPrincipalRepayment)}
      ${line('Equity-release loan interest', -row.equityLoanInterest)}
      ${deductShare < 1 ? line(`&nbsp;&nbsp;· deductible share (${fmtPct(deductShare, 0)}) assessed in the portfolio`, -row.equityLoanDeductiblePortion) : ''}
      ${line('Equity-release loan principal', -row.equityLoanPrincipalRepayment)}
      ${line('Total household outflow', -row.totalOutflow, true)}
      </tbody>`;

    // chart headers differ from the IP view — set them here, reset below
    $('#cf-chart-expenses-title').textContent = 'Running costs by year';
    $('#cf-chart-cash-title').textContent = 'Loan repayments: interest vs principal';

    const labels = rows.map((r) => 'Y' + r.year);
    const ds = (label, key, color) => ({
      label, data: rows.map((r) => r[key]), backgroundColor: color, stack: 'opex',
    });
    drawChart('chart-cf-expenses', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          ds('Council rates', 'councilRates', COLORS.teal),
          ds('Water rates', 'waterRates', COLORS.purple),
          ds('Insurance', 'insurance', COLORS.amber),
          ds('Maintenance', 'maintenance', COLORS.pri),
        ],
      },
      options: Object.assign(baseOpts(), { scales: { x: { stacked: true, ticks: { font: { size: 11 } } }, y: { stacked: true, ticks: { font: { size: 11 }, callback: (v) => fmtMoney(v) } } } }),
    });

    drawChart('chart-cf-cash', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Loan interest', data: rows.map((r) => r.pporLoanInterest + r.equityLoanInterest), backgroundColor: COLORS.red },
          { label: 'Loan principal', data: rows.map((r) => r.pporLoanPrincipalRepayment + r.equityLoanPrincipalRepayment), backgroundColor: COLORS.pri },
        ],
      },
      options: baseOpts(),
    });
  }

  function renderCashFlow() {
    fillViewSelect($('#cf-prop'), true);
    if (state.viewProp === 'ppor') {
      renderCashFlowPpor();
      return;
    }
    $('#cf-chart-expenses-title').textContent = 'Operating expenses by year';
    $('#cf-chart-cash-title').textContent = 'Cash flow: pre-tax vs after-tax';
    const rows = viewData().rows;
    const sel = $('#cf-year');
    const keep = Math.min(state.cfYear, rows.length);
    sel.innerHTML = rows.map((r) => `<option value="${r.year}" ${r.year === keep ? 'selected' : ''}>Year ${r.year} (${r.calendarYear})</option>`).join('');
    state.cfYear = keep;
    const row = rows[keep - 1];

    $('#cf-subtitle').textContent =
      `${row.inInterestOnlyPeriod ? 'Interest-only period' : 'P&I repayments'} · land tax ${fmtMoney(row.landTax)} · marginal refund computed on taxable result ${signed(row.taxablePropertyResult)}`;

    const line = (label, annual, weekly, bold) =>
      `<tr ${bold ? 'style="font-weight:600"' : ''}><td>${label}</td><td>${fmtMoney(annual)}</td><td>${fmtMoney(annual / 52)}</td></tr>`;

    $('#cf-table').innerHTML = `
      <thead><tr><th>Line item</th><th>Annual</th><th>Weekly</th></tr></thead><tbody>
      ${line('Gross rent', row.grossRent)}
      ${line('Less vacancy', -row.vacancyLoss)}
      ${line('Effective rent', row.effectiveRent, null, true)}
      ${line('Management fees', -row.managementFees)}
      ${line('Letting fees (amortised)', -row.lettingFees)}
      ${line('Renewal / admin fees', -row.renewalFee)}
      ${line('Council rates', -row.councilRates)}
      ${line('Water rates', -row.waterRates)}
      ${line('Insurance', -row.insurance)}
      ${line('Body corporate', -row.bodyCorporate)}
      ${line('Maintenance allowance', -row.maintenance)}
      ${line('Land tax', -row.landTax)}
      ${line('Loan fees', -row.ipLoanFees)}
      ${line('IP loan interest', -row.ipInterest)}
      ${line('Equity-release loan interest', -row.equityLoanInterest)}
      ${row.equityLoanPurposePercent < 1 ? line(`&nbsp;&nbsp;· deductible portion (${fmtPct(state.result.inputs.equityLoanPurposePercent, 0)})`, -row.deductibleEquityInterest) : ''}
      ${line('Net operating income (pre-finance)', row.netOperatingIncome, null, true)}
      ${line('IP principal repayment', -row.ipPrincipalRepayment)}
      ${line('Equity loan principal repayment', -row.equityLoanPrincipalRepayment)}
      ${line('Pre-tax cash flow', row.preTaxCashFlow, null, true)}
      ${row.otherDeductibleClaims ? line('Other deductible claims', -row.otherDeductibleClaims) : ''}
      ${line('Capital works depreciation (non-cash)', -row.capitalWorksDepreciation)}
      ${line('Plant & equipment depreciation (non-cash)', -row.plantEquipmentDepreciation)}
      ${row.lmiAmortisation ? line('LMI amortisation (non-cash)', -row.lmiAmortisation) : ''}
      ${line('Taxable property result', row.taxablePropertyResult)}
      ${line('Tax refund / (cost)', row.taxRefundOrCost, null, true)}
      ${line('After-tax cash flow', row.afterTaxCashFlow, null, true)}
      </tbody>`;

    // stacked operating expenses
    const labels = rows.map((r) => 'Y' + r.year);
    const ds = (label, key, color) => ({
      label, data: rows.map((r) => r[key]), backgroundColor: color, stack: 'opex',
    });
    drawChart('chart-cf-expenses', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          ds('Management', 'managementFees', COLORS.pri),
          ds('Maintenance', 'maintenance', COLORS.amber),
          ds('Rates & water', 'councilRates', COLORS.teal),
          ds('Insurance', 'insurance', COLORS.purple),
          ds('Body corporate', 'bodyCorporate', COLORS.pink),
          ds('Land tax', 'landTax', COLORS.red),
        ],
      },
      options: Object.assign(baseOpts(), { scales: { x: { stacked: true, ticks: { font: { size: 11 } } }, y: { stacked: true, ticks: { font: { size: 11 }, callback: (v) => fmtMoney(v) } } } }),
    });

    drawChart('chart-cf-cash', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Pre-tax', data: rows.map((r) => r.preTaxCashFlow), backgroundColor: COLORS.amber },
          { label: 'After-tax', data: rows.map((r) => r.afterTaxCashFlow), backgroundColor: COLORS.pri },
        ],
      },
      options: baseOpts(),
    });
  }

  // ------------------------------------------------------------------
  // Projections section
  // ------------------------------------------------------------------

  function renderProjections() {
    fillViewSelect($('#proj-prop'));
    const view = viewData({ owned: true });
    if (view.ownedEmpty) {
      $('#proj-table').innerHTML =
        '<div class="empty-note">Portfolio projections cover purchased properties — mark one as Purchased in Inputs to project it here.</div>';
      renderAnalyticsInsight('proj-insight', [], '');
      return;
    }
    const rows = view.rows;
    const ioEnd = rows.find((r) => !r.inInterestOnlyPeriod);

    const first=rows[0], last=rows[rows.length-1];
    renderAnalyticsInsight('proj-insight',[
      {label:'Property value growth',value:fmtMoney(last.propertyValue-first.propertyValue),detail:'Projected change over '+rows.length+' years'},
      {label:'Ending equity',value:fmtMoney(last.netEquity),detail:'Property value less debt',tone:last.netEquity>=0?'good':'warn'},
      {label:'Debt reduction',value:fmtMoney(first.totalDebt-last.totalDebt),detail:'Change in total loan balance'},
      {label:'Year-one cash flow',value:signed(first.afterTaxCashFlow),detail:'After tax',tone:first.afterTaxCashFlow>=0?'good':'warn'}
    ],'Full holding period');
    $('#proj-table').innerHTML = `
      <thead><tr>
        <th>Yr</th><th>Value</th><th>Rent</th><th>NOI</th><th>Interest</th>
        <th>Principal</th><th>After-tax CF</th><th>Cum. CF</th>
        <th>Debt</th><th>Equity</th><th>Cum. position</th>
      </tr></thead><tbody>
      ${rows.map((r) => `
        <tr class="${ioEnd && r.year === ioEnd.year ? 'io-end' : ''}">
          <td>Y${r.year} · ${r.calendarYear}</td>
          <td>${fmtMoney(r.propertyValue)}</td>
          <td>${fmtMoney(r.grossRent)}</td>
          <td>${fmtMoney(r.netOperatingIncome)}</td>
          <td>${fmtMoney(r.ipInterest + r.equityLoanInterest)}</td>
          <td>${fmtMoney(r.ipPrincipalRepayment + r.equityLoanPrincipalRepayment)}</td>
          <td>${signed(r.afterTaxCashFlow)}</td>
          <td>${signed(r.cumulativeAfterTaxCashFlow)}</td>
          <td>${fmtMoney(r.totalDebt)}</td>
          <td>${fmtMoney(r.netEquity)}</td>
          <td>${signed(r.cumulativePosition)}</td>
        </tr>`).join('')}
      </tbody>`;

    const labels = rows.map((r) => 'Y' + r.year);
    drawChart('chart-proj-value', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Property value', data: rows.map((r) => r.propertyValue), borderColor: COLORS.pri, tension: 0.15, pointRadius: 0 },
          { label: 'Total debt', data: rows.map((r) => r.totalDebt), borderColor: COLORS.red, tension: 0.15, pointRadius: 0 },
          { label: 'Net equity', data: rows.map((r) => r.netEquity), borderColor: COLORS.green, tension: 0.15, pointRadius: 0 },
        ],
      },
      options: baseOpts(),
    });
    drawChart('chart-proj-rent', {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Gross rent', data: rows.map((r) => r.grossRent), borderColor: COLORS.green, tension: 0.15, pointRadius: 0 },
          { label: 'Operating expenses', data: rows.map((r) => r.operatingExpenses), borderColor: COLORS.amber, tension: 0.15, pointRadius: 0 },
          { label: 'Interest (both loans)', data: rows.map((r) => r.ipInterest + r.equityLoanInterest), borderColor: COLORS.red, tension: 0.15, pointRadius: 0 },
        ],
      },
      options: baseOpts(),
    });
  }

  // ------------------------------------------------------------------
  // Exit / CGT section
  // ------------------------------------------------------------------

  function renderExit() {
    const view = viewData({ owned: true });
    fillViewSelect($('#exit-prop'));
    if (view.ownedEmpty) {
      $('#exit-cards').innerHTML =
        '<div class="empty-note">Exit outlook covers purchased properties — mark one as Purchased in Inputs to see its sale analysis.</div>';
      renderAnalyticsInsight('exit-insight', [], '');
      return;
    }
    const x = view.exit;
    const profit = x.totalNetPosition;

    renderAnalyticsInsight('exit-insight',[
      {label:'Gross capital gain',value:fmtMoney(x.capitalGain),detail:'Before CGT discount'},
      {label:'Estimated CGT',value:fmtMoney(x.capitalGainsTax),detail:'Based on entered marginal rate',tone:'warn'},
      {label:'Net sale proceeds',value:fmtMoney(x.netSaleProceeds),detail:'After selling costs, CGT and loans'},
      {label:'Total net position',value:fmtMoney(profit),detail:'Includes cumulative cash flow and initial cash',tone:profit>=0?'good':'warn'}
    ],'Sale year '+x.saleYear);
    const sellingSub = view.propInputs
      ? `${fmtPct(view.propInputs.sellingCostRate, 1)} + fixed`
      : 'combined across properties';
    const purchasePrice = view.propInputs ? view.propInputs.purchasePrice : view.metrics.purchasePrice;
    // Per-property rows carry no cumulative column — sum the yearly flows.
    const cumAtSale = view.propInputs
      ? view.rows.slice(0, x.saleYear).reduce((s, r) => s + r.afterTaxCashFlow, 0)
      : view.rows[x.saleYear - 1].cumulativeAfterTaxCashFlow;

    $('#exit-cards').innerHTML =
      card(`Sale price (year ${x.saleYear}, ${x.calendarSaleYear})`, fmtMoney(x.salePrice)) +
      card('Selling costs', fmtMoney(x.sellingCosts), sellingSub) +
      card('Capital gain', fmtMoney(x.capitalGain), `Cost base ${fmtMoney(x.costBase)}`) +
      card('CGT', fmtMoney(x.capitalGainsTax), `50% discount applied: ${x.discountRate ? 'yes' : 'no'} · rate ${fmtPct(x.cgtRate, 0)}`) +
      card('Net sale proceeds', fmtMoney(x.netSaleProceeds), 'after costs, CGT & loans') +
      card('Total net position', fmtMoney(profit), 'proceeds + cumulative CF − cash in', profit >= 0 ? 'good' : 'bad');

    const line = (label, v, bold) =>
      `<tr ${bold ? 'style="font-weight:600"' : ''}><td>${label}</td><td>${signed(v)}</td></tr>`;
    $('#exit-table').innerHTML = `
      <thead><tr><th>Item</th><th>Amount</th></tr></thead><tbody>
      ${line('Sale price', x.salePrice)}
      ${line('Less selling costs', -x.sellingCosts)}
      ${line('Cost base: purchase price', purchasePrice)}
      ${line('Cost base: duty & acquisition costs', view.upfront.acquisitionCosts)}
      ${line('Cost base: less capital works claimed', -x.capitalWorksClaimed)}
      ${line('Cost base total', x.costBase, true)}
      ${line('Capital gain before discount', x.capitalGain, true)}
      ${line(`Taxable gain after ${x.discountRate * 100}% discount`, x.taxableCapitalGain)}
      ${line(`CGT at ${fmtPct(x.cgtRate, 0)} marginal rate`, -x.capitalGainsTax)}
      ${line('Repay IP loan', -x.ipLoanBalanceAtSale)}
      ${line('Repay equity-release loan', -x.equityLoanBalanceAtSale)}
      ${line('Net sale proceeds', x.netSaleProceeds, true)}
      ${line('Plus cumulative after-tax cash flow', cumAtSale)}
      ${line('Less initial cash invested', -view.upfront.initialCashInvested)}
      ${line('Total net position', x.totalNetPosition, true)}
      </tbody>`;
    $('#exit-note').textContent = x.warnings[0] || '';

    // Dedicated sale-proceeds chart on the Exit page (kept separate from
    // the dashboard's summary chart so it renders when this page is opened).
    drawChart('chart-exit-waterfall', {
      type: 'bar',
      data: {
        labels: ['Sale price', 'Selling costs', 'Capital gains tax', 'IP loan payout', 'Equity loan payout', 'Net sale proceeds'],
        datasets: [{
          label: 'Estimated amount',
          data: [x.salePrice, -x.sellingCosts, -x.capitalGainsTax,
            -x.ipLoanBalanceAtSale, -x.equityLoanBalanceAtSale, x.netSaleProceeds],
          backgroundColor: [COLORS.pri, COLORS.red, COLORS.amber, COLORS.red, COLORS.red, COLORS.green],
          borderRadius: 6,
        }],
      },
      options: {
        ...baseOpts((v) => (v < 0 ? '−' : '') + fmtMoney(Math.abs(v), 0)),
        indexAxis: 'y',
        plugins: { ...baseOpts().plugins, legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => ' ' + signed(ctx.parsed.x) } } },
        scales: {
          x: { ticks: { color: cssVar('--chart-tick') || '#64748b', callback: (v) => (v < 0 ? '−' : '') + fmtMoney(Math.abs(v), 0) }, grid: { color: cssVar('--chart-grid') || 'rgba(15, 23, 42, 0.08)' } },
          y: { ticks: { color: cssVar('--chart-tick') || '#64748b' }, grid: { display: false } },
        },
      },
    });
  }

  // ------------------------------------------------------------------
  // Borrowing section
  // ------------------------------------------------------------------

  function renderBorrowing() {
    const b = state.result.borrowing;

    renderAnalyticsInsight('borrowing-insight',[
      {label:'Monthly surplus',value:fmtMoney(b.monthlySurplus),detail:'After assessed commitments',tone:b.monthlySurplus>=0?'good':'warn'},
      {label:'Indicative new borrowing',value:fmtMoney(b.maxNewLoan),detail:'Modelled serviceability estimate',tone:b.maxNewLoan>0?'good':'warn'},
      {label:'Debt-to-income',value:b.estimatedDTI?b.estimatedDTI.toFixed(1)+'x':'—',detail:'Compare with your warning threshold',tone:b.estimatedDTI>state.result.inputs.bcDtiWarn?'warn':'good'},
      {label:'Assessment buffer',value:fmtPct(b.assessmentBuffer,1),detail:'Added to loan rates for assessment'}
    ],'Indicative only · lender policy varies');
    $('#borrowing-cards').innerHTML =
      card('Assessable income', fmtMoney(b.assessableIncome), `rent shaded: ${fmtMoney(b.rentAssessed)}`) +
      card('Living expenses', fmtMoney(b.livingExpenses)) +
      card('Existing repayments (assessed)', fmtMoney(b.existingRepayments), `PPOR ${fmtMoney(b.pporRepayAssessed)} + equity ${fmtMoney(b.equityRepayAssessed)}`) +
      card('Proposed IP repayment (assessed)', fmtMoney(b.proposedRepayAssessed), `on ${fmtMoney(b.proposedLoan)} at rate + ${fmtPct(b.assessmentBuffer, 1)}`) +
      card('Monthly surplus', fmtMoney(b.monthlySurplus), b.monthlySurplus >= 0 ? '' : 'negative — no capacity', b.monthlySurplus >= 0 ? 'good' : 'bad') +
      card('Max additional loan', fmtMoney(b.maxNewLoan), '', b.maxNewLoan > 0 ? 'good' : 'bad') +
      card('Est. DTI after purchase', b.estimatedDTI ? b.estimatedDTI.toFixed(1) + 'x' : '—', `warn above ${state.result.inputs.bcDtiWarn}x`);

    const sens = state.result.borrowingSensitivity;
    drawChart('chart-bc-sens', {
      type: 'line',
      data: {
        labels: sens.map((s) => (s.rate * 100).toFixed(2) + '%'),
        datasets: [{
          label: 'Max additional borrowing',
          data: sens.map((s) => s.maxNewLoan),
          borderColor: COLORS.pri, backgroundColor: 'rgba(37,99,235,0.1)',
          tension: 0.15, fill: true, pointRadius: 3,
        }],
      },
      options: baseOpts(),
    });
  }

  // ------------------------------------------------------------------
  // Area report: suburb data, investment score, comps, bank rates
  // ------------------------------------------------------------------

  function currentSuburb() {
    const id = Number(state.inputs.suburbId) || 0;
    return state.suburbs.find((s) => s.id === id) || null;
  }

  async function loadAreaData() {
    const [suburbs, rates] = await Promise.all([
      api('/api/suburbs').catch(() => []),
      api('/api/bank-rates').catch(() => []),
    ]);
    state.suburbs = suburbs || [];
    state.bankRates = rates || [];
    renderSuburbSelect();
    renderRatesTable();
    renderSuburbTable();
    renderRateHint();
    // suburb metric history (trend analysis) — fills in after a few days
    // of daily snapshots; absent today is fine
    state.suburbHistory = null;
    const sid = currentSuburb() && currentSuburb().id;
    if (sid) {
      state.suburbHistory = await api(`/api/suburbs/${sid}/history`)
        .catch(() => null);
    }
    recalc();
  }

  function renderSuburbSelect() {
    const sel = $('#suburb-select');
    if (!sel) return;
    const cur = Number(state.inputs.suburbId) || 0;
    sel.innerHTML = '<option value="0">— not set —</option>' +
      state.suburbs.map((s) =>
        `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${escapeHtml(s.name)} ${escapeHtml(s.postcode)}</option>`
      ).join('');
    const aiSel = $('#suburb-ai-select');
    if (aiSel) {
      aiSel.innerHTML = '<option value="0">— pick a suburb —</option>' +
        state.suburbs.map((s) =>
          `<option value="${s.id}">${escapeHtml(s.name)} ${escapeHtml(s.postcode)}${s.state ? ', ' + escapeHtml(s.state) : ''}</option>`
        ).join('');
    }
  }

  function renderRateHint() {
    const el = $('#ip-rate-hint');
    if (!el) return;
    if (!state.bankRates.length) {
      el.textContent = 'No investor rates loaded yet.';
      return;
    }
    const parts = state.bankRates
      .filter((r) => r.investorIoRate)
      .map((r) => `${escapeHtml(r.bankName)} ${(r.investorIoRate * 100).toFixed(2)}%`);
    const checked = state.bankRates.find((r) => r.checkedAt);
    let freshness = '';
    if (checked) {
      const m = /^(\d{4})-(\d{2})/.exec(checked.checkedAt);
      if (m) {
        const monthsOld =
          (Date.now() - new Date(+m[1], +m[2] - 1, 1).getTime()) / (1000 * 60 * 60 * 24 * 30.4);
        if (monthsOld > 4) {
          freshness = ' — rates look stale, run "Suggest current rates (AI)" in Area & suburb → Bank investor rates';
        }
      }
    }
    el.textContent = 'Advertised investor IO rates: ' + parts.join(' · ') +
      (checked ? ' (checked ' + checked.checkedAt + ')' : '') + freshness;
  }

  function sourceNote(suburb, field) {
    const meta = suburb && suburb.sources && suburb.sources[field];
    if (!meta) return '';
    return `${meta.source || ''}${meta.asOf ? ' · ' + meta.asOf : ''}`;
  }

  function statCard(label, value, sub) {
    return `<div class="card stat-card"><div class="label">${label}</div>
      <div class="value">${value}</div><div class="sub">${sub || ''}</div></div>`;
  }

  function renderArea() {
    const s = currentSuburb();
    renderRiskChecklist();
    const cards = $('#area-cards');
    const links = $('#area-links');
    const score = state.result.score;

    if (!s) {
      cards.innerHTML = `<div class="card"><div class="label">No suburb selected</div>
        <div class="value" style="font-size:16px">Pick a suburb in Inputs</div>
        <div class="sub">Suburb stats, the investment score and reference links appear here.</div></div>`;
      links.innerHTML = '';
      $('#score-panel').innerHTML = '';
      $('#score-table').innerHTML = '';
      renderCompTable();
      return;
    }

    const money = (v) => (v ? fmtMoney(v) : '—');
    cards.innerHTML = [
      statCard('Median sale price', money(s.medianPrice), sourceNote(s, 'medianPrice')),
      statCard('Median rent 2-bed', s.medianRent2Bed ? fmtMoney(s.medianRent2Bed) + '/wk' : '—', sourceNote(s, 'medianRent2Bed')),
      statCard('Median rent 3-bed', s.medianRent3Bed ? fmtMoney(s.medianRent3Bed) + '/wk' : '—', sourceNote(s, 'medianRent3Bed')),
      statCard('Median rent 4-bed', s.medianRent4Bed ? fmtMoney(s.medianRent4Bed) + '/wk' : '—', sourceNote(s, 'medianRent4Bed')),
      statCard('Vacancy rate', s.vacancyPct != null ? s.vacancyPct.toFixed(1) + '%' : '—', sourceNote(s, 'vacancyPct')),
      statCard('5-yr capital growth', s.growth5yrPct != null ? s.growth5yrPct.toFixed(0) + '%' : '—', sourceNote(s, 'growth5yrPct')),
      statCard('Population growth', s.populationGrowthPct != null ? s.populationGrowthPct.toFixed(1) + '%' : '—', sourceNote(s, 'populationGrowthPct')),
      statCard('Days on market', s.medianDaysOnMarket != null ? fmtNum(s.medianDaysOnMarket) : '—', sourceNote(s, 'medianDaysOnMarket')),
      ...(s.sa2Code ? [statCard('ABS SA2', escapeHtml(s.sa2Code),
        'Census crosswalk — full SA2 profile in Deal Check')] : []),
    ].join('');

    // Trend block — appears once a few daily snapshots have accumulated
    const trend = $('#area-trend');
    if (trend) {
      const hist = state.suburbHistory || {};
      const rows = Object.entries(hist)
        .filter(([, pts]) => pts.length >= 2)
        .map(([metric, pts]) => {
          const first = pts[0].value, last = pts[pts.length - 1].value;
          const delta = last - first;
          const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '·';
          return `<tr><td>${escapeHtml(metric)}</td><td>${fmtMoney(first)}</td>` +
                 `<td>${fmtMoney(last)}</td><td>${arrow} ${fmtMoney(Math.abs(delta))}</td></tr>`;
        }).join('');
      trend.innerHTML = rows
        ? `<h2>Trend <span class="unit">daily snapshots</span></h2>
           <div class="table-wrap"><table>
           <thead><tr><th>Metric</th><th>First</th><th>Latest</th><th>Change</th></tr></thead>
           <tbody>${rows}</tbody></table></div>`
        : '';
    }

    const pc = encodeURIComponent(s.postcode);
    const slug = encodeURIComponent(String(s.name).toLowerCase().replace(/\s+/g, '-'));
    const isVicSuburb = String(s.state || '').toUpperCase() === 'VIC';
    const sourceLinks = isVicSuburb ? [
      `<a href="https://www.land.vic.gov.au/valuations/resources-and-reports/property-sales-statistics" target="_blank" rel="noopener">Valuer-General Victoria sales statistics</a>`,
      `<a href="https://www.dffh.vic.gov.au/publications/rental-report" target="_blank" rel="noopener">Homes Victoria rental report</a>`,
      `<a href="https://discover.data.vic.gov.au/dataset/vicmap-property-rest-api" target="_blank" rel="noopener">Vicmap property data</a>`,
      `<a href="https://discover.data.vic.gov.au/" target="_blank" rel="noopener">DataVic open datasets</a>`,
    ] : [
      `<a href="https://www.realestate.com.au/suburb/${slug}-qld-${pc}" target="_blank" rel="noopener">REA suburb profile</a>`,
      `<a href="https://www.rta.qld.gov.au/property-and-land/rental-bond-and-housing-advice/median-rent-search" target="_blank" rel="noopener">RTA median rents</a>`,
      `<a href="https://sqmresearch.com.au/total-vacancy-search.php?postcode=${pc}&type=4" target="_blank" rel="noopener">SQM vacancy ${escapeHtml(s.postcode)}</a>`,
      `<a href="https://www.qld.gov.au/land-valuation" target="_blank" rel="noopener">QLD land valuation</a>`,
      `<a href="https://globe.qld.gov.au/" target="_blank" rel="noopener">QLD Globe</a>`,
    ];
    links.innerHTML = 'Check the source yourself: ' + sourceLinks.join(' · ');

    const bandClass = 'band-' + score.band.replace(/\s+/g, '-');
    $('#score-panel').innerHTML = `
      <div class="score-big ${bandClass}">${score.score}</div>
      <div>
        <div class="score-band ${bandClass}">${score.band}</div>
        <div class="score-note">${score.scoredMax} of 100 points scored${
          score.missing.length ? ` · ${score.missing.length} factor(s) without data` : ''}</div>
      </div>
      <div class="factors">
        ${score.factors.map((f) => `
          <div class="factor-row ${f.scored ? '' : 'unscored'}">
            <span>${f.label}</span>
            <span>${f.display}</span>
            <span>${f.scored ? f.points + '/' + f.maxPoints : '—'}</span>
            <span class="factor-bar"><span style="width:${f.maxPoints ? (f.points / f.maxPoints) * 100 : 0}%"></span></span>
          </div>`).join('')}
      </div>`;

    $('#score-table').innerHTML = `
      <thead><tr><th>Factor</th><th>Value</th><th>Points</th><th>Band</th>
      <th>Why it matters</th><th>Source</th></tr></thead><tbody>
      ${score.factors.map((f) => `<tr class="${f.scored ? '' : 'unscored'}">
        <td>${f.label}</td>
        <td>${f.display}</td>
        <td>${f.scored ? f.points + '/' + f.maxPoints : 'not scored'}</td>
        <td>${f.band}</td>
        <td>${f.rationale}</td>
        <td class="factor-src">${f.source || ''}</td>
      </tr>`).join('')}
      </tbody>`;

    renderCompTable();
  }

  function renderCompTable() {
    const t = $('#comp-table');
    if (!t) return;
    if (!state.scenarioId) {
      t.innerHTML = '<tr><td>Save the scenario first to attach comparable sales.</td></tr>';
      return;
    }
    if (!state.comps.length) {
      t.innerHTML = '<tr><td>No comparables yet — paste one from realestate.com.au above.</td></tr>';
      return;
    }
    t.innerHTML = `
      <thead><tr><th>Address</th><th>Sold</th><th>Date</th><th>Beds</th><th>Land</th>
      <th>Rent</th><th>$/m²</th><th>Yield</th><th>vs subject</th><th></th></tr></thead><tbody>
      ${state.comps.map((c) => {
        const d = E.compDerivations(c, state.inputs);
        const label = escapeHtml(c.address || 'listing');
        return `<tr>
          <td>${c.url ? `<a class="comp-link" href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${label}</a>` : label}</td>
          <td>${c.soldPrice ? fmtMoney(c.soldPrice) : '—'}</td>
          <td>${escapeHtml(c.soldDate || '')}</td>
          <td>${c.beds != null ? c.beds : '—'}</td>
          <td>${c.landM2 ? fmtNum(c.landM2) + ' m²' : '—'}</td>
          <td>${c.rentEstimate ? fmtMoney(c.rentEstimate) : '—'}</td>
          <td>${d.perM2 ? fmtMoney(d.perM2) : '—'}</td>
          <td>${d.impliedGrossYield ? fmtPct(d.impliedGrossYield) : '—'}</td>
          <td>${d.priceRatio ? (d.priceRatio >= 1 ? '+' : '') + fmtPct(d.priceRatio - 1) : '—'}</td>
          <td><button data-del-comp="${c.id}" class="danger">×</button></td>
        </tr>`;
      }).join('')}
      </tbody>`;
  }

  async function loadComps() {
    if (!state.scenarioId) {
      state.comps = [];
      state.rentals = [];
      renderCompTable();
      renderRentalTable();
      return;
    }
    try {
      state.comps = await api(`/api/scenarios/${state.scenarioId}/comps`);
    } catch (err) {
      state.comps = [];
    }
    try {
      state.rentals = await api(`/api/scenarios/${state.scenarioId}/rentals`);
    } catch (err) {
      state.rentals = [];
    }
    renderCompTable();
    renderRentalTable();
  }

  function renderRatesTable() {
    const t = $('#rates-table');
    if (!t) return;
    if (!state.bankRates.length) {
      t.innerHTML = '<tr><td>No rates yet — add one below.</td></tr>';
      return;
    }
    t.innerHTML = `
      <thead><tr><th>Bank</th><th>Investor IO</th><th>Investor P&amp;I</th>
      <th>Source</th><th>Checked</th><th></th></tr></thead><tbody>
      ${state.bankRates.map((r) => `<tr>
        <td>${escapeHtml(r.bankName)}</td>
        <td><input type="number" step="0.01" data-rate-io="${r.id}" value="${r.investorIoRate != null ? (r.investorIoRate * 100).toFixed(2) : ''}"></td>
        <td><input type="number" step="0.01" data-rate-pi="${r.id}" value="${r.investorPiRate != null ? (r.investorPiRate * 100).toFixed(2) : ''}"></td>
        <td><input type="text" autocomplete="off" data-rate-src="${r.id}" value="${escapeHtml(r.source || '')}"></td>
        <td>${escapeHtml(r.checkedAt || '')}</td>
        <td class="scenario-row">
          <button data-save-rate="${r.id}">Save</button>
          <button data-del-rate="${r.id}" class="danger">×</button>
        </td>
      </tr>`).join('')}
      </tbody>`;
  }

  function renderSuburbTable() {
    const t = $('#suburb-table');
    if (!t) return;
    if (!state.suburbs.length) {
      t.innerHTML = '<tr><td>No suburbs yet — add one below.</td></tr>';
      return;
    }
    t.innerHTML = `
      <thead><tr><th>Suburb</th><th>Median price</th><th>3-bed rent</th>
      <th>Vacancy</th><th>5-yr growth</th><th></th></tr></thead><tbody>
      ${state.suburbs.map((s) => `<tr>
        <td>${escapeHtml(s.name)} ${escapeHtml(s.postcode)}</td>
        <td><input type="number" data-sub-price="${s.id}" value="${s.medianPrice != null ? s.medianPrice : ''}"></td>
        <td><input type="number" data-sub-rent3="${s.id}" value="${s.medianRent3Bed != null ? s.medianRent3Bed : ''}"></td>
        <td><input type="number" step="0.1" data-sub-vacancy="${s.id}" value="${s.vacancyPct != null ? s.vacancyPct : ''}"></td>
        <td><input type="number" step="1" data-sub-growth="${s.id}" value="${s.growth5yrPct != null ? s.growth5yrPct : ''}"></td>
        <td class="scenario-row">
          <button data-save-sub="${s.id}">Save</button>
          <button data-del-sub="${s.id}" class="danger">×</button>
        </td>
      </tr>`).join('')}
      </tbody>`;
  }

  // --- area event wiring -------------------------------------------------

  $('#suburb-select').addEventListener('change', (ev) => {
    state.inputs.suburbId = Number(ev.target.value) || 0;
    scheduleRecalc();
  });

  $('#btn-add-comp').addEventListener('click', async () => {
    if (!state.scenarioId) {
      $('#comp-msg').textContent = 'Save the scenario first.';
      return;
    }
    const body = {
      address: $('#comp-address').value.trim(),
      soldPrice: $('#comp-price').value ? Number($('#comp-price').value) : null,
      soldDate: $('#comp-date').value.trim(),
      beds: $('#comp-beds').value ? Number($('#comp-beds').value) : null,
      landM2: $('#comp-land').value ? Number($('#comp-land').value) : null,
      rentEstimate: $('#comp-rent').value ? Number($('#comp-rent').value) : null,
      url: $('#comp-url').value.trim(),
    };
    try {
      await api(`/api/scenarios/${state.scenarioId}/comps`, { method: 'POST', body: JSON.stringify(body) });
      ['#comp-address', '#comp-price', '#comp-date', '#comp-beds', '#comp-land', '#comp-rent', '#comp-url']
        .forEach((sel) => { $(sel).value = ''; });
      $('#comp-msg').textContent = 'Comparable added.';
      await loadComps();
      recalc();
    } catch (err) {
      $('#comp-msg').textContent = 'Could not add: ' + err.message;
    }
  });

  $('#comp-table').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-del-comp]');
    if (!btn) return;
    try {
      await api('/api/comps/' + btn.dataset.delComp, { method: 'DELETE' });
      await loadComps();
      recalc();
    } catch (err) { toast('Delete failed: ' + err.message); }
  });

  // --- AI sold-comps search ---------------------------------------------

  function renderCompSearch() {
    const box = $('#comp-search-results');
    const t = $('#comp-search-table');
    box.classList.remove('hidden');
    if (!state.compCandidates.length) {
      t.innerHTML = '<tr><td>No comparables found — try a more specific address or add one manually.</td></tr>';
      return;
    }
    t.innerHTML = `
      <thead><tr><th></th><th>Address</th><th>Sold</th><th>Date</th><th>Beds</th>
      <th>~km</th><th>Land</th><th>Rent</th><th>Confidence</th><th>Source</th></tr></thead><tbody>
      ${state.compCandidates.map((c, i) => {
        const label = escapeHtml(c.address || 'listing');
        let host = c.source || '';
        try { host = new URL(c.url).hostname.replace(/^www\./, ''); } catch (e) { /* keep source */ }
        return `<tr>
          <td><input type="checkbox" data-cand="${i}" checked></td>
          <td>${c.url ? `<a class="comp-link" href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${label}</a>` : label}</td>
          <td>${c.soldPrice ? fmtMoney(c.soldPrice) : '—'}</td>
          <td>${escapeHtml(c.soldDate || '')}</td>
          <td>${c.beds != null ? c.beds : '—'}</td>
          <td>${c.distanceKm != null ? c.distanceKm + ' km' : '—'}</td>
          <td>${c.landM2 ? fmtNum(c.landM2) + ' m²' : '—'}</td>
          <td>${c.rentEstimate ? fmtMoney(c.rentEstimate) : '—'}</td>
          <td><span class="conf-${escapeHtml(c.confidence || 'low')}">${escapeHtml(c.confidence || 'low')}</span></td>
          <td>${escapeHtml(host)}</td>
        </tr>`;
      }).join('')}
      </tbody>`;
  }

  $('#btn-find-comps').addEventListener('click', async () => {
    const btn = $('#btn-find-comps');
    const hint = $('#comp-search-hint');
    if (!state.scenarioId) { hint.textContent = 'Save the scenario first.'; return; }
    const prop = state.inputs.properties[activePropertyIndex()] || {};
    const address = String(prop.address || '').trim();
    if (!address) { hint.textContent = 'Enter the subject address in Inputs first.'; return; }
    hint.textContent = '';
    btn.disabled = true;
    const stopTick = busyTicker(btn, 'Searching');
    try {
      const final = await apiStream('/api/comps/search/stream', {
        method: 'POST',
        body: JSON.stringify({ address, beds: prop.bedrooms || null }),
      }, (ev) => {
        if (ev.query) hint.textContent =
          `Searching: “${ev.query}”${ev.shard ? ' · ' + ev.shard : ''}`;
        else if (ev.note) hint.textContent = ev.note;
      });
      state.compCandidates = final.comps || [];
      $('#comp-search-msg').textContent = '';
      hint.textContent = '';
      renderCompSearch();
      stopTick();
      btn.disabled = false;
      btn.textContent = 'Find sold comps (AI)';
    } catch (err) {
      stopTick();
      btn.textContent = 'Find sold comps (AI)';
      if (/not configured/.test(err.message)) {
        hint.textContent = 'AI comps search is off — set PA_ULTIMATEAI_API_KEY in .env (needs UltimateAI gateway credits) to enable.';
        // stays disabled until the key is added and the app restarts
      } else {
        btn.disabled = false;
        hint.textContent = 'Search failed: ' + err.message;
      }
    }
  });

  $('#btn-save-comps').addEventListener('click', async () => {
    if (!state.scenarioId) return;
    const msg = $('#comp-search-msg');
    const picked = $$('input[data-cand]').filter((cb) => cb.checked)
      .map((cb) => state.compCandidates[Number(cb.dataset.cand)])
      .filter(Boolean);
    if (!picked.length) { msg.textContent = 'Tick at least one row.'; return; }
    let saved = 0;
    for (const c of picked) {
      try {
        await api(`/api/scenarios/${state.scenarioId}/comps`, {
          method: 'POST',
          body: JSON.stringify({
            address: c.address, soldPrice: c.soldPrice, soldDate: c.soldDate,
            beds: c.beds, landM2: c.landM2, rentEstimate: c.rentEstimate,
            url: c.url, notes: 'AI search (' + (c.confidence || 'low') + ' confidence'
              + (c.distanceKm != null ? ' · ~' + c.distanceKm + ' km' : '') + ')',
          }),
        });
        saved++;
        msg.textContent = `Saving… ${saved}/${picked.length}`;
      } catch (err) {
        msg.textContent = `Saved ${saved} of ${picked.length} — ${err.message}`;
        break;
      }
    }
    if (saved) {
      state.compCandidates = [];
      $('#comp-search-results').classList.add('hidden');
      msg.textContent = `Saved ${saved} comparable${saved === 1 ? '' : 's'}.`;
      await loadComps();
      recalc();
    }
  });

  // --- AI rental-evidence search ----------------------------------------

  function renderRentalSearch() {
    const box = $('#rental-search-results');
    const t = $('#rental-search-table');
    box.classList.remove('hidden');
    if (!state.rentalCandidates.length) {
      t.innerHTML = '<tr><td>No comparable rentals found — try a more specific address or add one manually below.</td></tr>';
      return;
    }
    t.innerHTML = `
      <thead><tr><th></th><th>Address</th><th>Rent/wk</th><th>Listed</th><th>Beds</th><th>Type</th><th>~km</th><th>Confidence</th><th>Source</th></tr></thead><tbody>
      ${state.rentalCandidates.map((r, i) => {
        const label = escapeHtml(r.address || 'listing');
        let host = r.source || '';
        try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch (e) { /* keep source */ }
        return `<tr>
          <td><input type="checkbox" data-rental-cand="${i}" checked></td>
          <td>${r.url ? `<a class="comp-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${label}</a>` : label}</td>
          <td>${r.rentWeekly ? fmtMoney(r.rentWeekly) : '—'}</td>
          <td>${escapeHtml(r.listedDate || '—')}</td>
          <td>${r.bedrooms != null ? r.bedrooms : '—'}</td>
          <td>${escapeHtml(r.propertyType || '—')}</td>
          <td>${r.distanceKm != null ? r.distanceKm + ' km' : '—'}</td>
          <td><span class="conf-${escapeHtml(r.confidence || 'low')}">${escapeHtml(r.confidence || 'low')}</span></td>
          <td>${escapeHtml(host)}</td>
        </tr>`;
      }).join('')}
      </tbody>`;
  }

  $('#btn-find-rentals').addEventListener('click', async () => {
    const btn = $('#btn-find-rentals');
    const hint = $('#rental-search-hint');
    if (!state.scenarioId) { hint.textContent = 'Save the scenario first.'; return; }
    const prop = state.inputs.properties[activePropertyIndex()] || {};
    const address = String(prop.address || '').trim();
    if (!address) { hint.textContent = 'Enter the subject address in Inputs first.'; return; }
    hint.textContent = '';
    btn.disabled = true;
    const stopTick = busyTicker(btn, 'Searching');
    try {
      const final = await apiStream('/api/rentals/search/stream', {
        method: 'POST',
        body: JSON.stringify({ address, beds: prop.bedrooms || null }),
      }, (ev) => {
        if (ev.query) hint.textContent =
          `Searching: “${ev.query}”${ev.shard ? ' · ' + ev.shard : ''}`;
        else if (ev.note) hint.textContent = ev.note;
      });
      state.rentalCandidates = final.rentals || [];
      $('#rental-search-msg').textContent = '';
      hint.textContent = '';
      renderRentalSearch();
      stopTick();
      btn.disabled = false;
      btn.textContent = 'Find rental evidence (AI)';
    } catch (err) {
      stopTick();
      btn.textContent = 'Find rental evidence (AI)';
      if (/not configured/.test(err.message)) {
        hint.textContent = 'AI rental search is off — set PA_ULTIMATEAI_API_KEY in .env (needs UltimateAI gateway credits) to enable.';
        // stays disabled until the key is added and the app restarts
      } else {
        btn.disabled = false;
        hint.textContent = 'Search failed: ' + err.message;
      }
    }
  });

  $('#btn-save-rentals').addEventListener('click', async () => {
    if (!state.scenarioId) return;
    const msg = $('#rental-search-msg');
    const picked = $$('input[data-rental-cand]').filter((cb) => cb.checked)
      .map((cb) => state.rentalCandidates[Number(cb.dataset.rentalCand)])
      .filter(Boolean);
    if (!picked.length) { msg.textContent = 'Tick at least one row.'; return; }
    let saved = 0;
    for (const r of picked) {
      try {
        await api(`/api/scenarios/${state.scenarioId}/rentals`, {
          method: 'POST',
          body: JSON.stringify({
            address: r.address, rentWeekly: r.rentWeekly,
            bedrooms: r.bedrooms, propertyType: r.propertyType || 'house',
            url: r.url, notes: 'AI search (' + (r.confidence || 'low') + ' confidence'
              + (r.listedDate ? ' · listed ' + r.listedDate : '')
              + (r.distanceKm != null ? ' · ~' + r.distanceKm + ' km' : '') + ')',
          }),
        });
        saved++;
        msg.textContent = `Saving… ${saved}/${picked.length}`;
      } catch (err) {
        msg.textContent = `Saved ${saved} of ${picked.length} — ${err.message}`;
        break;
      }
    }
    if (saved) {
      state.rentalCandidates = [];
      $('#rental-search-results').classList.add('hidden');
      msg.textContent = `Saved ${saved} rental${saved === 1 ? '' : 's'}.`;
      await loadComps();
      recalc();
    }
  });

  // --- AI web-evidence actions ------------------------------------------
  // Markets refresh, bank-rate suggestions, suburb evidence, listing check
  // and area signals. All one gateway call behind a busy button, matching
  // the comps/rentals search pattern above.

  const notConfiguredHint = (what) =>
    `AI ${what} is off — set PA_ULTIMATEAI_API_KEY in .env (needs UltimateAI gateway credits) to enable.`;

  // --- New-address AI research prompt ---------------------------------------
  // When a located address is on a saved scenario and AI is configured,
  // surface the four research actions right in Inputs as deep-links.
  let aiStatus = null;
  async function refreshAiResearchRow() {
    const row = $('#ai-research-row');
    if (!row) return;
    const prop = state.inputs.properties[activePropertyIndex()] || {};
    const meta = prop.addressMeta || {};
    // research works from the address text alone; coordinates only matter
    // for the map/spatial features
    const hasAddress = String(prop.address || '').trim().length > 5;
    if (!state.scenarioId || !(hasAddress || (meta.lat && meta.lon))) {
      row.classList.add('hidden');
      return;
    }
    if (!aiStatus) {
      try { aiStatus = await api('/api/ai/status'); }
      catch (err) { aiStatus = { configured: false }; }
    }
    const modelEl = $('#ai-research-model');
    if (modelEl) modelEl.textContent = aiStatus.configured
      ? '· ' + (aiStatus.model || 'gateway') : '· not configured';
    row.classList.toggle('hidden', !aiStatus.configured);
  }

  const aiGo = (target, btnSel) => {
    document.querySelector(`a[data-target="${target}"]`).click();
    setTimeout(() => {
      const btn = document.querySelector(btnSel);
      if (btn) btn.click();
    }, 500);
  };
  $('#ai-go-comps').addEventListener('click', () => aiGo('area', '#btn-find-comps'));
  $('#ai-go-rentals').addEventListener('click', () => aiGo('area', '#btn-find-rentals'));
  $('#ai-go-listing').addEventListener('click', () => aiGo('property', '#btn-listing-check'));
  $('#ai-go-signals').addEventListener('click', () => aiGo('dealcheck', '#btn-dc-signals'));

  // Live elapsed-seconds on the busy button — AI web research runs 30-80s
  // (the gateway executes each web search server-side), and a static
  // "searching…" label reads as stuck.
  function busyTicker(btn, label) {
    const t0 = Date.now();
    const iv = setInterval(() => {
      btn.textContent = `${label}… ${Math.round((Date.now() - t0) / 1000)}s`;
    }, 1000);
    return () => clearInterval(iv);
  }

  const activeSubject = () => {
    if (!state.scenarioId) return { error: 'Save the scenario first.' };
    const prop = state.inputs.properties[activePropertyIndex()] || {};
    const address = String(prop.address || '').trim();
    if (!address) return { error: 'Enter the subject address in Inputs first.' };
    return { address };
  };

  $('#btn-mk-ai').addEventListener('click', async () => {
    const btn = $('#btn-mk-ai');
    const hint = $('#mk-ai-hint');
    hint.textContent = '';
    btn.disabled = true;
    const stopTick = busyTicker(btn, 'Researching ABS');
    try {
      const final = await apiStream('/api/markets/ai-refresh/stream', { method: 'POST', body: '{}' }, (ev) => {
        if (ev.query) hint.textContent =
          `Searching: “${ev.query}”${ev.shard ? ' · ' + ev.shard : ''}`;
        else if (ev.note) hint.textContent = ev.note;
      });
      mkCache = null;
      await loadMarkets();
      stopTick();
      hint.textContent =
        `${Object.keys(final.indicators || {}).length} national indicators refreshed from live sources.`;
    } catch (err) {
      stopTick();
      hint.textContent = /not configured/.test(err.message)
        ? notConfiguredHint('markets refresh') : 'Refresh failed: ' + err.message;
    }
    btn.disabled = false;
    btn.textContent = 'Refresh with AI';
  });

  function renderRatesAi() {
    const box = $('#rates-ai-box');
    const t = $('#rates-ai-table');
    box.classList.remove('hidden');
    if (!state.aiRateCandidates.length) {
      t.innerHTML = '<tr><td>No rates found — try again later or add one manually below.</td></tr>';
      return;
    }
    t.innerHTML = `
      <thead><tr><th></th><th>Bank</th><th>Product</th><th>Investor IO</th><th>Investor P&amp;I</th><th>Source</th></tr></thead><tbody>
      ${state.aiRateCandidates.map((r, i) => {
        let host = r.source || '';
        try { host = new URL(r.source).hostname.replace(/^www\./, ''); } catch (e) { /* keep source */ }
        return `<tr>
          <td><input type="checkbox" data-rate-cand="${i}" checked></td>
          <td>${escapeHtml(r.bankName)}</td>
          <td>${escapeHtml(r.productName)}</td>
          <td>${r.investorIoRate != null ? (r.investorIoRate * 100).toFixed(2) + '%' : '—'}</td>
          <td>${r.investorPiRate != null ? (r.investorPiRate * 100).toFixed(2) + '%' : '—'}</td>
          <td>${r.source ? `<a class="comp-link" href="${escapeHtml(r.source)}" target="_blank" rel="noopener">${escapeHtml(host)}</a>` : ''}</td>
        </tr>`;
      }).join('')}
      </tbody>`;
  }

  $('#btn-rates-ai').addEventListener('click', async () => {
    const btn = $('#btn-rates-ai');
    const hint = $('#rates-ai-hint');
    hint.textContent = '';
    btn.disabled = true;
    const stopTick = busyTicker(btn, 'Researching rates');
    try {
      const final = await apiStream('/api/bank-rates/suggest/stream', {
        method: 'POST',
        body: '{}',
      }, (ev) => {
        if (ev.query) hint.textContent =
          `Searching: “${ev.query}”${ev.shard ? ' · ' + ev.shard : ''}`;
        else if (ev.note) hint.textContent = ev.note;
      });
      state.aiRateCandidates = final.rates || [];
      $('#rates-ai-msg').textContent = '';
      renderRatesAi();
    } catch (err) {
      hint.textContent = /not configured/.test(err.message)
        ? notConfiguredHint('rate suggestions') : 'Suggest failed: ' + err.message;
    }
    stopTick();
    btn.disabled = false;
    btn.textContent = 'Suggest current rates (AI)';
  });

  $('#btn-save-rates-ai').addEventListener('click', async () => {
    const msg = $('#rates-ai-msg');
    const picked = $$('input[data-rate-cand]').filter((cb) => cb.checked)
      .map((cb) => state.aiRateCandidates[Number(cb.dataset.rateCand)])
      .filter(Boolean);
    if (!picked.length) { msg.textContent = 'Tick at least one row.'; return; }
    let saved = 0;
    for (const r of picked) {
      try {
        await api('/api/bank-rates', {
          method: 'POST',
          body: JSON.stringify({
            bankName: r.bankName, productName: r.productName,
            investorIoRate: r.investorIoRate, investorPiRate: r.investorPiRate,
            source: r.source, checkedAt: new Date().toISOString().slice(0, 7),
          }),
        });
        saved++;
        msg.textContent = `Saving… ${saved}/${picked.length}`;
      } catch (err) {
        msg.textContent = `Saved ${saved} of ${picked.length} — ${err.message}`;
        break;
      }
    }
    if (saved) {
      state.aiRateCandidates = [];
      $('#rates-ai-box').classList.add('hidden');
      msg.textContent = `Saved ${saved} rate${saved === 1 ? '' : 's'}.`;
      await loadAreaData();
    }
  });

  $('#btn-suburb-ai').addEventListener('click', async () => {
    const btn = $('#btn-suburb-ai');
    const hint = $('#suburb-ai-hint');
    const sid = Number($('#suburb-ai-select') && $('#suburb-ai-select').value) || 0;
    if (!sid) { hint.textContent = 'Pick a suburb first.'; return; }
    hint.textContent = '';
    btn.disabled = true;
    const stopTick = busyTicker(btn, 'Researching suburb');
    try {
      const final = await apiStream('/api/suburbs/ai-evidence/stream', {
        method: 'POST',
        body: JSON.stringify({ suburbId: sid }),
      }, (ev) => {
        if (ev.query) hint.textContent =
          `Searching: “${ev.query}”${ev.shard ? ' · ' + ev.shard : ''}`;
        else if (ev.note) hint.textContent = ev.note;
      });
      await loadAreaData();
      stopTick();
      const n = Object.keys(final.evidence || {}).length;
      hint.textContent =
        `${n} figure${n === 1 ? '' : 's'} updated and saved to the suburb record.`;
    } catch (err) {
      stopTick();
      hint.textContent = /not configured/.test(err.message)
        ? notConfiguredHint('suburb evidence') : 'Suburb research failed: ' + err.message;
    }
    stopTick();
    btn.disabled = false;
    btn.textContent = 'AI research this suburb';
  });

  $('#btn-dc-suburb-ai').addEventListener('click', async () => {
    const btn = $('#btn-dc-suburb-ai');
    const hint = $('#dc-ai-hint');
    const sid = Number(state.inputs.suburbId) || 0;
    if (!sid) { hint.textContent = 'Select a suburb in Inputs first.'; return; }
    hint.textContent = '';
    btn.disabled = true;
    const stopTick = busyTicker(btn, 'Researching suburb');
    try {
      const final = await apiStream('/api/suburbs/ai-evidence/stream', {
        method: 'POST',
        body: JSON.stringify({ suburbId: sid }),
      }, (ev) => {
        if (ev.query) hint.textContent =
          `Searching: “${ev.query}”${ev.shard ? ' · ' + ev.shard : ''}`;
        else if (ev.note) hint.textContent = ev.note;
      });
      await loadAreaData();
      await initDealCheckPage(true);
      stopTick();
      const n = Object.keys(final.evidence || {}).length;
      hint.textContent =
        `${n} suburb figure${n === 1 ? '' : 's'} updated and saved to the suburb record.`;
    } catch (err) {
      stopTick();
      hint.textContent = /not configured/.test(err.message)
        ? notConfiguredHint('suburb evidence') : 'Suburb research failed: ' + err.message;
    }
    btn.disabled = false;
    btn.textContent = 'AI suburb evidence';
  });

  function renderSignals(signals, asAt) {
    const box = $('#dc-signals-box');
    box.classList.remove('hidden');
    if (!signals.length) {
      box.innerHTML = '<div class="hint">No substantiated major projects found within ~5 km.</div>';
      return;
    }
    box.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>Project</th><th>Type</th><th>Status</th><th>Timeframe</th><th>~km</th></tr></thead><tbody>
        ${signals.map((s) => `<tr>
          <td>${s.url ? `<a class="comp-link" href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.name)}</a>` : escapeHtml(s.name)}</td>
          <td>${escapeHtml(s.type)}</td>
          <td>${escapeHtml((s.status || '').replace('_', ' '))}</td>
          <td>${escapeHtml(s.timeframe || '—')}</td>
          <td>${s.distanceKm != null ? s.distanceKm : '—'}</td>
        </tr>`).join('')}
        </tbody></table></div>
      <div class="source-note">AI web search${asAt ? ' · ' + escapeHtml(asAt) : ''} — open each link to verify before relying on it.</div>`;
  }

  $('#btn-dc-signals').addEventListener('click', async () => {
    const btn = $('#btn-dc-signals');
    const hint = $('#dc-ai-hint');
    const subj = activeSubject();
    if (subj.error) { hint.textContent = subj.error; return; }
    hint.textContent = '';
    btn.disabled = true;
    const stopTick = busyTicker(btn, 'Researching projects');
    try {
      const final = await apiStream('/api/property/area-signals/stream', {
        method: 'POST',
        body: JSON.stringify({ address: subj.address }),
      }, (ev) => {
        if (ev.query) hint.textContent =
          `Searching: “${ev.query}”${ev.shard ? ' · ' + ev.shard : ''}`;
        else if (ev.note) hint.textContent = ev.note;
      });
      stopTick();
      state.areaSignals = final.signals || [];
      renderSignals(state.areaSignals, final.asAt);
    } catch (err) {
      stopTick();
      hint.textContent = /not configured/.test(err.message)
        ? notConfiguredHint('area signals') : 'Signals search failed: ' + err.message;
    }
    btn.disabled = false;
    btn.textContent = 'Area signals (AI)';
  });

  function renderListingCheck(l, asAt) {
    const box = $('#listing-check-box');
    box.classList.remove('hidden');
    const cards = [
      `<div class="card stat-card"><div class="label">On market now</div>
        <div class="value">${l.onMarket ? 'Yes' : 'No'}</div>
        <div class="sub">${escapeHtml(l.listedDate || '')}</div></div>`,
    ];
    if (l.askingPrice) {
      cards.push(`<div class="card stat-card"><div class="label">Asking</div>
        <div class="value">${fmtMoney(l.askingPrice)}</div>
        <div class="sub">${escapeHtml(l.agent || '')}</div></div>`);
    }
    if (l.lastSoldPrice) {
      cards.push(`<div class="card stat-card"><div class="label">Last sold</div>
        <div class="value">${fmtMoney(l.lastSoldPrice)}</div>
        <div class="sub">${escapeHtml(l.lastSoldDate || '')}</div></div>`);
    }
    const link = l.url
      ? ` — <a class="comp-link" href="${escapeHtml(l.url)}" target="_blank" rel="noopener">listing page</a>` : '';
    box.innerHTML = `<div class="cards">${cards.join('')}</div>
      <div class="source-note">AI web search · confidence ${escapeHtml(l.confidence || 'low')}${asAt ? ' · ' + escapeHtml(asAt) : ''}${link} — verify on the linked page.</div>`;
  }

  $('#btn-listing-check').addEventListener('click', async () => {
    const btn = $('#btn-listing-check');
    const hint = $('#listing-check-hint');
    const subj = activeSubject();
    if (subj.error) { hint.textContent = subj.error; return; }
    hint.textContent = '';
    btn.disabled = true;
    const stopTick = busyTicker(btn, 'Checking listings');
    try {
      const final = await apiStream('/api/property/listing-check/stream', {
        method: 'POST',
        body: JSON.stringify({ address: subj.address }),
      }, (ev) => {
        if (ev.query) hint.textContent =
          `Searching: “${ev.query}”${ev.shard ? ' · ' + ev.shard : ''}`;
        else if (ev.note) hint.textContent = ev.note;
      });
      stopTick();
      state.listingCheck = final.listing || {};
      renderListingCheck(state.listingCheck, final.asAt);
    } catch (err) {
      stopTick();
      hint.textContent = /not configured/.test(err.message)
        ? notConfiguredHint('listing check') : 'Listing check failed: ' + err.message;
    }
    btn.disabled = false;
    btn.textContent = 'Listing check (AI)';
  });

  $('#btn-add-rate').addEventListener('click', async () => {
    const body = {
      bankName: $('#rate-bank').value.trim(),
      investorIoRate: $('#rate-io').value ? Number($('#rate-io').value) / 100 : null,
      investorPiRate: $('#rate-pi').value ? Number($('#rate-pi').value) / 100 : null,
      source: $('#rate-source').value.trim(),
      checkedAt: new Date().toISOString().slice(0, 7),
    };
    if (!body.bankName) { toast('Enter a bank name'); return; }
    try {
      await api('/api/bank-rates', { method: 'POST', body: JSON.stringify(body) });
      $('#rate-bank').value = ''; $('#rate-io').value = ''; $('#rate-pi').value = ''; $('#rate-source').value = '';
      await loadAreaData();
      toast('Rate added');
    } catch (err) { toast('Could not add rate: ' + err.message); }
  });

  $('#rates-table').addEventListener('click', async (ev) => {
    const save = ev.target.closest('button[data-save-rate]');
    const del = ev.target.closest('button[data-del-rate]');
    try {
      if (save) {
        const id = save.dataset.saveRate;
        const io = $(`[data-rate-io="${id}"]`).value;
        const pi = $(`[data-rate-pi="${id}"]`).value;
        const src = $(`[data-rate-src="${id}"]`).value;
        await api('/api/bank-rates/' + id, {
          method: 'PUT',
          body: JSON.stringify({
            investorIoRate: io === '' ? null : Number(io) / 100,
            investorPiRate: pi === '' ? null : Number(pi) / 100,
            source: src,
          }),
        });
        await loadAreaData();
        toast('Rate saved');
      } else if (del) {
        if (!confirm('Delete this rate row?')) return;
        await api('/api/bank-rates/' + del.dataset.delRate, { method: 'DELETE' });
        await loadAreaData();
      }
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#btn-add-suburb').addEventListener('click', async () => {
    const body = {
      name: $('#sub-name').value.trim(),
      postcode: $('#sub-postcode').value.trim(),
      medianPrice: $('#sub-price').value ? Number($('#sub-price').value) : null,
      medianRent3Bed: $('#sub-rent3').value ? Number($('#sub-rent3').value) : null,
      vacancyPct: $('#sub-vacancy').value ? Number($('#sub-vacancy').value) : null,
      growth5yrPct: $('#sub-growth').value ? Number($('#sub-growth').value) : null,
      sources: { medianPrice: { source: 'entered manually', asOf: new Date().toISOString().slice(0, 7) } },
    };
    if (!body.name || !body.postcode) { toast('Suburb name and postcode are required'); return; }
    try {
      await api('/api/suburbs', { method: 'POST', body: JSON.stringify(body) });
      $('#sub-name').value = ''; $('#sub-postcode').value = '';
      await loadAreaData();
      toast('Suburb added');
    } catch (err) { toast('Could not add suburb: ' + err.message); }
  });

  $('#suburb-table').addEventListener('click', async (ev) => {
    const save = ev.target.closest('button[data-save-sub]');
    const del = ev.target.closest('button[data-del-sub]');
    try {
      if (save) {
        const id = save.dataset.saveSub;
        const val = (sel) => {
          const v = $(`[${sel}="${id}"]`).value;
          return v === '' ? null : Number(v);
        };
        await api('/api/suburbs/' + id, {
          method: 'PUT',
          body: JSON.stringify({
            medianPrice: val('data-sub-price'),
            medianRent3Bed: val('data-sub-rent3'),
            vacancyPct: val('data-sub-vacancy'),
            growth5yrPct: val('data-sub-growth'),
          }),
        });
        await loadAreaData();
        toast('Suburb saved');
      } else if (del) {
        if (!confirm('Delete this suburb?')) return;
        await api('/api/suburbs/' + del.dataset.delSub, { method: 'DELETE' });
        await loadAreaData();
      }
    } catch (err) { toast('Error: ' + err.message); }
  });

  // ------------------------------------------------------------------
  // Scenario CRUD
  // ------------------------------------------------------------------

  async function api(url, opts = {}) {
    const headers = Object.assign(
      { 'Content-Type': 'application/json' }, opts.headers);
    if (opts.body && typeof opts.body === 'object') {
      opts.body = JSON.stringify(opts.body);
    }
    if (getToken()) headers.Authorization = 'Bearer ' + getToken();
    const resp = await fetch(url, Object.assign({}, opts, { headers }));
    if (resp.status === 401) {
      // Token expired/invalid — drop it and put the login screen back up.
      setToken(null);
      setCurrentUser(null);
      showLogin('Your session expired — please sign in again');
      throw new Error('authentication required');
    }
    const body = await resp.json().catch(() => ({ ok: false, error: 'bad JSON' }));
    if (!body.ok) {
      const e = new Error(body.error || 'request failed');
      if (body.fields) e.fields = body.fields;
      throw e;
    }
    return body.data;
  }

  // SSE variant of api() for the AI research stream routes: calls onEvent
  // with each progress frame and resolves with the final {"type": "done",
  // ...} frame. Non-200 responses are JSON error envelopes, surfaced
  // exactly like api().
  async function apiStream(url, opts = {}, onEvent = null) {
    const headers = Object.assign(
      { 'Content-Type': 'application/json' }, opts.headers);
    if (opts.body && typeof opts.body === 'object') {
      opts.body = JSON.stringify(opts.body);
    }
    if (getToken()) headers.Authorization = 'Bearer ' + getToken();
    const resp = await fetch(url, Object.assign({}, opts, { headers }));
    if (resp.status === 401) {
      setToken(null);
      setCurrentUser(null);
      showLogin('Your session expired — please sign in again');
      throw new Error('authentication required');
    }
    if (!resp.ok || !(resp.body && resp.body.getReader)) {
      const body = await resp.json().catch(() => ({ error: 'request failed' }));
      throw new Error(body.error || 'request failed');
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let final = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch (e) { continue; }
        if (ev.type === 'done' || ev.type === 'error') final = ev;
        else if (onEvent) onEvent(ev);
      }
    }
    if (final && final.type === 'error') throw new Error(final.error);
    if (!final) throw new Error('research stream ended without results');
    return final;
  }

  function saveErrorText(err) {
    const detail = err.fields
      ? Object.entries(err.fields).map(([f, m]) => `${f}: ${m}`).join('; ')
      : '';
    return detail ? `${err.message} — ${detail}` : err.message;
  }

  async function refreshScenarioList() {
    const list = await api('/api/scenarios');
    state.scenarioList = list;
    const sel = $('#scenario-select');
    sel.innerHTML = '<option value="">— unsaved draft —</option>' +
      list.map((s) => `<option value="${s.id}" ${s.id === state.scenarioId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
    renderScenarioTable(list);
    return list;
  }

  function renderScenarioTable(list) {
    const checked = (id) => (state.compareIds.includes(id) ? 'checked' : '');
    $('#scn-table').innerHTML = `
      <thead><tr><th>Cmp</th><th>Name</th><th>Updated</th><th></th></tr></thead><tbody>
      ${list.map((s) => `
        <tr>
          <td><input type="checkbox" data-compare="${s.id}" ${checked(s.id)}></td>
          <td>${escapeHtml(s.name)}</td>
          <td>${(s.updatedAt || '').slice(0, 16).replace('T', ' ')}</td>
          <td class="scenario-row">
            <button data-load="${s.id}">Load</button>
            <button data-dup="${s.id}">Duplicate</button>
            <button data-del="${s.id}" class="danger">Delete</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="4">No saved scenarios yet.</td></tr>'}
      </tbody>`;
  }

  async function loadScenario(sid) {
    const s = await api('/api/scenarios/' + sid);
    state.inputs = E.normalizeInputs(s.inputs);
    state.scenarioId = s.id;
    $('#scenario-name').value = s.name;
    // setActiveTab rebuilds the property tab strip (syncForm alone doesn't),
    // so a loaded scenario with a different property count shows all its tabs.
    setActiveTab(Number.isInteger(state.inputTab)
      && state.inputTab < state.inputs.properties.length ? state.inputTab : 0);
    recalc();
    saveDraft();
    await loadComps();
    await refreshScenarioList();
    await refreshPropertyLocations();
    toast(`Loaded "${s.name}"`);
    return s;
  }

  $('#scn-table').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    try {
      if (btn.dataset.load) {
        await loadScenario(btn.dataset.load);
      } else if (btn.dataset.dup) {
        await api(`/api/scenarios/${btn.dataset.dup}/duplicate`, { method: 'POST', body: '{}' });
        await refreshScenarioList();
        toast('Scenario duplicated');
      } else if (btn.dataset.del) {
        if (!confirm('Delete this scenario?')) return;
        await api('/api/scenarios/' + btn.dataset.del, { method: 'DELETE' });
        if (state.scenarioId === Number(btn.dataset.del)) state.scenarioId = null;
        await refreshScenarioList();
        toast('Scenario deleted');
      }
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#scn-table').addEventListener('change', (ev) => {
    const cb = ev.target.closest('input[data-compare]');
    if (!cb) return;
    const id = Number(cb.dataset.compare);
    if (cb.checked) {
      if (state.compareIds.length >= 3) { cb.checked = false; toast('Compare up to 3 scenarios'); return; }
      state.compareIds.push(id);
    } else {
      state.compareIds = state.compareIds.filter((x) => x !== id);
    }
    refreshCompare();
  });

  // ------------------------------------------------------------------
  // BA Workspace (visible only to role=ba)
  // ------------------------------------------------------------------

  let wsCache = { clients: [], presentations: [], portfolios: [] };

  async function fetchWorkspaceData(silent) {
    // Each section fetches independently — a missing/failing endpoint must
    // not blank the whole workspace (it renders whatever succeeded).
    const results = await Promise.allSettled([
      api('/api/clients'), api('/api/presentations'), api('/api/portfolios')]);
    const next = {};
    ['clients', 'presentations', 'portfolios'].forEach((name, i) => {
      const r = results[i];
      if (r.status === 'fulfilled') next[name] = r.value;
      else if (!silent && r.reason.status !== 404) toast('Workspace ' + name + ': ' + r.reason.message);
    });
    Object.assign(wsCache, next);
    return JSON.stringify(next);
  }

  async function refreshWorkspace() {
    if (!state.currentUser || state.currentUser.role !== 'ba') return;
    await fetchWorkspaceData(false);
    renderWorkspace();
    api('/api/presentations/alerts').then((d) => {
      const cb = $('#ws-alerts');
      if (cb) cb.checked = !!d.enabled;
    }).catch(() => {});
    refreshBranding();
  }

  $('#ws-alerts').addEventListener('change', async (ev) => {
    try {
      const d = await api('/api/presentations/alerts', {
        method: 'POST', body: { enabled: ev.target.checked },
      });
      $('#ws-logo-msg').textContent = d.enabled
        ? 'Client activity will be emailed to you'
        : 'Client activity emails off';
    } catch (err) {
      ev.target.checked = !ev.target.checked;
      toast('Error: ' + err.message);
    }
  });

  function renderWorkspace() {
    renderWorkspaceForms();
    renderWorkspaceTables();
  }

  // Selects and the tick-list live here — a re-render resets user choices,
  // so the auto-refresh poll must never touch this part.
  function renderWorkspaceForms() {
    const { clients } = wsCache;
    const scenarios = state.scenarioList || [];
    $('#ws-scenario').innerHTML = scenarios.length
      ? scenarios.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')
      : '<option value="">— save a scenario first —</option>';
    const clientOpts = clients.length
      ? clients.map((c) => `<option value="${c.email}">${escapeHtml(c.name)} — ${escapeHtml(c.email)}</option>`).join('')
      : '<option value="">— add a client first —</option>';
    $('#ws-client').innerHTML = clientOpts;
    $('#ws-pf-client').innerHTML = clientOpts;

    $('#ws-pf-items').innerHTML = scenarios.length
      ? scenarios.map((s) => `
        <label class="ws-pf-item">
          <input type="checkbox" data-pf-scenario="${s.id}">
          <span class="ws-pf-item-name">${escapeHtml(s.name)}</span>
          <input type="text" data-pf-label="${s.id}" placeholder="label — defaults to scenario name" maxlength="120">
        </label>`).join('')
      : '<div class="source-note">Save a scenario first — ticked scenarios become the portfolio properties.</div>';
    updatePfCount();
  }

  function renderWorkspaceTables() {
    const { clients, presentations, portfolios } = wsCache;

    $('#ws-clients').innerHTML = `
      <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Proposals</th><th>Status</th></tr></thead><tbody>
      ${clients.map((c) => `
        <tr>
          <td>${escapeHtml(c.name)}</td>
          <td>${escapeHtml(c.email)}</td>
          <td>${escapeHtml(c.phone || '—')}</td>
          <td>${c.presentations}</td>
          <td>${c.status}</td>
        </tr>`).join('') || '<tr><td colspan="5">No clients yet — add one above.</td></tr>'}
      </tbody>`;

    $('#ws-presentations').innerHTML = `
      <thead><tr><th>Title</th><th>Client</th><th>Status</th><th>Last activity</th><th>Comments</th><th></th></tr></thead><tbody>
      ${presentations.map((p) => `
        <tr>
          <td>${escapeHtml(p.title)}</td>
          <td>${escapeHtml(p.clientName)}</td>
          <td>${p.status === 'active' ? 'active' : p.status}</td>
          <td>${(p.lastActivity || p.updatedAt || '').slice(0, 16).replace('T', ' ')}</td>
          <td>${p.commentCount}</td>
          <td class="scenario-row">
            <button data-ws-activity="${p.id}">Activity</button>
            <button data-ws-report="${p.id}" data-ws-report-sid="${p.scenarioId || ''}" ${p.scenarioId ? '' : 'disabled'}>Report</button>
            <button data-ws-tax="${p.id}" data-ws-tax-sid="${p.scenarioId || ''}" ${p.scenarioId ? '' : 'disabled'}>Tax pack</button>
            <button data-ws-xls="${p.id}" data-ws-xls-sid="${p.scenarioId || ''}" ${p.scenarioId ? '' : 'disabled'}>Excel</button>
            <button data-ws-rotate="${p.id}" ${p.status !== 'active' ? 'disabled' : ''}>New link</button>
            <button data-ws-revoke="${p.id}" ${p.status !== 'active' ? 'disabled' : ''} class="danger">Revoke</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="6">Nothing shared yet — create a link above.</td></tr>'}
      </tbody>`;

    $('#ws-portfolios').innerHTML = `
      <thead><tr><th>Portfolio</th><th>Client</th><th>Properties</th><th>Decisions</th><th>Comments</th><th>Status</th><th>Last activity</th><th></th></tr></thead><tbody>
      ${portfolios.map((p) => `
        <tr>
          <td>${escapeHtml(p.title || 'Untitled portfolio')}</td>
          <td>${escapeHtml(p.clientName)}</td>
          <td>${p.itemCount}</td>
          <td>${p.approvedCount} approved · ${p.changesCount} changes · ${p.pendingCount} open</td>
          <td>${p.commentCount}</td>
          <td>${p.status}</td>
          <td>${(p.lastActivity || p.updatedAt || '').slice(0, 16).replace('T', ' ')}</td>
          <td class="scenario-row">
            <button data-ws-pf-activity="${p.id}">Activity</button>
            <button data-ws-pf-rotate="${p.id}" ${p.status !== 'active' ? 'disabled' : ''}>New link</button>
            <button data-ws-pf-revoke="${p.id}" ${p.status !== 'active' ? 'disabled' : ''} class="danger">Revoke</button>
            <button data-ws-pf-delete="${p.id}" class="danger">Delete</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="8">No portfolios yet — tick a few properties above to share them as one link.</td></tr>'}
      </tbody>`;
  }

  // While a BA sits in the workspace, client activity (comments, approvals,
  // opens) shows up on its own — no reload. Tables only: re-rendering the
  // forms would wipe mid-entry state (ticked properties, chosen client).
  // Silent and change-gated so an offline server doesn't toast every 20s.
  let wsPollSerial = '';
  setInterval(async () => {
    if (!state.currentUser || state.currentUser.role !== 'ba') return;
    if (!document.querySelector('#section-workspace.active')) return;
    if (document.visibilityState !== 'visible') return;
    try {
      const serial = await fetchWorkspaceData(true);
      if (serial === wsPollSerial) return;
      wsPollSerial = serial;
      renderWorkspaceTables();
    } catch (e) { /* poll is best-effort */ }
  }, 20000);

  function updatePfCount() {
    const n = document.querySelectorAll('#ws-pf-items input[data-pf-scenario]:checked').length;
    const el = $('#ws-pf-count');
    if (el) el.textContent = n ? `${n} propert${n === 1 ? 'y' : 'ies'} selected` : '';
  }

  // Comparable rentals + buyer risk checklist (Area Report).
  function renderRentalTable() {
    const t = $('#rental-table');
    if (!t) return;
    const rentals = state.rentals || [];
    if (!rentals.length) {
      t.innerHTML = '<tr><td colspan="6">No rental comps yet — paste a few nearby listings above.</td></tr>';
      $('#rental-summary').textContent = '';
      return;
    }
    const sorted = rentals.map((r) => r.rentWeekly).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const yourRent = state.result.inputs.properties[0].weeklyRent;
    const gap = yourRent - median;
    $('#rental-summary').textContent =
      `${rentals.length} rentals · median $${fmtNum(median)}/wk · your $${fmtNum(yourRent)}/wk ` +
      `is ${gap >= 0 ? 'above' : 'below'} by $${fmtNum(Math.abs(gap))}/wk`;
    t.innerHTML = `
      <thead><tr><th>Address</th><th>Rent/wk</th><th>Beds</th><th>Type</th><th>Notes</th><th></th></tr></thead><tbody>
      ${rentals.map((r) => `<tr>
        <td>${escapeHtml(r.address || '—')}</td>
        <td>${fmtMoney(r.rentWeekly)}</td>
        <td>${r.bedrooms == null ? '—' : r.bedrooms}</td>
        <td>${escapeHtml(r.propertyType || '')}</td>
        <td>${escapeHtml(r.notes || '')}</td>
        <td class="scenario-row"><button data-rental-del="${r.id}" class="danger">Delete</button></td>
      </tr>`).join('')}
      </tbody>`;
  }

  function renderRiskChecklist() {
    const box = $('#risk-list');
    if (!box) return;
    const { checks } = E.riskChecklist(state.inputs, currentSuburb());
    const icon = { ok: '✓', warn: '⚠', unknown: '·' };
    box.innerHTML = checks.map((c) => `
      <div class="risk-row risk-${c.status}">
        <span class="risk-icon">${icon[c.status] || '·'}</span>
        <span class="risk-label">${escapeHtml(c.label)}</span>
        <span class="risk-detail">${escapeHtml(c.detail)}</span>
      </div>`).join('');
  }

  $('#btn-add-rental').addEventListener('click', async () => {
    if (!state.scenarioId) { toast('Save the scenario first'); return; }
    try {
      await api(`/api/scenarios/${state.scenarioId}/rentals`, {
        method: 'POST',
        body: {
          address: $('#rental-address').value.trim(),
          rentWeekly: Number($('#rental-rent').value || 0),
          bedrooms: $('#rental-beds').value === '' ? null : Number($('#rental-beds').value),
          propertyType: $('#rental-type').value,
          notes: $('#rental-notes').value.trim(),
        },
      });
      $('#rental-address').value = ''; $('#rental-rent').value = '';
      $('#rental-beds').value = ''; $('#rental-notes').value = '';
      await loadComps();
      toast('Rental comp added');
    } catch (err) { toast('Error: ' + saveErrorText(err)); }
  });

  $('#rental-table').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-rental-del]');
    if (!btn) return;
    if (!confirm('Delete this rental comp?')) return;
    try {
      await api('/api/rentals/' + btn.dataset.rentalDel, { method: 'DELETE' });
      await loadComps();
      toast('Rental comp deleted');
    } catch (err) { toast('Error: ' + err.message); }
  });

  let lastShare = { pid: null, token: null };

  function showShareLink(pid, token) {
    lastShare = { pid, token };
    const url = location.origin + '/p/' + token;
    $('#ws-new-link').classList.remove('hidden');
    $('#ws-link').value = url;
    const client = wsCache.clients.find((c) => c.email === $('#ws-client').value);
    if (client) $('#ws-email').value = client.email;
    if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
    toast('Share link created and copied');
  }

  $('#ws-email-send').addEventListener('click', async () => {
    if (!lastShare.pid || !lastShare.token) return;
    try {
      const d = await api(`/api/presentations/${lastShare.pid}/email`, {
        method: 'POST',
        body: { shareToken: lastShare.token, email: $('#ws-email').value.trim() },
      });
      $('#ws-email-msg').textContent = d.sent
        ? `Sent to ${d.emailedTo}`
        : 'SMTP not configured on this server — link logged, copy it above instead';
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#ws-add-client').addEventListener('click', async () => {
    try {
      await api('/api/clients', {
        method: 'POST',
        body: {
          email: $('#ws-client-email').value.trim(),
          name: $('#ws-client-name').value.trim(),
          phone: $('#ws-client-phone').value.trim(),
        },
      });
      $('#ws-client-email').value = ''; $('#ws-client-name').value = ''; $('#ws-client-phone').value = '';
      await refreshWorkspace();
      toast('Client added');
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#ws-create').addEventListener('click', async () => {
    const scenarioId = Number($('#ws-scenario').value);
    const clientEmail = $('#ws-client').value;
    if (!scenarioId || !clientEmail) { toast('Save a scenario and add a client first'); return; }
    try {
      const client = wsCache.clients.find((c) => c.email === clientEmail);
      const d = await api('/api/presentations', {
        method: 'POST',
        body: {
          scenarioId,
          clientEmail,
          clientName: client ? client.name : '',
          title: $('#ws-title').value.trim() || undefined,
          expiresInDays: Number($('#ws-expiry').value || 30),
          // transient AI research rides the share so the client's PDF
          // includes it (server whitelists the keys)
          extras: {
            listingCheck: state.listingCheck || null,
            areaSignals: (state.areaSignals || []).length ? state.areaSignals : null,
          },
        },
      });
      showShareLink(d.id, d.shareToken);
      await refreshWorkspace();
    } catch (err) { toast('Error: ' + err.message); }
  });

  // Full report pack — engine outputs posted to the server, which adds
  // comps, rentals, suburb data, overlays and branding and renders a PDF.
  // ------------------------------------------------------------------
  // Client report section picker (modular reports)
  // ------------------------------------------------------------------

  const REPORT_SECTIONS = [
    { group: 'Core numbers', items: [
      ['cashflow', 'Cash flow — first year'],
      ['whoPays', 'Who pays the cost?'],
      ['projections', 'Projections over the hold'],
      ['exit', 'Exit & CGT'],
      ['properties', 'Per-property breakdown'],
    ] },
    { group: 'Intelligence', items: [
      ['propertyIntel', 'Property intelligence (parcel, zoning, hazards)'],
      ['dealCheck', 'Deal Check verdicts'],
      ['checks', 'Due-diligence checklist'],
      ['replacement', 'Replacement value'],
      ['listingCheck', 'Listing check'],
      ['areaSignals', 'Area signals'],
    ] },
    { group: 'Evidence & area', items: [
      ['rentalEvidence', 'Rental evidence'],
      ['salesEvidence', 'Sales evidence'],
      ['suburb', 'Suburb snapshot'],
    ] },
    { group: 'Attachments', items: [
      ['documents', 'Attached documents'],
    ] },
  ];

  function savedReportSections() {
    try {
      const v = JSON.parse(localStorage.getItem('pa_report_sections') || '[]');
      return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : [];
    } catch (e) { return []; }
  }

  let reportDialogSid = null;

  function openReportDialog(sid) {
    if (!sid) { toast('This share has no linked scenario'); return; }
    reportDialogSid = sid;
    const saved = savedReportSections();
    $('#report-dialog-groups').innerHTML = REPORT_SECTIONS.map((g) => `
      <div class="report-dialog-group">
        <div class="report-dialog-group-label">${escapeHtml(g.group)}</div>
        ${g.items.map(([key, label]) => `
          <label class="report-dialog-check"><input type="checkbox" data-report-section="${key}"
            ${!saved.length || saved.includes(key) ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`).join('')}
      </div>`).join('');
    $('#report-dialog').classList.remove('hidden');
  }

  function closeReportDialog() {
    $('#report-dialog').classList.add('hidden');
    reportDialogSid = null;
  }

  function wireReportDialog() {
    const overlay = $('#report-dialog');
    if (!overlay) return;
    $('#report-dialog-x').addEventListener('click', closeReportDialog);
    $('#report-dialog-cancel').addEventListener('click', closeReportDialog);
    overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) closeReportDialog(); });
    $('#report-dialog-select-all').addEventListener('click', () => {
      overlay.querySelectorAll('input[data-report-section]').forEach((cb) => { cb.checked = true; });
    });
    const collectSections = () => [...overlay.querySelectorAll('input[data-report-section]:checked')]
      .map((cb) => cb.dataset.reportSection);
    $('#report-dialog-download').addEventListener('click', async () => {
      const keys = collectSections();
      if (!keys.length) { toast('Pick at least one section'); return; }
      localStorage.setItem('pa_report_sections', JSON.stringify(keys));
      const sid = reportDialogSid;
      closeReportDialog();
      await downloadScenarioReport(sid, false, keys);
    });
    $('#report-dialog-excel').addEventListener('click', async () => {
      const keys = collectSections();
      if (!keys.length) { toast('Pick at least one section'); return; }
      localStorage.setItem('pa_report_sections', JSON.stringify(keys));
      const sid = reportDialogSid;
      closeReportDialog();
      await downloadScenarioExcel(sid, keys);
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !overlay.classList.contains('hidden')) closeReportDialog();
    });
  }

  function buildReportPayload(result, inputs) {
    const horizon = Number(inputs.projectionYears) || 20;
    const rows = result.rows.slice(0, horizon).map((row) => ({
      year: row.year,
      calendarYear: row.calendarYear,
      grossRent: row.grossRent,
      effectiveRent: row.effectiveRent,
      ipInterest: row.ipInterest,
      equityLoanInterest: row.equityLoanInterest,
      ipPrincipalRepayment: row.ipPrincipalRepayment,
      equityLoanPrincipalRepayment: row.equityLoanPrincipalRepayment,
      operatingExpenses: row.operatingExpenses,
      otherDeductibleClaims: row.otherDeductibleClaims,
      capitalWorksDepreciation: row.capitalWorksDepreciation,
      plantEquipmentDepreciation: row.plantEquipmentDepreciation,
      taxablePropertyResult: row.taxablePropertyResult,
      preTaxCashFlow: row.preTaxCashFlow,
      taxRefundOrCost: row.taxRefundOrCost,
      afterTaxCashFlow: row.afterTaxCashFlow,
      cumulativeAfterTaxCashFlow: row.cumulativeAfterTaxCashFlow,
    }));
    const year1 = rows[0] || {};
    const prop = inputs.properties[0] || {};
    const propSections = (result.properties || []).map((p) => {
      const raw = inputs.properties[p.index] || {};
      const row0 = (p.rows && p.rows[0]) || {};
      return {
        label: raw.label || p.label,
        address: raw.address || '',
        metrics: { purchasePrice: p.metrics.purchasePrice,
                   grossYield: p.metrics.grossYield, netYield: p.metrics.netYield,
                   year1AfterTaxCashFlow: p.metrics.year1AfterTaxCashFlow,
                   weeklyOutOfPocket: p.metrics.weeklyOutOfPocket,
                   tenYearEquity: p.metrics.tenYearEquity,
                   irrApproximation: p.metrics.irrApproximation },
        year1: { grossRent: row0.grossRent, vacancyLoss: row0.vacancyLoss,
                 effectiveRent: row0.effectiveRent, managementFees: row0.managementFees,
                 operatingExpenses: row0.operatingExpenses, landTax: row0.landTax,
                 ipInterest: row0.ipInterest, equityLoanInterest: row0.equityLoanInterest,
                 ipPrincipalRepayment: row0.ipPrincipalRepayment,
                 equityLoanPrincipalRepayment: row0.equityLoanPrincipalRepayment,
                 capitalWorksDepreciation: row0.capitalWorksDepreciation,
                 plantEquipmentDepreciation: row0.plantEquipmentDepreciation,
                 otherDeductibleClaims: row0.otherDeductibleClaims,
                 taxablePropertyResult: row0.taxablePropertyResult,
                 taxRefundOrCost: row0.taxRefundOrCost,
                 afterTaxCashFlow: row0.afterTaxCashFlow,
                 preTaxCashFlow: row0.preTaxCashFlow },
        exit: { saleYear: p.exit.saleYear, calendarSaleYear: p.exit.calendarSaleYear,
                salePrice: p.exit.salePrice, capitalGainsTax: p.exit.capitalGainsTax,
                netSaleProceeds: p.exit.netSaleProceeds,
                totalNetPosition: p.exit.totalNetPosition },
      };
    });
    return {
      accent: getComputedStyle(document.documentElement).getPropertyValue('--pri').trim() || '#6366f1',
      metrics: { purchasePrice: result.metrics.purchasePrice,
                 grossYield: result.metrics.grossYield, netYield: result.metrics.netYield,
                 irrApproximation: result.metrics.irrApproximation,
                 tenYearEquity: result.metrics.tenYearEquity,
                 netSaleProceeds: result.metrics.netSaleProceeds },
      funding: E.fundingStructure(inputs),
      loan: { rate: inputs.ipInterestRate },
      year1,
      taxSplit: E.ownerTaxSplit(inputs, year1.taxablePropertyResult || 0, 1),
      years: rows,
      horizon: rows.length,
      propertySections: propSections,
      exit: result.exit,
      checks: E.riskChecklist(inputs, null).checks,
      replacement: { landValue: inputs.landValue, capitalWorksBase: inputs.capitalWorksBase },
      preTaxSeries: rows.map((row) => row.preTaxCashFlow),
      cashSeries: rows.map((row) => row.afterTaxCashFlow),
      subject: { price: prop.purchasePrice, weeklyRent: prop.weeklyRent,
                 landValue: prop.landValue, bedrooms: prop.bedrooms,
                 address: prop.address },
      // Transient session data — included only when the user ran them.
      listingCheck: state.listingCheck || null,
      areaSignals: (state.areaSignals || []).length ? state.areaSignals : null,
    };
  }

  async function dealCheckForReport(sid, inputs, result) {
    const meta = ((inputs.properties || [])[0] || {}).addressMeta || {};
    const lat = numOrNull(meta.lat), lon = numOrNull(meta.lon);
    let census = null;
    if (lat !== null && lon !== null) {
      try { census = await fetchDealCheck(lat, lon, meta.postcode); }
      catch (e) { census = null; }
    }
    const suburbRow = (state.suburbs || []).find((s) => s.id === Number(inputs.suburbId)) || null;
    const suburb = await dcPriceBenchmark(meta, suburbRow);
    let comps = [], rentals = [];
    try { comps = await api(`/api/scenarios/${sid}/comps`); } catch (e) { /* best-effort */ }
    try { rentals = await api(`/api/scenarios/${sid}/rentals`); } catch (e) { /* best-effort */ }
    return buildDealCheckBundle(census, inputs, result, suburb, 0,
      await dcEvidence(suburb, comps, rentals));
  }

    async function downloadScenarioReport(sid, taxPack = false, sections = null) {
    if (!sid) { toast('This share has no linked scenario'); return; }
    try {
      const d = await api('/api/scenarios/' + sid);
      const suburb = (state.suburbs || []).find((s) => s.id === d.suburbId) || null;
      const result = E.calculateAll(d.inputs, { suburb });
      // result.inputs is the normalized copy — fundingStructure and the tax
      // split need defaults applied (raw saved inputs miss ipLvr etc.).
      const inputs = result.inputs;
      const payload = buildReportPayload(result, inputs);
      if (taxPack) payload.taxPack = true;
      else payload.dealCheck = await dealCheckForReport(sid, inputs, result);
      if (Array.isArray(sections) && sections.length) payload.sections = sections;
      const resp = await fetch(`/api/scenarios/${sid}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify(payload),
      });
      const ct = resp.headers.get('Content-Type') || '';
      if (ct.includes('pdf')) {
        const blob = await resp.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = ((d.name || 'report').replace(/[^\w -]/g, '') || 'report') + '.pdf';
        a.click();
        URL.revokeObjectURL(a.href);
        toast('Report downloaded');
      } else {
        // WeasyPrint missing server-side — open the print HTML instead.
        const html = await resp.text();
        const w = window.open('', '_blank');
        w.document.write(html);
        w.document.close();
      }
    } catch (err) { toast('Error: ' + err.message); }
  }

  async function downloadScenarioExcel(sid, sections = null) {
    if (!sid) { toast('This share has no linked scenario'); return; }
    try {
      const d = await api('/api/scenarios/' + sid);
      const suburb = (state.suburbs || []).find((s) => s.id === d.suburbId) || null;
      const result = E.calculateAll(d.inputs, { suburb });
      const payload = buildReportPayload(result, result.inputs);
      if (Array.isArray(sections) && sections.length) payload.sections = sections;
      const resp = await fetch(`/api/scenarios/${sid}/excel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify(payload),
      });
      const ct = resp.headers.get('Content-Type') || '';
      if (!resp.ok || !ct.includes('spreadsheet')) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || 'Excel export failed');
      }
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = ((d.name || 'report').replace(/[^\w -]/g, '') || 'report') + '.xlsx';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Excel downloaded');
    } catch (err) { toast('Error: ' + err.message); }
  }

  $('#ws-presentations').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    try {
      if (btn.dataset.wsActivity) {
        const d = await api('/api/presentations/' + btn.dataset.wsActivity);
        $('#ws-activity-box').classList.remove('hidden');
        $('#ws-activity-title').textContent = 'Activity — ' + d.title;
        const who = (e) => e.email === state.currentUser.email ? 'you' : (e.display_name || e.email || '').split('@')[0];
        $('#ws-events').innerHTML = d.events.map((e) => `
          <span class="k">${(e.created_at || '').slice(0, 16).replace('T', ' ')} · ${who(e)} · ${e.type}</span>
          <span class="v">${escapeHtml(e.body || '')}</span>`).join('')
          || '<span class="k">no activity yet</span><span class="v"></span>';
      } else if (btn.dataset.wsReport) {
        openReportDialog(btn.dataset.wsReportSid);
      } else if (btn.dataset.wsTax) {
        await downloadScenarioReport(btn.dataset.wsTaxSid, true);
      } else if (btn.dataset.wsXls) {
        await downloadScenarioExcel(btn.dataset.wsXlsSid);
      } else if (btn.dataset.wsRotate) {
        if (!confirm('Generate a new link? The old one stops working.')) return;
        const d = await api(`/api/presentations/${btn.dataset.wsRotate}/rotate`, { method: 'POST', body: '{}' });
        showShareLink(d.id, d.shareToken);
        await refreshWorkspace();
      } else if (btn.dataset.wsRevoke) {
        if (!confirm('Revoke this share link? The client loses access immediately.')) return;
        await api(`/api/presentations/${btn.dataset.wsRevoke}/revoke`, { method: 'POST', body: '{}' });
        await refreshWorkspace();
        toast('Link revoked');
      }
    } catch (err) { toast('Error: ' + err.message); }
  });

  // --- Client portfolios ---

  let lastPfShare = { id: null, token: null };

  function showPfShareLink(pfid, token) {
    lastPfShare = { id: pfid, token };
    const url = location.origin + '/p/' + token;
    $('#ws-pf-new-link').classList.remove('hidden');
    $('#ws-pf-link').value = url;
    const client = wsCache.clients.find((c) => c.email === $('#ws-pf-client').value);
    if (client) $('#ws-pf-email').value = client.email;
    if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
    toast('Portfolio link created and copied');
  }

  $('#ws-pf-email-send').addEventListener('click', async () => {
    if (!lastPfShare.id || !lastPfShare.token) return;
    try {
      const d = await api(`/api/portfolios/${lastPfShare.id}/email`, {
        method: 'POST',
        body: { shareToken: lastPfShare.token, email: $('#ws-pf-email').value.trim() },
      });
      $('#ws-pf-email-msg').textContent = d.sent
        ? `Sent to ${d.emailedTo}`
        : 'SMTP not configured on this server — link logged, copy it above instead';
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#ws-pf-items').addEventListener('change', updatePfCount);

  $('#ws-pf-create').addEventListener('click', async () => {
    const clientEmail = $('#ws-pf-client').value;
    const ticked = [...document.querySelectorAll('#ws-pf-items input[data-pf-scenario]:checked')];
    if (!clientEmail) { toast('Add a client first'); return; }
    if (!ticked.length) { toast('Tick at least one property to share'); return; }
    const items = ticked.map((cb) => {
      const label = document.querySelector(`#ws-pf-items input[data-pf-label="${cb.dataset.pfScenario}"]`).value.trim();
      return label ? { scenarioId: Number(cb.dataset.pfScenario), label } : { scenarioId: Number(cb.dataset.pfScenario) };
    });
    try {
      const d = await api('/api/portfolios', {
        method: 'POST',
        body: {
          clientEmail,
          clientName: (wsCache.clients.find((c) => c.email === clientEmail) || {}).name || '',
          title: $('#ws-pf-title').value.trim() || undefined,
          expiresInDays: Number($('#ws-pf-expiry').value || 30),
          items,
        },
      });
      showPfShareLink(d.id, d.shareToken);
      await refreshWorkspace();
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#ws-portfolios').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    try {
      if (btn.dataset.wsPfActivity) {
        const d = await api('/api/portfolios/' + btn.dataset.wsPfActivity);
        $('#ws-activity-box').classList.remove('hidden');
        $('#ws-activity-title').textContent = 'Activity — ' + (d.title || 'portfolio');
        const who = (e) => e.email === state.currentUser.email ? 'you' : (e.display_name || e.email || '').split('@')[0];
        $('#ws-events').innerHTML = d.events.map((e) => `
          <span class="k">${(e.created_at || '').slice(0, 16).replace('T', ' ')} · ${who(e)} · ${e.type}${e.item_label ? ' · ' + escapeHtml(e.item_label) : ''}</span>
          <span class="v">${escapeHtml(e.body || '')}</span>`).join('')
          || '<span class="k">no activity yet</span><span class="v"></span>';
      } else if (btn.dataset.wsPfRotate) {
        if (!confirm('Generate a new portfolio link? The old one stops working.')) return;
        const d = await api(`/api/portfolios/${btn.dataset.wsPfRotate}/rotate`, { method: 'POST', body: '{}' });
        showPfShareLink(d.id, d.shareToken);
        await refreshWorkspace();
      } else if (btn.dataset.wsPfRevoke) {
        if (!confirm('Revoke this portfolio? Every property in it stops being shared immediately.')) return;
        await api(`/api/portfolios/${btn.dataset.wsPfRevoke}/revoke`, { method: 'POST', body: '{}' });
        await refreshWorkspace();
        toast('Portfolio revoked');
      } else if (btn.dataset.wsPfDelete) {
        if (!confirm('Delete this portfolio and its shared properties? This cannot be undone.')) return;
        await api(`/api/portfolios/${btn.dataset.wsPfDelete}`, { method: 'DELETE' });
        await refreshWorkspace();
        toast('Portfolio deleted');
      }
    } catch (err) { toast('Error: ' + err.message); }
  });

  // ------------------------------------------------------------------
  // Portfolio actuals — real numbers vs the projection
  // ------------------------------------------------------------------

  let actualsCache = [];

  function renderActuals() {
    if (!state.scenarioId) {
      $('#actuals-hint').textContent = 'Save the scenario first — actuals attach to a named scenario.';
      $('#actuals-table').innerHTML = '';
      $('#act-property').innerHTML = '';
      return;
    }
    $('#actuals-hint').textContent = 'What actually happened each period. Saving the same period + property again updates it.';
    const props = state.result.inputs.properties;
    $('#act-property').innerHTML = props.map((p, i) =>
      `<option value="${i}">${escapeHtml(p.label || 'Investment property ' + (i + 1))}</option>`).join('');
    loadActuals();
  }

  async function loadActuals() {
    if (!state.scenarioId) return;
    try {
      actualsCache = await api(`/api/scenarios/${state.scenarioId}/actuals`);
      renderActualsTable();
    } catch (err) { toast('Actuals: ' + err.message); }
  }

  function renderActualsCompare() {
    const cardsHost = $('#act-compare');
    if (!cardsHost) return;
    if (!actualsCache.length) { cardsHost.innerHTML = ''; return; }
    let actRent = 0, projRent = 0, actExp = 0, projExp = 0;
    const labels = [], actualRent = [], projectedRent = [];
    actualsCache.forEach((r) => {
      const p = state.result.properties[r.propertyIndex];
      const proj = p && p.rows.find((row) => row.calendarYear === Number(r.periodStart.slice(0, 4)));
      const days = Math.max(1, Math.round((new Date(r.periodEnd) - new Date(r.periodStart)) / 86400000) + 1);
      const pRent = proj ? proj.grossRent / 365 * days : null;
      const pExp = proj ? proj.operatingExpenses / 365 * days : null;
      actRent += r.rentReceived || 0;
      projRent += pRent || 0;
      actExp += r.expenses || 0;
      projExp += pExp || 0;
      labels.push(r.periodStart.slice(0, 7));
      actualRent.push(r.rentReceived || 0);
      projectedRent.push(pRent || 0);
    });
    const varPct = projRent ? ((actRent - projRent) / projRent * 100).toFixed(1) + '%' : '—';
    cardsHost.innerHTML = [
      ['Rent collected', fmtMoney(actRent), 'vs ' + fmtMoney(projRent) + ' projected', 'blue'],
      ['Rent variance', varPct, actRent >= projRent ? 'ahead of projection' : 'behind projection', actRent >= projRent ? 'good' : 'warn'],
      ['Expenses paid', fmtMoney(actExp), 'vs ' + fmtMoney(projExp) + ' projected', 'amber'],
    ].map((x) => '<div class="portfolio-kpi ' + x[3] + '"><div class="portfolio-kpi-label">' + escapeHtml(x[0]) + '</div>' +
      '<div class="portfolio-kpi-value">' + escapeHtml(x[1]) + '</div>' +
      '<div class="portfolio-kpi-note">' + escapeHtml(x[2]) + '</div></div>').join('');
    drawChart('act-chart', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Actual rent', data: actualRent, backgroundColor: COLORS.pri, borderRadius: 4 },
          { label: 'Projected rent', data: projectedRent, backgroundColor: 'rgba(100,116,139,.5)', borderRadius: 4 },
        ],
      },
      options: baseOpts((v) => fmtMoney(v)),
    });
  }

  function renderActualsTable() {
    renderActualsCompare();
    if (!actualsCache.length) {
      $('#actuals-table').innerHTML = '<tr><td>No periods recorded yet — save one above.</td></tr>';
      return;
    }
    const fmt = (v) => (v === null || v === undefined) ? '—' : fmtMoney(v);
    const delta = (a, p) => (a === null || p === null || p === undefined) ? '—' : signed(a - p);
    $('#actuals-table').innerHTML = `
      <thead><tr>
        <th>Property</th><th>Period</th><th>Rent actual</th><th>Rent proj.</th><th>Δ rent</th>
        <th>Exp. actual</th><th>Exp. proj.</th><th>Δ exp</th>
        <th>Loan actual</th><th>Loan proj.</th><th>Value actual</th><th>Value proj.</th><th></th>
      </tr></thead><tbody>
      ${actualsCache.map((r) => {
        const p = state.result.properties[r.propertyIndex];
        const proj = p && p.rows.find((row) => row.calendarYear === Number(r.periodStart.slice(0, 4)));
        const label = (state.result.inputs.properties[r.propertyIndex] || {}).label
          || `IP ${r.propertyIndex + 1}`;
        return `<tr>
          <td>${escapeHtml(label)}</td>
          <td>${r.periodStart} → ${r.periodEnd}</td>
          <td>${fmt(r.rentReceived)}</td>
          <td>${proj ? fmt(proj.grossRent) : '—'}</td>
          <td>${proj ? delta(r.rentReceived, proj.grossRent) : '—'}</td>
          <td>${fmt(r.expenses)}</td>
          <td>${proj ? fmt(proj.operatingExpenses) : '—'}</td>
          <td>${proj ? delta(r.expenses, proj.operatingExpenses) : '—'}</td>
          <td>${fmt(r.loanBalance)}</td>
          <td>${proj ? fmt(proj.ipLoanClosingBalance) : '—'}</td>
          <td>${fmt(r.valuation)}</td>
          <td>${proj ? fmt(proj.propertyValue) : '—'}</td>
          <td class="scenario-row"><button data-act-del="${r.id}" class="danger">Delete</button></td>
        </tr>`;
      }).join('')}
      </tbody>`;
  }

  $('#act-save').addEventListener('click', async () => {
    if (!state.scenarioId) { toast('Save the scenario first'); return; }
    const opt = (v) => v === '' ? null : Number(v);
    try {
      await api(`/api/scenarios/${state.scenarioId}/actuals`, {
        method: 'POST',
        body: {
          propertyIndex: Number($('#act-property').value || 0),
          periodStart: $('#act-start').value,
          periodEnd: $('#act-end').value,
          rentReceived: Number($('#act-rent').value || 0),
          expenses: Number($('#act-expenses').value || 0),
          loanBalance: opt($('#act-loan').value),
          valuation: opt($('#act-value').value),
          notes: $('#act-notes').value.trim(),
        },
      });
      await loadActuals();
      toast('Period saved');
    } catch (err) {
      toast('Error: ' + saveErrorText(err));
    }
  });

  $('#actuals-table').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act-del]');
    if (!btn) return;
    if (!confirm('Delete this period?')) return;
    try {
      await api('/api/actuals/' + btn.dataset.actDel, { method: 'DELETE' });
      await loadActuals();
      toast('Period deleted');
    } catch (err) { toast('Error: ' + err.message); }
  });

  // ------------------------------------------------------------------
  // BA branding + plan
  // ------------------------------------------------------------------

  // The BA logo follows the brand everywhere — including the browser tab.
  function setFavicon(url) {
    if (!url) return;
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = url;
  }

  async function refreshBranding() {
    try {
      const [b, me] = await Promise.all([api('/api/branding'), api('/api/auth/me')]);
      $('#ws-brand-name').value = b.businessName || '';
      $('#ws-brand-color').value = b.accentColor || '#6366f1';
      $('#ws-brand-tagline').value = b.tagline || '';
      $('#ws-brand-phone').value = b.phone || '';
      $('#ws-brand-email').value = b.email || '';
      $('#ws-brand-website').value = b.website || '';
      $('#ws-brand-office').value = b.officeAddress || '';
      setFavicon(b.logoUrl);
      $('#ws-plan').textContent = me.plan || 'trial';
      $('#ws-upgrade').classList.toggle('hidden', me.plan === 'pro');
    } catch (err) { /* branding is optional UI — silent */ }
  }

  $('#ws-save-branding').addEventListener('click', async () => {
    try {
      await api('/api/branding', {
        method: 'PUT',
        body: {
          businessName: $('#ws-brand-name').value.trim(),
          accentColor: $('#ws-brand-color').value,
          tagline: $('#ws-brand-tagline').value.trim(),
          phone: $('#ws-brand-phone').value.trim(),
          email: $('#ws-brand-email').value.trim(),
          website: $('#ws-brand-website').value.trim(),
          officeAddress: $('#ws-brand-office').value.trim(),
        },
      });
      toast('Branding saved — clients see it on their portal and reports');
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#ws-upgrade').addEventListener('click', async () => {
    try {
      const d = await api('/api/billing/plan', { method: 'POST', body: { plan: 'pro' } });
      $('#ws-plan').textContent = d.plan;
      $('#ws-upgrade').classList.add('hidden');
      $('#ws-plan-msg').textContent = 'Pro active';
      toast('Upgraded to Pro');
    } catch (err) { toast('Error: ' + err.message); }
  });

  $('#ws-logo-upload').addEventListener('click', async () => {
    const f = $('#ws-brand-logo').files[0];
    if (!f) { toast('Choose a PNG or JPG first'); return; }
    const fd = new FormData();
    fd.append('file', f);
    try {
      const resp = await fetch('/api/branding/logo', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() },
        body: fd,
      });
      const body = await resp.json();
      if (!body.ok) throw new Error(body.error || 'upload failed');
      setFavicon((body.data || {}).logoUrl);
      $('#ws-logo-msg').textContent = 'Logo uploaded — clients see it on their portal';
      toast('Logo uploaded');
    } catch (err) {
      $('#ws-logo-msg').textContent = err.message;
      toast('Error: ' + err.message);
    }
  });

  async function refreshCompare() {
    state.compareData = [];
    for (const id of state.compareIds) {
      try {
        const s = await api('/api/scenarios/' + id);
        state.compareData.push({ name: s.name, result: E.calculateAll(s.inputs) });
      } catch (err) { console.error(err); }
    }
    renderCompare();
  }

  function renderCompare() {
    const data = state.compareData;
    if (!data.length) {
      $('#compare-table').innerHTML = '<tr><td>Tick scenarios above to compare side by side.</td></tr>';
      ['chart-cmp-equity', 'chart-cmp-oop', 'chart-cmp-value'].forEach((id) => {
        const canvas = document.getElementById(id);
        const box = canvas && canvas.closest('.chart-box');
        if (box) box.classList.add('is-empty');
        drawChart(id, { type: 'bar', data: { labels: [], datasets: [] } });
      });
      return;
    }
    ['chart-cmp-equity', 'chart-cmp-oop', 'chart-cmp-value'].forEach((id) => {
      const canvas = document.getElementById(id);
      const box = canvas && canvas.closest('.chart-box');
      if (box) box.classList.remove('is-empty');
    });
    const rows = [
      ['Purchase price', (r) => fmtMoney(r.metrics.purchasePrice)],
      ['Transfer duty', (r) => fmtMoney(r.metrics.transferDuty)],
      ['Cash required upfront', (r) => fmtMoney(r.metrics.initialCashInvested)],
      ['IP loan / LVR', (r) => `${fmtMoney(r.metrics.ipLoanAmount)} @ ${fmtPct(r.metrics.ipLvrActual, 0)}`],
      ['Gross yield', (r) => fmtPct(r.metrics.grossYield)],
      ['Net yield', (r) => fmtPct(r.metrics.netYield)],
      ['Weekly out-of-pocket (yr 1)', (r) => fmtMoney(Math.max(0, r.metrics.weeklyOutOfPocket))],
      ['Tax refund yr 1', (r) => fmtMoney(r.metrics.year1TaxRefund)],
      ['10-year equity', (r) => fmtMoney(r.metrics.tenYearEquity)],
      [`Sale-year net proceeds`, (r) => fmtMoney(r.metrics.netSaleProceeds)],
      ['Total net position', (r) => fmtMoney(r.metrics.totalNetPosition)],
      ['IRR (approx.)', (r) => (r.metrics.irrApproximation === null ? 'n/a' : fmtPct(r.metrics.irrApproximation, 1))],
    ];
    const head = '<tr><th>Metric</th>' + data.map((d) => `<th>${escapeHtml(d.name)}</th>`).join('') + '</tr>';
    $('#compare-table').innerHTML = `<thead>${head}</thead><tbody>` +
      rows.map(([label, fn]) => `<tr><td>${label}</td>${data.map((d) => `<td>${fn(d.result)}</td>`).join('')}</tr>`).join('') +
      '</tbody>';

    const names = data.map((d) => d.name);
    const palette = [COLORS.pri, COLORS.amber, COLORS.teal];
    drawChart('chart-cmp-equity', {
      type: 'bar',
      data: {
        labels: names,
        datasets: [{ label: '10-year equity', data: data.map((d) => d.result.metrics.tenYearEquity), backgroundColor: palette }],
      },
      options: baseOpts(),
    });
    drawChart('chart-cmp-oop', {
      type: 'bar',
      data: {
        labels: names,
        datasets: [{ label: 'Weekly out-of-pocket', data: data.map((d) => Math.max(0, d.result.metrics.weeklyOutOfPocket)), backgroundColor: palette }],
      },
      options: baseOpts(),
    });
    const maxYears = Math.max(...data.map((d) => d.result.rows.length));
    drawChart('chart-cmp-value', {
      type: 'line',
      data: {
        labels: Array.from({ length: maxYears }, (_, i) => 'Y' + (i + 1)),
        datasets: data.map((d, i) => ({
          label: d.name,
          data: d.result.rows.map((r) => r.propertyValue),
          borderColor: palette[i % 3], tension: 0.15, pointRadius: 0,
        })),
      },
      options: baseOpts(),
    });
  }

  // ------------------------------------------------------------------
  // Topbar actions
  // ------------------------------------------------------------------

  $('#btn-save').addEventListener('click', async () => {
    const name = ($('#scenario-name').value || '').trim() || 'Untitled scenario';
    try {
      if (state.scenarioId) {
        await api('/api/scenarios/' + state.scenarioId, {
          method: 'PUT',
          body: JSON.stringify({ name, inputs: state.inputs }),
        });
        toast('Scenario updated');
      } else {
        const s = await api('/api/scenarios', {
          method: 'POST',
          body: JSON.stringify({ name, inputs: state.inputs }),
        });
        state.scenarioId = s.id;
        toast('Scenario saved');
      }
      saveDraft();
      await refreshScenarioList();
      await loadComps();
      refreshAiResearchRow();
    } catch (err) { toast('Save failed: ' + saveErrorText(err)); }
  });

  $('#btn-save-as').addEventListener('click', async () => {
    const base = ($('#scenario-name').value || 'Untitled').trim();
    const name = prompt('New scenario name:', base + ' (variant)');
    if (!name) return;
    try {
      const s = await api('/api/scenarios', {
        method: 'POST',
        body: JSON.stringify({ name, inputs: state.inputs }),
      });
      state.scenarioId = s.id;
      $('#scenario-name').value = name;
      saveDraft();
      await refreshScenarioList();
      toast('Saved as new scenario');
    } catch (err) { toast('Save failed: ' + saveErrorText(err)); }
  });

  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Reset all inputs to defaults?')) return;
    state.inputs = E.normalizeInputs({});
    state.scenarioId = null;
    state.inputTab = 0;
    state.viewProp = -1;
    $('#scenario-name').value = state.inputs.scenarioName;
    $('#scenario-select').value = '';
    syncForm();
    recalc();
    setActiveTab(0);
    saveDraft();
    toast('Reset to defaults');
  });

  $('#scenario-select').addEventListener('change', async (ev) => {
    const id = ev.target.value;
    if (!id) return;
    try {
      const s = await api('/api/scenarios/' + id);
      state.inputs = E.normalizeInputs(s.inputs);
      state.scenarioId = s.id;
      state.inputTab = 0;
      state.viewProp = -1;
      $('#scenario-name').value = s.name;
      syncForm();
      recalc();
      setActiveTab(0);
      saveDraft();
      await loadComps();
    } catch (err) { toast('Load failed: ' + err.message); }
  });

  $('#cf-year').addEventListener('change', (ev) => {
    state.cfYear = Number(ev.target.value);
    renderCashFlow();
  });

  ['#cf-prop', '#proj-prop', '#exit-prop'].forEach((id) => {
    const sel = $(id);
    if (sel) sel.addEventListener('change', (ev) => onViewSelectChange(ev.target.value));
  });

  // ------------------------------------------------------------------
  // Misc
  // ------------------------------------------------------------------

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ------------------------------------------------------------------
  // UI preferences: theme + text scale (persisted)
  // ------------------------------------------------------------------

  const UI_KEY = 'pa_ui';
  const SCALE_STEPS = [0.85, 1, 1.15, 1.3];

  function loadUiPrefs() {
    try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; }
    catch (e) { return {}; }
  }

  function applyUiPrefs() {
    const p = loadUiPrefs();
    document.documentElement.dataset.theme = p.theme === 'dark' ? 'dark' : 'light';
    const scale = SCALE_STEPS.includes(p.scale) ? p.scale : 1;
    document.documentElement.style.setProperty('--ui-scale', String(scale));
    const label = $('#scale-label');
    if (label) label.textContent = Math.round(scale * 100) + '%';
  }

  function saveUiPref(key, value) {
    const p = loadUiPrefs();
    p[key] = value;
    localStorage.setItem(UI_KEY, JSON.stringify(p));
  }

  $('#btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    saveUiPref('theme', next);
    applyUiPrefs();
    recalc(); // redraw charts so grid/tick colours follow the theme
  });

  function stepScale(dir) {
    const p = loadUiPrefs();
    const cur = SCALE_STEPS.includes(p.scale) ? p.scale : 1;
    const idx = Math.min(SCALE_STEPS.length - 1, Math.max(0, SCALE_STEPS.indexOf(cur) + dir));
    saveUiPref('scale', SCALE_STEPS[idx]);
    applyUiPrefs();
  }
  $('#btn-scale-up').addEventListener('click', () => stepScale(1));
  $('#btn-scale-down').addEventListener('click', () => stepScale(-1));

  applyUiPrefs();

  // ------------------------------------------------------------------
  // Auth session
  // ------------------------------------------------------------------

  function setCurrentUser(u) {
    state.currentUser = u;
    $('#user-chip').classList.toggle('hidden', !u);
    $('#user-avatar').classList.toggle('hidden', !u);
    $('#btn-logout').classList.toggle('hidden', !u);
    if (u) {
      $('#user-chip').textContent = u.displayName;
      $('#user-avatar').textContent = (u.displayName || u.email || '?').trim().charAt(0).toUpperCase();
      const dashUser = $('#dash-user');
      if (dashUser) dashUser.textContent = u.displayName || u.email;
    }
    $('#nav-workspace').classList.toggle('hidden', !(u && u.role === 'ba'));
    // Clients never see the analyzer — their home is the portal.
    if (u && u.role === 'client') {
      location.href = '/portal';
      return;
    }
  }

  function showLogin(msg) {
    $('#login-overlay').classList.remove('hidden');
    const err = $('#auth-error');
    err.classList.toggle('hidden', !msg);
    if (msg) err.textContent = msg;
  }

  function hideLogin() {
    $('#login-overlay').classList.add('hidden');
    $('#auth-error').classList.add('hidden');
    $('#auth-password').value = '';
  }

  // Load the user's draft, reopen the scenario they last worked on, and
  // refresh everything on screen.
  async function initUserSession() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(draftKey()));
      if (!saved && localStorage.getItem(LEGACY_DRAFT_KEY)) {
        saved = JSON.parse(localStorage.getItem(LEGACY_DRAFT_KEY));
        localStorage.removeItem(LEGACY_DRAFT_KEY);
      }
    } catch (e) { /* corrupted draft — start fresh */ }

    // Draft v2/v3 wrap inputs with bookkeeping; older drafts are bare objects.
    let draftInputs = saved, draftAt = 0, draftSid = null;
    if (saved && typeof saved === 'object' && (saved.v === 2 || saved.v === 3)) {
      draftInputs = saved.inputs;
      draftAt = saved.savedAt || 0;
      draftSid = saved.scenarioId || null;
    }

    state.inputs = E.normalizeInputs(draftInputs && typeof draftInputs === 'object' ? draftInputs : {});
    state.scenarioId = null;
    state.compareIds = [];
    state.compareData = [];
    // Same-page account switches keep the previous session's tab — it may
    // point past this draft's properties and crash syncForm.
    state.inputTab = 0;
    $('#scenario-name').value = state.inputs.scenarioName;
    $('#scenario-select').value = '';
    syncForm();
    recalc();
    setActiveTab(Number.isInteger(state.inputTab)
      && state.inputTab < state.inputs.properties.length ? state.inputTab : 0);
    await loadAreaData().catch(() => {});

    if (draftSid) {
      try {
        const s = await api('/api/scenarios/' + draftSid);
        state.scenarioId = s.id;
        $('#scenario-name').value = s.name;
        if (Date.parse(s.updatedAt || '') > draftAt) {
          // Another device saved newer edits — show the server copy.
          state.inputs = E.normalizeInputs(s.inputs);
          syncForm();
          recalc();
        }
      } catch (err) { /* scenario deleted elsewhere — stay in draft */ }
    }
    await loadComps();
    await refreshScenarioList().catch(() => toast('Could not reach scenario API'));
    await refreshPropertyLocations();
    refreshAiResearchRow();
  }

  async function doAuth(endpoint) {
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    try {
      const resp = await fetch('/api/auth/' + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email, password,
          role: document.querySelector('#auth-ba') && $('#auth-ba').checked ? 'ba' : undefined,
          goal: endpoint === 'register' ? ($('#auth-goal') || {}).value || undefined : undefined,
          ownedCount: endpoint === 'register' ? ($('#auth-owned') || {}).value || undefined : undefined,
        }),
      });
      const body = await resp.json().catch(() => ({ ok: false, error: 'bad response' }));
      if (!body.ok) throw new Error(body.error || 'failed');
      setToken(body.data.token);
      setCurrentUser(body.data);
      hideLogin();
      await initUserSession();
      landAfterLogin();
      toast(`Signed in as ${body.data.displayName}`);
    } catch (err) {
      console.error('login failed', err);
      showLogin(err.message);
    }
  }

  function doLogout() {
    setToken(null);
    setCurrentUser(null);
    state.scenarioId = null;
    showLogin('Signed out');
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  function boot() {
    setupAppShell();
    wireCommandPalette();
    wireReportDialog();
    bindInputs();
    bindMaskToggles();
    wireDashboard();
    wireAnnouncement();
    wireTour();

    $('#btn-login').addEventListener('click', () => doAuth('login'));
    $('#btn-register').addEventListener('click', () => doAuth('register'));
    $('#btn-logout').addEventListener('click', doLogout);
    $('#auth-password').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') doAuth('login');
    });

    // Password reset (forgot → emailed link /reset?token=… → set new password)
    const authMsg = (sel, text) => {
      const el = $(sel);
      el.textContent = text;
      el.classList.toggle('hidden', !text);
    };
    $('#link-forgot').addEventListener('click', () => {
      $('#auth-forgot-box').classList.remove('hidden');
      $('#auth-reset-box').classList.add('hidden');
      authMsg('#forgot-msg', '');
    });
    $('#btn-forgot-cancel').addEventListener('click', () => {
      $('#auth-forgot-box').classList.add('hidden');
      authMsg('#forgot-msg', '');
    });
    $('#btn-forgot-send').addEventListener('click', async () => {
      const email = $('#auth-forgot-email').value.trim();
      if (!email) { authMsg('#forgot-msg', 'Enter your account email first.'); return; }
      try {
        const d = await api('/api/auth/forgot', { method: 'POST', body: { email } });
        authMsg('#forgot-msg', d.devResetUrl
          ? 'No email is configured on this machine — open this reset link: ' + d.devResetUrl
          : 'Reset link sent — check your email (valid 30 minutes).');
      } catch (err) { authMsg('#forgot-msg', err.message); }
    });
    $('#btn-reset-confirm').addEventListener('click', async () => {
      const token = new URLSearchParams(location.search).get('token') || '';
      const password = $('#auth-new-password').value;
      try {
        await api('/api/auth/reset', {
          method: 'POST', body: { token, password },
        });
        $('#auth-reset-box').classList.add('hidden');
        history.replaceState(null, '', '/');
        authMsg('#auth-error', '');
        $('#auth-password').value = '';
        toast('Password updated — sign in with your new password');
      } catch (err) { authMsg('#reset-msg', err.message); }
    });
    // Arriving from the emailed link: /reset?token=…
    if (location.pathname === '/reset') {
      const token = new URLSearchParams(location.search).get('token');
      if (token) {
        $('#auth-forgot-box').classList.add('hidden');
        $('#auth-reset-box').classList.remove('hidden');
        if (getToken()) {
          // Signed in already — still show the reset panel and skip the
          // normal boot path (it would hideLogin() right after this).
          showLogin('Choose a new password — you can keep working after signing back in');
          return;
        }
      }
    }

    if (!getToken()) {
      // Client sessions live in the portal, not the analyzer.
      if (localStorage.getItem('pa_portal_token')) {
        location.href = '/portal';
        return;
      }
      showLogin();
      return;
    }
    // Existing token: verify it still names a live user before loading data.
    // Deliberately NOT landAfterLogin() here — on a fresh tab the user should
    // stay on the dashboard; the workspace hand-off is for actual logins.
    api('/api/auth/me')
      .then(async (me) => {
        setCurrentUser(me);
        hideLogin();
        await initUserSession();
        goSection('overview');
      })
      .catch(() => { /* 401 path already surfaced the login screen */ });
  }

  boot();
})();
