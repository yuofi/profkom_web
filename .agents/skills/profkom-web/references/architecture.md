# Architecture and domain invariants

Read this reference before changing project code. It describes the current source tree, not the older sibling export.

## Runtime shape

```text
browser
  -> nginx :443
     -> static Vite build
     -> /api/* proxy to backend:8000
        -> FastAPI routes in backend/main.py
           -> auth.py + Database singleton
              -> SQLite
           -> S3 presigned uploads / VK login
```

- `docker-compose.yml` builds two services. The backend mounts `./data` at `/app/data`; the frontend terminates TLS and proxies `/api/` to the backend.
- `backend/entrypoint.sh` seeds guides and the configured superadmin through `scripts/preset_db.py`, then starts `uvicorn main:app` on port 8000.
- The frontend is React 19 + TypeScript + Vite, React Router, TanStack Query, Axios, Formik/Zod, TipTap, and CSS Modules.
- The backend is FastAPI + Pydantic 2 + SQLAlchemy 2 + SQLite, with JWT access tokens, opaque persisted refresh tokens, boto3 S3 integration, and VK login.

## Backend ownership

- `main.py`: Pydantic schemas, the `/api` router, endpoint authorization, and most service logic. It is a monolith; keep related validation close to its route unless a deliberate refactor is in scope.
- `database.py`: ORM tables, import-time SQLite migrations, conversions to dataclasses, transactions, and cross-table synchronization.
- `models.py`: internal dataclasses returned by `Database`; these are not the HTTP schemas.
- `auth.py`: password hashing, access-token verification, opaque refresh-token lifecycle, and reusable authorization dependencies.
- `utils/s3_service.py`: boto3 client, presigned URL generation, and server-side remote image copy for VK avatars.
- `tests/`: executable API contract and security expectations. Strict `xfail` tests intentionally describe unresolved correct behavior.

All application routes have `/api`; public/anonymous access currently includes block listing and global guides. Some other anonymous exposure is a known defect, not an intended pattern.

## Data model and coupled fields

The database has six active tables:

- `users`: credentials and authorization flags, KKR score, group, block string, photo URL, `pgas_admin`, and `events_roles`.
- `contact_info`: one-to-one row sharing the user's ID; name parts, `kkr_name`, contact details, group, block string, membership approval, study type.
- `block`: block name primary key, master and HR stored as mutable `kkr_name` strings, count, and member IDs serialized as JSON.
- `guides`: Markdown content, description, optional source link, and an `owner_block`; `none`, `all`, or empty mean global.
- `pgas_entries`: downloadable document metadata and uploader.
- `refresh_tokens`: opaque UUID token, user ID, and ISO expiration.

Important invariants:

- `users.user_id == contact_info.user_id`; a normal user needs both rows.
- Group and block data are duplicated between `users` and `contact_info`. API output often combines the two.
- Membership is represented three ways: the delimited, sorted block string on both user/contact rows and JSON `arr_of_human` on the block. `_sync_blocks_for_user` and `_sync_users_for_block` own this relationship.
- Block masters are forced into their block's member array. Master/HR identity is based on exact `contact_info.kkr_name`, not user ID.
- `admin` is partly derived by `_sync_admin_rights`: a person whose `kkr_name` equals any block's master or HR receives admin rights. This design is fragile under duplicate or renamed KKR names and is covered by strict-`xfail` security tests.
- Blocks are serialized as a comma-separated sorted string with no spaces. Parsing accepts commas, semicolons, and newlines, but contact filtering currently compares the entire serialized string exactly.
- `events_roles` is currently a JSON string in `users`, shaped like `[{"event": "...", "role": "..."}]`. There is no normalized events table or dedicated events API. The current UI duplicates hard-coded event/role lists and should not be treated as a mature contract; validate and centralize it when extending the feature.
- `group_number` is stored as text internally even though registration and some response types model it as a number. Check each boundary rather than assuming one type throughout.
- `photo_url` is persisted on `users`; contact conversion exposes it through the joined user relationship.

## Authentication and authorization

- Passwords use bcrypt through Passlib.
- Access tokens are signed JWTs with a `sub`, `type=access`, and a short TTL. The browser keeps the access token in a JavaScript-readable cookie.
- Refresh tokens are random UUIDs persisted in SQLite and sent as `HttpOnly; Secure; SameSite=None` cookies. Refresh rotates the token.
- `get_current_user` rejects missing/invalid/deleted/banned users. `get_current_user_optional` converts all authentication failures to anonymous access for public guide filtering.
- `require_admin` accepts `admin` or `super_user`; `require_pgas_admin` accepts `pgas_admin` or `super_user`; `require_superuser` accepts only `super_user`.

Legacy backend permission snapshot (verify current routes and contract tests before reuse):

| Domain | Read | Mutate |
| --- | --- | --- |
| Own profile | authenticated | self, admin, or superuser |
| Other profile | currently anonymous (known defect) | admin/superuser; delete is superuser only |
| Guides | global guides anonymous; block guides members; all guides superuser | owning block master or superuser |
| Blocks | anonymous list | enter/exit authenticated; update own master/HR or superuser; create/delete superuser |
| Contacts | currently anonymous list (known personal-data defect) | filter is admin/superuser; profile PATCH performs edits |
| PGAS | authenticated | `pgas_admin` or superuser |
| Upload URLs | authenticated | `guides`: block master/superuser; `pgas`: PGAS admin/superuser; other folders have no extra role check |

Frontend gating is different and must not replace backend checks:

- `/auth` is public.
- The main layout requires an active/approved `/session`. Pending/rejected/archived accounts are gated before working queries; the profile is a separate query.
- New actions and routes use session/object capabilities. The legacy admin entry is gated by `review_registrations`; legacy guide editing retains its compatibility helper.
- Guide edit access mirrors the block-master rule using the fetched block list.

## Frontend ownership

- `src/App.tsx`: provider stack and route tree.
- `src/utils/ctx.tsx`, `session.ts`, `me.tsx`: session and separate profile contexts. A changed access fingerprint cancels/removes private cache before publishing the new session.
- `src/mocks/`: explicit development/test Axios transport with synthetic role/scenario fixtures, loaded before first render only in DEV. `demoData.ts` holds the DEV guard; set `VITE_DEMO_MODE=false` for real API. There is no error-to-mock fallback or production mock transport.
- `src/pages/Wrappers/wrappers.tsx`: route gating.
- `src/pages/Workspace/` and `components/Workspace/`: dashboard, responsive shell, events, shared tasks/assessment inputs, reports, seasons, membership, materials and directory. Routes are loaded by domain. `/profile` is separate and includes avatar selection.
- `src/utils/api/index.ts`: shared Axios client and token refresh.
- `src/utils/api/*.api.ts`: domain calls. `contract.ts` holds API 1.3 DTOs separated into public data, assessment inputs and calculated results; `types.ts` retains legacy DTOs. `request.ts` validates errors/list wrappers and follows bounded cursor chains.
- `src/utils/filterRoles.ts`: UI permission helpers, especially guide ownership.
- `src/utils/api/files.api.ts`: new intent -> binary upload -> complete/download flow. `s3-utils.ts` remains for legacy PGAS/gallery upload compatibility.
- `src/pages/Admin/panels/`: admin UI; `BlocksManagement.module.css` is currently shared by more than one panel.
- `src/styles/vars.css`: canonical palette, typography, radii, and elevation tokens.

The API client returns a mix of full Axios responses (`authApi`, image upload) and unwrapped data (blocks, contacts, guides, PGAS). Preserve the local convention of the module being edited or deliberately normalize all affected callers.

## Deployment and configuration traps

- Backend settings load `.env` relative to the process working directory. `DATABASE_PATH` is required for a useful SQLite URL but is absent from the tracked backend example; verify it without exposing its value.
- JWT settings are read directly with `os.getenv` in `auth.py`, separate from `Settings`.
- The frontend runtime schema requires `VITE_BACKEND_URL`, `VITE_ENVIRONMENT`, `VITE_APP_ID`, and `VITE_REDIRECT_URL`. Production still validates `VITE_BACKEND_URL` even though API requests use same-origin `/api`.
- `VITE_DEMO_MODE` is intentionally read outside the runtime schema: in `import.meta.env.DEV`, every value except the literal string `false` enables the local no-backend demo; production builds always bypass it.
- The Nginx config serves HTTPS on 443 and expects certificate files mounted at `/etc/nginx/ssl`.
- New files require intent, binary PUT and complete, then object-checked temporary download URLs. Legacy S3 helpers still use their old presigned/public-URL flow; verify the owning feature before changing it.
- `preset_db.py` is idempotent by guide title and admin email, but it mutates whichever database `DATABASE_PATH` selects. Treat it as a real data mutation.

Frontend planning and acceptance evidence live in `frontend/docs/PLAN.md`, `CHECKLIST.md`, `MOCKS.md` and `ACCEPTANCE.md`. Mock-ready is separate from real API/deployment readiness. No client KKR/rank/tenure computation.
