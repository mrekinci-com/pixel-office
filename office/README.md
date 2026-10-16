# Pixel Office panel

[Turkish guide](README.tr.md) · [Main guide](../README.md)

The English/Turkish management panel serves its React/Canvas interface and Fastify server on the same port. It manages departments, employees, chats, tasks, notes, per-task sessions, schedules, file approvals and the Director terminal. New offices start with the built-in Director and no sample employees or business departments.

For a new installation, follow the [main guide](../README.md). This folder's `.env.example` defines server settings; the root `.env.example` defines Compose addresses and images. Use the separately adapted Tududi image and build the runner from the same source version.

## Local development

Node.js 24 or later is required. Run commands in this folder:

```sh
npm ci --cache .cache/npm --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

`build` writes the interface to `dist/client` and the server to `dist/server`. `npm start` runs the built application and reads `.env`. For development, `npm run dev` starts the server and `npm run dev:ui` starts Vite in another terminal. Vite forwards API requests to port 9400. These commands start servers when you run them yourself.

To prepare only panel settings instead of using the root installer, `node scripts/prepare-env.mjs` writes keys to a missing `.env`. This older helper does not fill the owner password or Tududi credentials; set those manually.

## Server settings

| Variable | Meaning |
| --- | --- |
| `OFIS_OWNER_PASSWORD` | Password for the single owner account; at least 12 characters. |
| `OFIS_SECRET_KEY` | 64 hexadecimal digits for encryption and session signatures; keep permanently. |
| `OFIS_RUNNER_KEY` | Shared runner key, at least 32 characters; an empty value disables the work API. |
| `OFIS_DATA_DIR` | SQLite directory; local `./data`, container `/app/data`. |
| `PORT` | Server port; default 9400. |
| `OFIS_PUBLIC_URL` | Browser-facing panel address used for origin checks. |
| `OFIS_COOKIE_SECURE` | `false` for local HTTP; an HTTPS public origin always forces Secure cookies. |
| `OFIS_BIND` | Defaults to `127.0.0.1` locally; explicitly `0.0.0.0` inside the image. |
| `TUDUDI_BASE_URL` | Internal address of the separate Tududi; default `http://127.0.0.1:9393`. |
| `TUDUDI_ADMIN_EMAIL`, `TUDUDI_ADMIN_PASSWORD` | Separate Tududi administrator allowed to create accounts. |
| `TUDUDI_EMAIL_DOMAIN` | Agent email domain; does not send actual email. |
| `TUDUDI_PUBLIC_URL` | Separate proxy's numeric local/private address; default Compose port 9394. |

Compose supplies the panel port, data path and internal Tududi address. It derives external addresses from root `OFIS_PRIVATE_IP`. For an HTTPS reverse proxy, override `office.environment.OFIS_PUBLIC_URL` with the external HTTPS address in a **local Compose override**, and set `OFIS_COOKIE_SECURE=true` in `office/.env`. The Tududi access proxy must stay on a numeric private address. Tududi access through another domain or HTTPS requires separate adaptation and testing.

Sessions last 12 hours and use signed `httpOnly`, `SameSite=Strict` cookies. Sign-in attempts are rate-limited. Owner mutations require the same origin and `X-Ofis-Islem: 1`. Agent keys cannot access management APIs or owner sessions. Every agent gets a separate Tududi account and key; account secrets are encrypted using AES-256-GCM. Back up `OFIS_SECRET_KEY` securely with the database.

The panel allows account setup retries. On agent deletion, choose whether to keep or delete the account; failed account deletion retains a record. Numbered data migrations in `server/db.ts` must preserve existing databases.

## Language

A fresh office starts in English, regardless of browser language. Existing offices retain their stored language; installations from before language selection retain Turkish. Select Turkish using the TR/EN control or the office language setting. Change it in the bottom-left user controls or Usage and limits → Office language. The preference is stored in the office database and locally in the browser. The office preference takes precedence on subsequent visits. API errors include a stable machine `code` and localized `error` text. Old event records and user-authored content remain unchanged.

Translation catalogs are in `shared/i18n/{tr,en}.ts`; browser state is in `src/i18n/index.ts`. Static translation keys and catalog equality are checked by `npm test`. Dates, times and numbers follow the selected language with `Intl`. Tool names, argument fields and protocol values retain their identifiers in both languages.

## Optional checks

`npm test` makes no model or live Tududi calls. `npm run test:live` and `npm run test:live:b1` create and remove temporary accounts in the configured separate Tududi; use a dedicated test copy only.

Browser and visual tests require Playwright Chromium and system libraries. `bash scripts/prepare-browser.sh` can download Ubuntu 24.04 libraries into `.cache` without installing system packages. These checks inspect the application with Chromium:

```sh
npm run test:i18n:browser
npm run test:browser
npm run test:visual
```

Build first for the narrow bilingual check. It covers sign-in, the six main office/management screens, the Director window, language selection and reload. It uses Fastify injection and browser request interception without a listening HTTP port. The full browser and visual suites remain separate.

Visual baselines (`tests/__screenshots__`) are not shipped in the repository (about 180 MB); create them once on your machine with `npm run test:visual -- --update-baselines`, then compare later changes with `npm run test:visual`. `npm run test:visual -- --update-baselines` changes them; review visual changes before updating. Temporary images and reports are in `.test-data`. Use `npm run screenshots -- --readme` to regenerate the five fictional 1600×900 README images in `docs/images`. For the screen-size/theme matrix, use `npm run screenshots -- --screen office|director|agents|tasks|schedules|approvals` (choose one); add `--language en|tr` to select the interface language (default: English). These captures use no live office, runner, model account or listening port. Visual tests also need Python and Pillow.

Artwork sources and licenses: [ASSET-LICENSES.md](public/assets/ASSET-LICENSES.md), [production notes](public/assets/source/GENERATION.md). Regenerate atlases with `python3 scripts/prepare-art.py` using Python with Pillow; normal builds and operation do not require it. The scene comparator `scripts/compare-office.py` uses test screenshots in `.test-data/screenshots`.

If an old installation did not store an agent password, `scripts/legacy-account-login.mjs` is a local operator tool. Its default only lists records; `--uygula` changes data. It is unnecessary for new installations.

UI strings are keyed by their Turkish source text. Translation keys and Turkish UI fixtures remain unchanged when comments and developer documentation are translated.

The Director’s persistent terminal is exempt from per-run and daily duration limits by default, including existing policies with `dailyMinutes: 120` or the temporary `1440` workaround. No policy edit is needed. Terminal wall time remains visible as `duration_ms`; only `budget_duration_ms` counts toward duration quotas. Closed terminal sessions are excluded too. Token budgets, tool-call limits, run-count caps, owner approvals, stop controls and heartbeat expiry still apply. Nonterminal work keeps its duration limits.
