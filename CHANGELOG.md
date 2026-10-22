# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version, never tested with a real PAJ GPS tracker nor account: the
  PAJ GPS trackers of one account, read through connect.paj-gps.de (the
  documented API of PAJ, as pajgps-api uses it). Read only.
- One Gladys device per tracker (20 at most): latitude, longitude, speed,
  battery (trackers with their own battery), last seen and, once a house of
  Gladys has a position, distance to home and at home (with a margin against
  the jitter of a position). Positions, speed and presence keep no history by
  default.
- Scene trigger "PAJ GPS alert": SOS, shock, low battery, zone and the other
  alerts PAJ records for a tracker created in Gladys, filtered by tracker and
  type; only the alerts of the last hour, none before the first reading.
- Refresh every 5 minutes to every hour; "at home" radius of 100 m to 1 km.
- The password kept by Gladys and never shown again, never logged; refused
  credentials stop every request until they change (or one try of the test
  button, never sooner than the interval); a token refused is renewed once
  per reading; HTTP 429 and 5xx pause every request, bounded and kept in
  `/data`; the time of the last attempt kept in `/data` (no faster reading
  after a restart, a reconnection or a click).
- No position, name, tracker id, e-mail address, password or token in the
  logs or in `/data`; an old position never republished as new after a
  restart.
- Button "Test the connection".

### Changed (review before the first release)

- A position older than the one shown, or dated more than 5 minutes ahead,
  is never published; an alert dated in the future never fires.
- "At home" survives a restart within the margin (the value Gladys keeps);
  a house given a position later counts at the next reading.
- A refusal on the alerts of one tracker only skips them for that reading
  (no 6 h pause); a token refused again stops the alerts round.
- A configuration saved during a slow reading is applied at once; the old
  reading publishes nothing.
- Beyond 30 alerts in a reading, the most recent ones fire.
- Updating a device in Gladys no longer sends an old position again.
- A login route not found (HTTP 404) has its own status, not "credentials
  refused".
- Docs: a 1 h refresh may miss an alert; use a PAJ password used nowhere
  else (it goes in the query of the login, as the API asks).

[Unreleased]: https://github.com/LM1LC3N7/gladys-paj-gps/commits/main
