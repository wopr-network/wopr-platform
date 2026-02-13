# wopr-platform

Fleet orchestration and WOPR-as-a-Service (WaaS) platform. Manages the lifecycle of WOPR bot instances via Docker, providing a REST API for fleet management, bot profile templates, and automated image updates.

## Architecture

```
src/
  api/          — Hono HTTP server and route handlers
  fleet/        — Fleet management logic and Docker integration
  config/       — Configuration and logging
```

### Key Components

- **Fleet Manager** — Docker API integration for spawning, stopping, and monitoring bot containers
- **Bot Profiles** — Seed templates for configuring bot instances at deployment
- **Image Poller** — Watches for new Docker image tags and triggers rolling updates
- **REST API** — Endpoints for fleet CRUD, health checks, and status

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

| Variable    | Default       | Description            |
|-------------|---------------|------------------------|
| `PORT`      | `3100`        | HTTP server port       |
| `NODE_ENV`  | `development` | Runtime environment    |
| `LOG_LEVEL` | `info`        | Winston log level      |

## Related Issues

- WOP-217: epic: wopr-platform — fleet orchestration and WaaS
- WOP-220: Fleet Manager — Docker API integration + REST endpoints
- WOP-221: Seed bot profile templates for fleet deployment
- WOP-233: Fleet image update poller
