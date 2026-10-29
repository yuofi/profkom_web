# Profkom Web frontend

> Current unified-release UI (28 October 2026): [user guide](../docs/USER_GUIDE_20261028.md) and [current API contracts](../backend/docs/API_V13_ADDITIONS.md). Older descriptions below retain their historical context; the guide covers the updated profile, achievements, templates, history, support and material redirects.


React 19, TypeScript and Vite; TanStack Query for server state, Formik and zod for forms, CSS Modules with the variables in `src/styles/vars.css`. API clients live in `src/utils/api/`; the texts of server errors are chosen by code in `src/utils/api/messages.ts`.

## Environment

Variables are read at build time (`src/utils/env.ts` rejects a build without them):

| Variable | Meaning |
| --- | --- |
| `VITE_ENVIRONMENT` | `development` sends requests to `VITE_BACKEND_URL`; `production` and `test` use the same origin (`/api`) |
| `VITE_BACKEND_URL` | API origin in development; required but unused in production |
| `VITE_DEMO_MODE` | `true` serves synthetic demo data in development only; `false` works with a real API. Production builds never contain the mocks |
| `VITE_APP_ID` | VK ID application number; must equal the backend's `VK_CLIENT_ID`. Without a positive number the VK button is not shown |
| `VITE_REDIRECT_URL` | VK ID redirect address, the `/auth` page of the site |

On the server the build takes these from `frontend/.env`: the Docker build copies the folder and runs `npm run build`.

## Commands

```sh
npm ci
npm run dev                 # development server
npm run lint
npm run build               # tsc -b and the production build into dist/
npm test -- --run           # unit tests
```

Integration (`npm run test:integration`) and browser checks (`npm run test:e2e`) need a disposable API from `backend/tests/live_api.py`; see [backend/TESTING.md](../backend/TESTING.md). They never use a shared or production server.

## Production

`Dockerfile` builds the app and serves `dist/` with nginx (`nginx.conf`): TLS on 443, SPA fallback to `index.html`, `/api/` proxied to the backend container. A file is requested from `/api/files/{id}/content`; the backend checks access and answers with `X-Accel-Redirect` to the internal `/_storage`, which fetches the object by a short signed link and hides the storage headers. The certificate files are mounted from `./certs` (see `docker-compose.yml`).
