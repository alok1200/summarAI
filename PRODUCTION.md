# Production Deployment Guide

This document covers everything you need to deploy SummarAI to production
safely. It assumes you've already run the app in dev mode and verified it
works locally.

---

## 0. Production-readiness verification (run before every deploy)

The project ships with a complete test + lint + build pipeline. Run all
four checks locally before cutting a production build:

```bash
npx tsc --noEmit    # Type-check — MUST pass with 0 errors
bun run lint        # ESLint — MUST pass with 0 errors (warnings OK)
bun test            # Unit tests — MUST all pass (currently 179 tests)
bun run build       # Production build — MUST succeed
```

All four are enforced as hard gates — if any fails, fix it before deploying.
The build also runs `tsc` and `eslint` internally, so a successful build
implies type-check + lint passed.

---

## 1. Pre-deployment checklist

Before cutting a production build, verify:

- [ ] `SESSION_SECRET` is set to a 64-char random hex string
      (`openssl rand -hex 32`). If unset, the app boots but logs a warning
      and sessions won't survive a server restart.
- [ ] `DATABASE_URL` points to a production Postgres (Neon / Supabase / RDS
      / etc.). SQLite is fine for local dev but not multi-instance production.
- [ ] `GEMINI_API_KEY` is set (get one free at https://aistudio.google.com/apikey).
      The app refuses to start in production if this is missing (fail-fast).
- [ ] `YOUTUBE_PROXY_URL` is set IF you expect heavy YouTube usage from a
      single IP (otherwise users will hit the "paste transcript" fallback
      when YouTube rate-limits you)
- [ ] `NEXT_PUBLIC_APP_URL` is set to your public URL
- [ ] Cron job for DB backups is configured (see §5 below — Neon has
      built-in PITR so this may be optional)
- [ ] Reverse proxy (Caddy / nginx) is configured to forward to port 3000
      and to set `X-Forwarded-For` / `X-Real-IP` headers (required for
      IP-based rate limiting of anonymous requests)

### Startup-time env validation

The app validates critical env vars ONCE at boot (via `instrumentation.ts`
+ `src/lib/env.ts`). In production:
- Missing `DATABASE_URL` or `GEMINI_API_KEY` → `process.exit(1)` with a
  clear error in the logs. The container/process manager restarts the app,
  but it will keep exiting until you fix the env.
- Missing `SESSION_SECRET` → warning logged, app boots, but sessions are
  per-process (users get logged out on every restart).

In development, the same checks throw immediately so you see the error
in the terminal/browser instead of a silent 500 later.

---

## 2. Building

```bash
npm run build
```

This produces a self-contained, standalone build in `.next/standalone/`.
The build:

- Fails on TypeScript errors (no `ignoreBuildErrors`)
- Fails on ESLint errors
- Includes all static assets in `.next/standalone/public/`
- Includes the Next.js runtime in `.next/standalone/.next/static/`

---

## 3. Running

```bash
NODE_ENV=production node .next/standalone/server.js
# or, with bun (faster startup):
NODE_ENV=production bun .next/standalone/server.js
```

The server listens on port 3000 by default. Override with `PORT=8080`.

### Process management

For a single-instance deployment, use `systemd` or `pm2`:

```ini
# /etc/systemd/system/sumarai.service
[Unit]
Description=SummarAI
After=network.target

[Service]
Type=simple
User=sumarai
WorkingDirectory=/opt/sumarai
EnvironmentFile=/opt/sumarai/.env
ExecStart=/usr/bin/bun /opt/sumarai/.next/standalone/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now sumarai
sudo journalctl -u sumarai -f        # tail logs
```

---

## 4. Reverse proxy (Caddy)

The included `Caddyfile` is for the Z.ai preview gateway. For production,
use a simpler config:

```caddyfile
example.com {
    reverse_proxy localhost:3000 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        header_up X-Real-IP {remote_host}
    }

    # Compression
    encode gzip zstd

    # Static caching
    @static path /_next/static/*
    handle @static {
        header Cache-Control "public, max-age=31536000, immutable"
    }

    # Health check passthrough (no caching)
    @health path /api/health
    handle @health {
        header Cache-Control "no-store"
    }
}
```

Caddy automatically provisions HTTPS via Let's Encrypt — no extra config
needed.

---

## 5. Database backups

If using SQLite, set up a cron job on the server:

```bash
# crontab -e
# Daily 3am backup, keep last 30 days
0 3 * * *  cd /opt/sumarai && npm run db:backup >> /var/log/sumarai-backup.log 2>&1

# Weekly prune (Sunday 4am) — belts and suspenders
0 4 * * 0  cd /opt/sumarai && npm run db:backup:prune >> /var/log/sumarai-backup.log 2>&1
```

To restore from a backup:

```bash
npm run db:restore backups/2026-07-04T030000.db.gz
```

This creates a pre-restore safety backup before overwriting the live DB.

If using PostgreSQL, use `pg_dump` instead — the SQLite backup script
won't help you there.

---

## 6. Health checks

The app exposes two endpoints for monitoring:

- **`GET /api/health`** — liveness + readiness probe. Returns 200 if the
  process is alive AND the DB is reachable, 503 otherwise. Use this for
  k8s livenessProbe / readinessProbe and for the reverse proxy's
  `health_uri`.

- **`GET /api`** — service descriptor. Returns the app name, version,
  and list of endpoints. Cheaper than `/api/health` (no DB call) — use
  this if you just want to confirm the process is up.

### Caddy health check

```caddyfile
example.com {
    # Caddy doesn't have a built-in health check for upstreams, but you
    # can use a fallback proxy to display a maintenance page when the
    # app is down:
    reverse_proxy localhost:3000 {
        health_uri /api/health
        health_interval 30s
        health_timeout 5s
    }
}
```

### Kubernetes

```yaml
livenessProbe:
  httpGet:
    path: /api/health
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 30
readinessProbe:
  httpGet:
    path: /api/health
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
```

---

## 7. Logs

All logs are structured JSON, one event per line, written to **stdout**
(info) and **stderr** (error). Capture them with `journalctl` (systemd),
`kubectl logs` (k8s), or your container's logging driver.

### Log levels

- `debug` — verbose diagnostics (off by default in production)
- `info` — request in/out, normal operations
- `warn` — rate limit hits, fallbacks used
- `error` — failures needing operator attention

Set `LOG_LEVEL=warn` for quieter logs, `LOG_LEVEL=debug` for verbose.

### Log fields

Every log line includes:

- `ts` — ISO timestamp
- `level` — debug / info / warn / error
- `event` — dotted event name (e.g. `chat.request`, `auth.login.failed`)
- `requestId` — per-request correlation ID (also in `x-request-id` response header)
- `userId` — when the request was authenticated
- `route` — API route name (e.g. `chat`, `youtube-summary`)
- `durationMs` — for response logs
- `error` / `digest` — for error logs

### grep examples

```bash
# All errors in the last hour
journalctl -u sumarai --since "1 hour ago" | jq 'select(.level=="error")'

# All rate-limit hits
journalctl -u sumarai | jq 'select(.event | endswith("rate_limited"))'

# All failed logins
journalctl -u sumarai | jq 'select(.event=="auth.login.failed")'

# Trace one request by its ID (from the x-request-id response header)
journalctl -u sumarai | jq 'select(.requestId=="abc12345")'
```

---

## 8. Security

### Authentication

- Email + password with scrypt hashing (memory-hard, slow to brute-force)
- Session tokens are HMAC-signed with `SESSION_SECRET` — a DB-only leak
  cannot forge tokens
- Sessions expire after 30 days
- Cookies are `httpOnly`, `sameSite: "lax"`, `secure` in production
- Identical 401 response for "user not found" vs "wrong password"
  (prevents user enumeration)

### Rate limiting

- 10 requests/minute per user on AI endpoints (`/api/chat`,
  `/api/youtube-summary`, `/api/youtube-interview`, `/api/youtube-load`)
- Tunable via `RATE_LIMIT_AI_PER_MIN`
- Returns 429 with `Retry-After` header
- In-memory (per-process). For multi-instance deployments, swap the
  `store` Map in `src/lib/rate-limit.ts` for a Redis backend

### Body size limits

- Default 2 MB max body size on JSON endpoints (`MAX_BODY_BYTES`)
- Auth endpoints have stricter limits (1 KB login, 4 KB signup)
- Prevents memory-exhaustion DoS

### Security headers

Set on every response by the proxy middleware:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()`
- `X-DNS-Prefetch-Control: off`
- `x-powered-by` stripped

### Error sanitization

In production, internal error messages are replaced with a generic
"Internal server error" + a short `digest` that operators can grep for
in logs. Raw error messages (which may include DB connection strings,
file paths, library names) are never sent to clients.

### What's NOT included (and why)

- **CSP** — A strict CSP requires nonce-based script-src for Next.js
  inlined runtime. Add via your reverse proxy once tested.
- **CSRF tokens** — The auth cookie is `sameSite: "lax"`, which blocks
  cross-site POSTs from forms. For stricter protection, add a
  double-submit cookie check.
- **OAuth** — Email/password only for now. OAuth env vars are reserved
  in `.env.example`.

---

## 9. Monitoring recommendations

For a serious production deployment, add:

1. **Error tracking** — Sentry / Rollbar. Wire into
   `src/lib/logger.ts:emit()` to forward `level=error` events.
2. **Metrics** — Prometheus. Add a `/metrics` endpoint that exports
   request counts, latencies, rate-limit hits, LLM call counts.
3. **Uptime monitoring** — UptimeRobot / Pingdom / Better Uptime. Point
   at `/api/health` and alert on non-200.
4. **Log aggregation** — Datadog / Loki / Elasticsearch. Forward
   stdout/stderr.
5. **DB backups verification** — periodically restore from a backup in
   a staging environment to verify they actually work.

---

## 10. Updating

To deploy a new version:

```bash
git pull
npm install              # in case deps changed
npm run db:push          # in case schema changed (use migrate for prod)
npm run build
sudo systemctl restart sumarai
```

Zero-downtime updates require a blue/green or rolling deployment (k8s
makes this easy; for systemd you'd need a second instance + a load
balancer).

---

## 11. Troubleshooting

### Build fails with type errors

The build now fails on type errors (previously bypassed). Fix the type
error — don't bypass it. If you must ship without fixing (not
recommended), temporarily set `typescript.ignoreBuildErrors: true` in
`next.config.ts`.

### 401 on every API call

- Check that cookies are being sent (browser devtools → Application →
  Cookies → `chatgpt_session`)
- Check that `SESSION_SECRET` is the same value it was when the session
  was created (if it changed, all old sessions are invalidated — by
  design)
- Check that `NODE_ENV=production` so the `secure` cookie flag is set
  (over HTTPS only)

### 429 on every AI call

- You're hitting the per-user rate limit. Either:
  - Wait 60 seconds for the window to reset
  - Increase `RATE_LIMIT_AI_PER_MIN`
  - Log out and log back in (no — same user ID, won't help)

### YouTube "Sign in to confirm you're not a bot"

- IP-level rate limit. Set `YOUTUBE_PROXY_URL` to route through a
  different IP. See `.env.example` for format details.

### DB errors

- Check `/api/health` — it returns the DB error message
- Check that `DATABASE_URL` is correct and the DB is reachable from
  the server
- For SQLite, check file permissions on `db/custom.db`
