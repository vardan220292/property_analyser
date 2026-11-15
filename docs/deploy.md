# Deployment — same VPS as gk_crm

Single-box deployment matching the gk_crm pattern: gunicorn behind the
existing proxy, Supabase Postgres as the database, secrets in `.env`.

## Constraints to respect

- **ONE gunicorn worker** (`-w 1`, threads OK). The rate limiter is
  in-process — a second worker would each keep its own counters. Scale by
  threads, not workers, until the limiter moves to the DB.
- The database is Supabase (session pooler URL in `DATABASE_URL`) — the
  box needs outbound internet; nothing inbound except the app port.
- Schema + seeds apply themselves at every boot (`create_db()` is
  idempotent), so deploys are just: sync code, restart service.

## 1. Server prep

```bash
# python + venv (same interpreter family you run locally)
python3 -m venv ~/deployment/property_analyser/.venv
~/deployment/property_analyser/.venv/bin/pip install -r ~/deployment/personl_projects/property_analyser/requirements.txt
```

(`requirements.txt` includes gunicorn.)

## 2. .env on the server

Copy `.env.example` → `.env` and set, at minimum:

```
PORT=4180
HOST=127.0.0.1                  # proxy in front handles exposure
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
PA_JWT_SECRET=<32+ random chars — openssl rand -hex 32>
PA_BASE_URL=https://pa.yourdomain.com     # what clients will click
# PA_SMTP_HOST / USER / PASS / FROM  — see docs/email-setup.md
# PA_BOOTSTRAP_EMAIL / PA_BOOTSTRAP_PASSWORD — optional seed BA account
```

`data/` must be writable by the service user (JWT secret + SQLite fallback
live there; with `DATABASE_URL` set only the secret is used).

## 3. systemd unit

`/etc/systemd/system/property-analyser.service`:

```ini
[Unit]
Description=Property Analyser (BA platform)
After=network-online.target

[Service]
User=<your vps user>
WorkingDirectory=/home/<user>/deployment/personl_projects/property_analyser
ExecStart=/home/<user>/deployment/property_analyser/.venv/bin/gunicorn \
    -w 1 --threads 8 -b 127.0.0.1:4180 --timeout 60 app:app
Restart=on-failure
EnvironmentFile=/home/<user>/deployment/personl_projects/property_analyser/.env

[Install]
WantedBy=multi-user.target
```

> Note: `EnvironmentFile` needs `KEY=value` lines without quotes around
> values containing special characters (the URL password uses `%40`
> encoding already, which is safe).

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now property-analyser
curl -s http://127.0.0.1:4180/ -o /dev/null -w '%{http_code}\n'   # expect 200
```

## 4. Exposure

Same pattern as gk_crm: your existing nginx/Caddy fronts it.

```
# nginx fragment
location /pa/ { proxy_pass http://127.0.0.1:4180/; }
# or a subdomain server block proxying / -> 127.0.0.1:4180
```

Caddy does HTTPS automatically; nginx needs certbot. Set `PA_BASE_URL`
to the PUBLIC origin or client share links will point at 127.0.0.1.

## 5. Updating

```bash
cd ~/deployment/personl_projects/property_analyser && git pull
sudo systemctl restart property-analyser
```

Migrations run on boot (idempotent `CREATE TABLE` + column checks).
Database backups are Supabase's job (Point-in-Time restore on paid tiers);
scenario data lives there, not on the box.

## 6. Smoke checks after deploy

- `GET /` → 200 (SPA + login)
- Register a BA, save a scenario, create a presentation, open the link in
  a private window → portal renders and duty figures match the state
  selected.
- OTP code arrives by email (if SMTP configured).
