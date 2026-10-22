// -----------------------------------------------------------------------------
// The answers of the API -> plain objects; the distance to home and the
// presence; the configuration; the persistent state, bounded.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, configFingerprint, isComplete, normalizeConfig } from '../src/config.js';
import { LIMITS, PACING } from '../src/constants.js';
import { distanceHome, distanceMeters, housesOf, presence } from '../src/geo.js';
import { dateOf, formatDate, parseAlerts, parseDevices, parsePositions } from '../src/paj/parse.js';
import { normalizeMemory, serializeMemory } from '../src/store.js';

const T0 = Date.parse('2026-10-22T08:00:00Z');

test('devices: ids, names, battery; never the IMEI; deleted ones and junk skipped', () => {
  const devices = parseDevices({
    success: [
      { id: 9, name: ' Golf\n', imei: '867', device_models: [{ standalone_battery: 1 }] },
      { id: '3', name: 'Car', device_models: '{}' },
      { id: 4, name: 'Old', deleted_at: '2026-01-01' },
      { id: -1 },
      { id: 9, name: 'duplicate' },
      null,
      'x',
    ],
  });
  assert.deepEqual(devices, [
    { id: 3, name: 'Car', hasBattery: false },
    { id: 9, name: 'Golf', hasBattery: true },
  ]);
  assert.equal(parseDevices({ error: 'x' }), null);
  assert.equal(parseDevices([]), null);
});

test('a list is read up to its cap, linearly', () => {
  const success = Array.from({ length: LIMITS.ENTRIES + 500 }, (_, i) => ({ id: i + 1 }));
  assert.equal(parseDevices({ success }).length, LIMITS.ENTRIES);
});

test('positions: the newest dated point per tracker, both coordinates, no 0/0, no future', () => {
  const at = Math.floor(T0 / 1000);
  const points = parsePositions(
    {
      success: [
        { iddevice: 1, lat: 48.1234567, lng: 2.1, dateunix: at - 60, speed: '12.34', battery: 80 },
        { iddevice: 1, lat: 48.2, lng: 2.2, dateunix: at - 600 },
        { iddevice: 1, lat: 10, lng: 10, dateunix: at + 10 * 86_400 },
        { iddevice: 2, lat: 0, lng: 0, dateunix: at },
        { iddevice: 3, lat: 91, lng: 2, dateunix: at },
        { iddevice: 4, lat: 45, lng: 4, dateunix: at, battery_level: 33, speed: -5 },
        { iddevice: 5, lat: 45, lng: 4 },
      ],
    },
    T0 + PACING.FUTURE,
  );
  assert.deepEqual([...points.keys()], [1, 4]);
  assert.deepEqual(points.get(1), {
    lat: 48.123457,
    lon: 2.1,
    atMs: T0 - 60_000,
    speed: 12.3,
    battery: 80,
  });
  assert.equal(points.get(4).battery, 33);
  assert.equal(points.get(4).speed, null);
});

test('alerts: id, type, date; never the position; sorted', () => {
  const at = Math.floor(T0 / 1000);
  const alerts = parseAlerts({
    success: [
      { id: 2, meldungtyp: 4, dateunix: at, lat: 50.1, lng: 7.6 },
      { id: 1, meldungtyp: '1', dateunix: at - 5 },
      { id: 3, meldungtyp: 1.5, dateunix: at },
      { id: 4, dateunix: at },
    ],
  });
  assert.deepEqual(alerts, [
    { id: 1, type: 1, atMs: T0 - 5000 },
    { id: 2, type: 4, atMs: T0 },
  ]);
  assert.ok(!JSON.stringify(alerts).includes('50.1'));
});

test('dates', () => {
  assert.equal(dateOf(1770996250), 1770996250000);
  assert.equal(dateOf('1770996250'), 1770996250000);
  assert.equal(dateOf(0), null);
  assert.equal(dateOf(9_999_999_999), null);
  assert.equal(dateOf('x'), null);
  assert.equal(formatDate(T0), '2026-10-22 08:00 UTC');
  assert.equal(formatDate(null), null);
});

test('distance and presence with a margin', () => {
  const paris = { lat: 48.8566, lon: 2.3522 };
  const lyon = { lat: 45.764, lon: 4.8357 };
  assert.ok(Math.abs(distanceMeters(paris, lyon) - 392_000) < 3000);
  assert.equal(distanceHome(paris, [lyon, paris]), 0, 'the nearest house');
  assert.equal(distanceHome(paris, []), null);
  assert.equal(distanceHome(null, [paris]), null);
  assert.equal(presence(150, 200), 1);
  assert.equal(presence(250, 200, 1), 1, 'within the margin: stays');
  assert.equal(presence(250, 200, 0), 0);
  assert.equal(presence(250, 200), 0);
  assert.equal(presence(301, 200, 1), 0);
  assert.equal(presence(1400, 1000, 1), 1, 'margin of half the radius');
  assert.equal(presence(null, 200, 1), null);
  assert.deepEqual(
    housesOf([
      { latitude: 48.8, longitude: 2.3, name: 'Home' },
      { latitude: null, longitude: null },
      { latitude: '91', longitude: 2 },
      { latitude: 0, longitude: 0 },
    ]),
    [{ lat: 48.8, lon: 2.3 }],
  );
  assert.deepEqual(housesOf(undefined), []);
});

test('configuration: defaults, choices outside the list, credentials', () => {
  const config = normalizeConfig();
  assert.equal(config.pollSeconds, Number(DEFAULTS.poll_interval));
  assert.equal(config.homeRadius, Number(DEFAULTS.home_radius));
  assert.equal(normalizeConfig({ poll_interval: '10' }).pollSeconds, 300, 'never under 5 min');
  assert.equal(normalizeConfig({ poll_interval: 600 }).pollSeconds, 600);
  assert.equal(normalizeConfig({ home_radius: '1000' }).homeRadius, 1000);
  assert.equal(normalizeConfig(null).pollSeconds, 300);
  const credentials = normalizeConfig({ email: ' me@example.org ', password: ' pass word \n' });
  assert.equal(credentials.email, 'me@example.org');
  assert.equal(credentials.password, ' pass word ');
  assert.equal(isComplete(credentials), true);
  assert.equal(normalizeConfig({ email: 'me' }).emailInvalid, true);
  assert.equal(normalizeConfig({ email: 'a\n@b' }).emailInvalid, true);
  assert.equal(normalizeConfig({ password: 'a\tb' }).passwordInvalid, true);
  assert.equal(normalizeConfig({ password: 42 }).password, '');
  assert.equal(
    configFingerprint({ email: 'a@b', password: 'x' }),
    configFingerprint({ password: 'x', email: 'a@b', other: 1 }),
  );
  assert.notEqual(
    configFingerprint({ email: 'a@b', password: 'x' }),
    configFingerprint({ email: 'a@b', password: 'y' }),
  );
});

test('the persistent state: repaired, bounded, no prototype pollution', () => {
  const text = `{
    "salt": "not hex",
    "lastAttemptAt": ${T0 + 3600_000},
    "pause": { "until": ${T0 + 100 * 3600_000}, "reason": "weird" },
    "refused": { "hash": "short" },
    "__proto__": { "polluted": true },
    "marks": {
      "${'a'.repeat(32)}": { "f": 1, "a": "x", "i": ["0123456789abcdef", "bad"] },
      "bad": { "f": 1 },
      "__proto__": { "polluted": true }
    }
  }`;
  const memory = normalizeMemory(JSON.parse(text), T0);
  assert.match(memory.salt, /^[0-9a-f]{64}$/);
  assert.equal(memory.lastAttemptAt, T0, 'a future attempt counts as now');
  assert.equal(memory.pause.until, T0 + PACING.PAUSE_MAX);
  assert.equal(memory.pause.reason, 'busy');
  assert.equal(memory.refused, null);
  assert.deepEqual([...memory.marks.keys()], ['a'.repeat(32)]);
  assert.deepEqual(memory.marks.get('a'.repeat(32)), { f: 1, a: null, i: ['0123456789abcdef'] });
  assert.equal({}.polluted, undefined);
  const again = normalizeMemory(serializeMemory(memory), T0);
  assert.equal(again.salt, memory.salt);
  assert.deepEqual(again.marks, memory.marks);
});
