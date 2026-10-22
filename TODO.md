# TODO — PAJ GPS v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own (Louis's rule: one message per wave in
  /t/10385). Lot 13, line 10 of `_ref/lot13/proposition.md`.

## Status

- [x] **Milestone 1 — MVP** (2026-10-22): pajgps-api 0.4.1 ported to
      JavaScript (login, token renewal, devices, last positions, alerts);
      one device per tracker (latitude, longitude, speed, battery, last
      seen, distance to home, at home), read only; trigger `tracker_alert`;
      pace kept in `/data`; final refusals; bounded pauses; no position,
      name, id or credential in logs or `/data`; docs en/fr. Tested with
      unit tests against the SDK's fake Gladys, a fake PAJ API (shapes of
      pajgps-api's models and of `api-docs.json`) and loopback http servers.
      **Never tested with a real tracker nor account.** No Docker on this
      PC: no e2e test in a container. The store validator
      (`npx github:GladysAssistant/integration-store .`) was not run by the
      dev agent (the main session runs it).
- [x] **Review corrections** (2026-10-22, review 1 of `3ba7826`, 5 important
      and 7 minor points): see "Decisions" (review corrections);
      `test/review.test.js` holds the scenarios S1-S12 of the review,
      inverted.
- [ ] **Milestone 2 — real account** (a tester with a PAJ tracker): record
      real answers as fixtures (ids, names, positions removed), fix what
      differs. To check first:
  - whether the login accepts the credentials in a form body (more private
    than the query the API documents);
  - the lifetime of a token, and the answer of `updatetoken` to an expired
    refresh token (401 with `{"error":...}` assumed);
  - the answer to a wrong password (401 `{"error":"Unauthenticated"}` as
    documented?) and whether PAJ locks an account after a few refusals;
    whether it answers 429 at all, and with Retry-After;
  - the battery field of `getalllastpositions` (`battery` in the OpenAPI
    example, `battery_level` in pajgps-api's model: both read), the unit of
    `speed` (km/h assumed);
  - `customnotifications`: inclusive dates, order, what `noOfNotification`
    keeps (the newest?), the alert types beyond the documented ones.
- [ ] **Milestone 3 — the position of a Gladys user** (needs a change of the
      Gladys core): the same need as gladys-invoxia and gladys-phonetrack
      (https://github.com/GladysAssistant/Gladys/issues/3224).
- [ ] **Later, if users ask**: the voltage of car trackers
      (`sensordata/last`), the geofences, a "moving" feature, a choice of
      the house, several accounts.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public (the main session publishes),
      then the store validator once the image is published.

## Decisions

- **Duplicate check**: done by the main session before the brief (lot 13);
  not repeated here.
- **Reuse**: pajgps-api 0.4.1 (MIT, Python, read at commit `38c354a`)
  cannot run in this Node image: its client is ported to JavaScript
  (`src/paj/`), the MIT notice in `THIRD_PARTY_NOTICES.md`, copied into the
  image. The integration was moved into the Home Assistant core in 2026.6
  (HACS repository marked obsolete); the library is the maintained part.
  Structure from LM1LC3N7/gladys-invoxia (the neighbour module: GPS trackers
  of a cloud account) and, for the pace and refusals of the lessons of lots
  11 and 12, LM1LC3N7/gladys-webuntis. The standard Apache-2.0 `LICENSE`
  (no personal name).
- **Version**: 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-paj-gps:0.1.0`); the first patch release gives
  0.1.1. The manifest test checks that they agree, never a fixed version.
- **No application key**: the API of PAJ is open to its customers with
  their own account (the integration of Home Assistant was made with the
  agreement of PAJ); nothing is hard-coded but the API address. The
  User-Agent is `gladys-paj-gps/<version>`: never an app's.
- **Endpoints** (pajgps-api): `POST /api/v1/login?email&password`,
  `POST /api/v1/updatetoken?email&refresh_token`, `GET /api/v1/device`,
  `POST /api/v1/trackerdata/getalllastpositions` (`{ deviceIDs,
fromLastPoint: false }`), `GET /api/v1/customnotifications/<id>?startDate
&endDate&noOfNotification=20`. No other route; nothing is written at PAJ
  (no `markReadBy*`, no device update).
- **Credentials in the query**: the API documents email and password (and
  the refresh token) as query parameters of a POST; pajgps-api sends them
  so. Kept as documented (a body is untested); over HTTPS, no URL is ever
  logged or put in an error message; noted for milestone 2.
- **Token**: in memory only (never `/data`); a restart logs in again (within
  the pace). A 401 on a data request renews once per reading: refresh token,
  then the password if the refresh is refused; a second 401 is a `session`
  error of that reading (retried at the next interval). Never a loop.
- **Refusals** (lesson of lot 12: final, persisted): a login answered by
  the API itself with a refusal (any 401; another 4xx with its JSON
  envelope `{ "error": ... }` / `{ "success": ... }`; a 2xx with `error`)
  stores an HMAC of the refused credentials (`refused`), erased at the
  first login that works. No automatic retry: saving other credentials reads
  at once; the test button tries once, never sooner than the interval. A 403
  page that is not the API's (firewall, CDN) pauses 6 h (not a refusal); a
  404 or a 2xx without a token is an unexpected answer, retried at the
  interval.
- **Pace** (lessons of lot 11): one reading per interval, decided by a
  minute tick from `lastAttemptAt` in `/data` (written before the request
  when the last write of it is older than a minute). Neither a restart, a
  reconnection to Gladys (a reading in flight is joined, not started again),
  an unchanged configuration saved, the test button nor Discovery reads
  sooner. One reading at a time; a reading of a former configuration
  publishes nothing and sets no status (generation checked after every
  await), but what PAJ said about the credentials or a pause is kept.
- **Pauses**: HTTP 429 or 5xx on the list or the positions: Retry-After (or
  15 min) bounded max(1 min, interval) to 6 h, persisted, capped when read
  back, removed after a reading that works. The test button never lifts
  it. On the alerts: a 5xx or a timeout only skips the alerts of that round
  (secondary endpoint); a 429 pauses every path after the states are
  published.
- **External ids**: `device:<16 hex of SHA-256("gladys-paj-gps:tracker:<id>")>`
  (the PAJ id is stable and unique; the id, the IMEI and the phone number
  never appear in Gladys). Feature keys: `latitude`, `longitude`, `speed`,
  `battery`, `last_seen`, `distance_home`, `at_home`. A tracker without a
  name gets `PAJ GPS <4 hex of its key>`; a deleted one (`deleted_at`) is
  not followed; an entry without an id is skipped.
- **Feature types** (core constants; units only those of
  `DEVICE_FEATURE_UNITS_BY_CATEGORY`): latitude / longitude
  `unknown`/`unknown` without unit; speed `speed-sensor`/`decimal`
  `kilometer-per-hour`; battery `battery`/`integer` `percent` (only when
  `device_models[0].standalone_battery = 1`, as pajgps-api's `has_battery`,
  or when a battery value was read); last seen `text`/`text`
  (`YYYY-MM-DD HH:MM UTC`); distance to home `distance-sensor`/`decimal`
  `m`; at home `unknown`/`binary` (never a switch, a presence or a motion
  sensor). All read only. History: battery only by default.
- **Presence**: `location: true`; `getHouses()` at every start and
  connection, kept in memory only (never logged, never `/data`); the
  distance to the nearest located house (haversine, rounded to the meter).
  At home within the radius (100 m to 1 km, 200 m by default); away beyond
  the radius plus max(100 m, half the radius); in between the previous
  value. The home features appear in Discovery once a house has a
  position, and stay on a created device (never fewer features).
- **Dated values** (lesson of lot 12): no `created_at` (the values are the
  current ones). The date of the last position published is kept per
  tracker in `/data` (`marks[HMAC(id)].f`, unix seconds): after a restart,
  the same position is never published again as a new one; a newer one
  goes, and a device just created gets its current values.
- **Alerts**: only for the trackers created in Gladys; the first reading of
  a tracker records the date (no request, no event); then the window from
  that date (1 h 2 min back at most) to now + 1 min, 20 alerts per tracker.
  An alert fires once (date and HMAC of the ids of the last second kept in
  `/data`), only if it is at most 1 h old; 30 events per reading at most
  (the most recent ones; the older are recorded). The marks are written before the events leave (a
  crash never fires them twice). Event data: `device`, `alert_type` (the
  types of `alert_types.py`, else `other`), `device_name`, `at` (UTC text);
  never the position; never undefined nor NaN.
- **Caps**: 20 trackers (created ones first, then by id), answers of 1 MB at
  most, lists read up to 2000 entries, 20 s per request, test button 55 s,
  250 states/min by priority (position, presence, battery, speed, last
  seen), badges in calls of 100.
- **Privacy**: no position, tracker name or id, IMEI, e-mail address,
  password or token in a log, an error message or `/data`; positions
  rounded to 6 decimals; 0/0 is no position. `/data` (`paj-gps-state.json`,
  mode 0600): `salt`, `lastAttemptAt`, `pause`, `refused` (HMAC of refused
  credentials only), `scope` (HMAC of the e-mail address), `marks`.
- **Dates**: unix seconds, outside 2000-2100 no date, more than 5 min ahead
  of the clock of Gladys ignored (positions and alerts; the marks read back
  are capped at now + 5 min). Every date shown is UTC; `test/timezone.test.js` runs
  `test/app.test.js` again with TZ=Europe/Lisbon and TZ=Europe/Helsinki.
- **Transport badge**: `cloud` when the last reading worked and the tracker
  is in it, `unreachable` otherwise. `transports: ["cloud"]`.
- `gladys_version >=5.1.0` (scene triggers). Categories `services`,
  `security` (anti-theft). No Bluetooth, no command.
- **Review corrections of `3ba7826`** (review 1):
  - (1) a position is published only when newer than the last one published
    (`marks.f`), or the same one for a tracker this process already
    published; an older point (late upload) never goes, nor moves the
    presence;
  - (2) positions and alerts dated more than 5 min ahead are refused; `f`
    and `a` capped at now + 5 min when read back;
  - (3) the previous "at home" after a restart is the `last_value` of the
    `at_home` feature in `gladys.devices`; a failed `getHouses()` keeps the
    last list and the presence;
  - (4) on the alerts route, a 401 or a 403 (any body) only skips the
    alerts of that tracker for that reading (review 2: the next trackers are
    still read); a token refused again stops the alerts round; only the list of trackers
    and the positions can set the 6 h firewall pause; a 429 there still
    pauses, a login refused while renewing is still final;
  - (5) a configuration saved bumps the generation and closes the client at
    once, before the start queue; `connected` and `start` never await the
    reading (`startReading()`), so a new configuration is applied at once and
    the old reading publishes nothing;
  - (6) a token refused again: `token = null` and the alerts round stops;
  - (7) alerts asked from max(mark, now - 1 h 2 min); beyond 30, the most
    recent fire;
  - (8, 11) docs: a 1 h refresh may miss an alert (choose 30 min or less);
    the password goes in the query (PAJ access logs): use a PAJ password used
    nowhere else;
  - (9) `getHouses()` read at the start of every reading;
  - (10) `deviceUpdated` no longer allows the last position to be sent again
    (only `deviceCreated` does);
  - (12) a 404 on the login: final as before, but its own status ("login
    route not found, the API may have changed"), not "credentials refused".
