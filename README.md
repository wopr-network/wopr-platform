# wopr-platform

The WOPR platform backend — the control plane for WOPR instances. Manages instance lifecycle, handles auth, orchestrates Docker, and hosts all monetization. Core never knows about billing, tenancy, or tiers.

## What This Is

- Fleet orchestration and WOPR-as-a-Service (WaaS)
- Docker instance lifecycle management via REST API
- Bot profile templates and automated image updates
- Reverse proxy routing per tenant via Caddy
- Future home of auth, billing, metering, and feature gating

## What This Is Not

- Not the WOPR core runtime (`wopr-network/wopr`)
- Not the Discord bot plugin (`wopr-network/wopr-plugin-discord`)
- Core code extraction is tracked separately (WOP-297)

## Architecture

```
src/
  api/            — platform REST API (Hono)
  fleet/          — fleet management, Docker integration, image polling
  instance/       — Docker lifecycle, storage, templates (WOP-297 target)
  observability/  — health, metrics, logging (WOP-297 target)
  monetization/   — socket, metering, Stripe, adapters (WOP-216 epic)
  auth/           — Better Auth (future migration from core)
  proxy/          — reverse proxy config (Caddy)
  config/         — configuration and logging
```

## Tech Stack

- **Hono** — HTTP framework (matches core)
- **SQLite** via better-sqlite3 (matches core)
- **TypeScript**, **Biome** lint/format, **Vitest** tests
- **Docker** — instance orchestration via dockerode
- **Caddy** — reverse proxy for tenant routing

## Development

```bash
npm install
npm run dev          # Start dev server with tsx
npm run build        # Compile TypeScript
npm run lint         # Lint with Biome
npm test             # Run tests with Vitest
```

## Docker

```bash
docker build -t wopr-platform .
docker run -p 3100:3100 wopr-platform
```

## Environment Variables

| Variable         | Default       | Description            |
|------------------|---------------|------------------------|
| `PORT`           | `3100`        | HTTP server port       |
| `NODE_ENV`       | `development` | Runtime environment    |
| `LOG_LEVEL`      | `info`        | Winston log level      |
| `FLEET_API_TOKEN`|               | Bearer token for fleet API |
