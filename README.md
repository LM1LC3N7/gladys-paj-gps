# gladys-paj-gps

A [Gladys Assistant](https://gladysassistant.com) external integration for
**PAJ GPS** trackers: position, speed, battery, last seen, distance to home
and "at home" of each tracker, and the alerts of the trackers (SOS, shock, low
battery, zone...) as a scene trigger. Read only, through the cloud of PAJ GPS
(connect.paj-gps.de), with the e-mail address and password of the PAJ
account.

**Never tested with a real tracker nor account.** Unofficial, not affiliated
with PAJ.

- User documentation: [English](docs/en.md) · [Français](docs/fr.md)
- Reference: [pajgps-api](https://github.com/Skipperro/pajgps-api) 0.4.1 (MIT),
  ported to JavaScript (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md))
- Status, decisions and what comes next: [TODO.md](TODO.md)

## Highlights

- One device per tracker (Discovery tab), never a switch: every feature is
  read only.
- Distance to the nearest house of Gladys that has a position
  (`location: true`), "at home" within a radius with a margin.
- Gentle with the API: one reading per interval (5 minutes at least), never
  sooner after a restart, a reconnection or a click; refused credentials are
  never tried again by themselves; 429 and 5xx pause every request.
- Privacy: no position, tracker name or id, e-mail address, password or token
  in the logs or in `/data` (salted fingerprints and dates only).

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
npm run cover        # regenerate cover.png
```

Node.js 22 or later. The only runtime dependency is
`@gladysassistant/integration-sdk`. See [CLAUDE.md](CLAUDE.md) for the
architecture and the rules.

## License

Apache License 2.0 ([LICENSE](LICENSE)); the MIT notice of pajgps-api is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
