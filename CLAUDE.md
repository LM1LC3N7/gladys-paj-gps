# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for PAJ GPS trackers: a Node.js
service (Node 22+, ESM, no build step) that runs in its own sandboxed Docker
container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It reads the trackers of one PAJ GPS account
through the documented API of connect.paj-gps.de (e-mail address and
password, then a bearer token), as the pajgps-api library (MIT) does; that
library is ported, not installed. Read only, pull only. See `TODO.md` for the
status and every decision.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "429"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # regenerate cover.png (plain Node)
npx github:GladysAssistant/integration-store .   # store admission checks
```

On this machine, set `npm_config_cache` and `npm_config_logs_dir` to
`C:\Users\user\devtools\npm-cache` before any npm command (never AppData).

## Architecture

```
index.js                          SDK wiring only (src/handlers.js)
src/handlers.js                   every SDK handler, registered before connect()
src/app.js                        PajApp: pace, readings, failures, states, alerts
src/paj/client.js                 login, token renewal, the three data routes
src/paj/http.js                   the only network access (node:https, no redirect)
src/paj/parse.js                  answers -> plain objects (no IMEI, no alert position)
src/paj/errors.js                 error codes; what a refusal is
src/devices.js                    devices (pure), external ids, never fewer features
src/geo.js                        distance to home, presence with a margin
src/config.js                     DEFAULTS (mirror the manifest) + normalization
src/store.js                      /data: attempt, pause, refusal, marks (salted)
src/budget.js                     sliding window of the states sent per minute
src/i18n.js                       statuses and messages (en / fr)
gladys-assistant-integration.json manifest
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, fake Gladys (SDK) + fake PAJ API
```

## Rules

- **External ids are forever**: `device:<16 hex of SHA-256 of
"gladys-paj-gps:tracker:<PAJ id>">` and the feature keys of
  `src/constants.js`. Changing the recipe creates new devices and orphans
  the old ones. The same goes for every key users store: manifest
  `config_schema`, `actions`, the scene trigger key, its fields and their
  option values.
- **Read only**: no request other than the login, the renewal and the three
  data routes; no command (alarms, geofences, device settings), nothing
  marked read. Adding one needs Louis's decision, off by default, never a
  switch.
- **Pace**: never read faster than the interval (5 minutes at least): the
  time of the last attempt is in `/data`, written before the request.
- **Privacy**: never log a URL (the login query holds the credentials),
  never put the e-mail address, the password, a token, a position, a tracker
  name or id in a log, an error message or `/data` (salted HMAC only). The
  houses of Gladys stay in memory.
- **Refusals**: a login refused by the API is final and persisted; never an
  automatic retry. A token is renewed at most once per reading.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set by hand once, before the first release).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are `{ "en": ..., "fr": ... }` objects; the catalog
  `description` holds 10 to 100 characters per language.
- **Encoding.** Files are UTF-8 without BOM; `test/encoding.test.js` refuses
  mojibake, control bytes and the word "encrypted" for the password (a
  `secret` field is kept in clear in the database of Gladys).
- **pajgps-api is MIT**: its notice stays in `THIRD_PARTY_NOTICES.md`, copied
  into the image.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only).
