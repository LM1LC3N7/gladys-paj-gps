// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the fake PAJ GPS API,
// through the exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PajApp } from '../src/app.js';
import { ACTIONS, LIMITS, PACING, SCENE_TRIGGERS } from '../src/constants.js';
import { buildDevice, trackerKey } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { fileStore, memoryStore } from '../src/store.js';
import {
  EMAIL,
  GOLF,
  PASSWORD,
  REX,
  T0,
  alert,
  createFakePaj,
  device,
  point,
} from './helpers/fakePaj.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const MIN = 60_000;
const HOUR = 3600_000;
const POLL = 300_000;
const SELECTOR = 'paj-gps';
const ids = createFakeGladys({ selector: SELECTOR });
const BASE_CONFIG = { email: EMAIL, password: PASSWORD };
const WRONG = 'not-the-password';
const HOUSES = [
  { id: 'h1', name: 'Home', selector: 'home', latitude: 48.8566, longitude: 2.3522 },
  { id: 'h2', name: 'Cottage', selector: 'cottage', latitude: null, longitude: null },
];
const created = (id, name, options = {}) =>
  buildDevice(ids, { key: trackerKey(id), name, hasBattery: true, hasHome: true, ...options });
const featureId = (id, feature) => `ext:${SELECTOR}:device:${trackerKey(id)}:${feature}`;
const deviceId = (id) => `ext:${SELECTOR}:device:${trackerKey(id)}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));

let running;
afterEach(async () => {
  await running?.shutdown();
  running = undefined;
});

async function setup({
  config = {},
  devices = [created(GOLF, 'Golf'), created(REX, 'Rex', { hasBattery: false })],
  paj,
  store,
  now = T0,
  houses = HOUSES,
} = {}) {
  const clock = { now };
  paj ??= createFakePaj();
  store ??= memoryStore();
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE_CONFIG, ...config },
    devices,
    houses,
  });
  const timers = createFakeTimers();
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.stack ?? String(a)).join(' ')}`),
    ]),
  );
  const app = new PajApp({
    gladys,
    logger,
    request: paj.request,
    store,
    now: () => clock.now,
    monotonic: () => clock.now,
    timers,
  });
  running = app;
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  await settle(app);
  /** `n` minutes pass, the tick runs after each. */
  const minutes = async (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      clock.now += MIN;
      await timers
        .intervals()
        .find((t) => t.ms === PACING.TICK)
        ?.fn();
      await app.reading;
    }
  };
  return { gladys, paj, timers, clock, logs, app, store, minutes };
}

async function settle(app) {
  for (let i = 0; i < 5; i += 1) await tick();
  await app.queue;
  await app.reading;
}

const badges = (gladys) =>
  Object.fromEntries(gladys.fake.transports.map((t) => [t.device_external_id, t.transport]));
const last = (gladys, id, feature) => gladys.fake.lastState(featureId(id, feature));
const stateCount = (gladys, id, feature) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === featureId(id, feature)).length;
/** Emit `connected` again (Gladys came back) and wait. */
async function reconnect(gladys, app) {
  gladys.emit('connected');
  await settle(app);
}

test('start: one login, the trackers, their positions; status, Discovery, values, badges', async () => {
  const { gladys, paj, timers } = await setup();
  assert.deepEqual(paj.paths(), [
    '/api/v1/login',
    '/api/v1/device',
    '/api/v1/trackerdata/getalllastpositions',
  ]);
  const [login] = paj.requests;
  assert.equal(login.method, 'POST');
  assert.equal(new URL(login.url).origin, 'https://connect.paj-gps.de');
  assert.match(login.headers['user-agent'], /^gladys-paj-gps\/\d+\.\d+\.\d+$/);
  assert.equal(paj.requests[1].headers.authorization, 'Bearer tok-1-abcdef');
  assert.deepEqual(JSON.parse(paj.requests[2].body), {
    deviceIDs: [REX, GOLF],
    fromLastPoint: false,
  });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(
    gladys.fake.connectionStatus.message.en,
    'PAJ GPS answers: 2 trackers, read at 08:00 UTC, next reading at 08:05 UTC.',
  );
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name, d.model]),
    [
      [deviceId(GOLF), 'Golf', 'PAJ GPS tracker'],
      [deviceId(REX), 'Rex', 'PAJ GPS tracker'],
    ],
  );
  const [golf, rex] = gladys.fake.discoveredDevices;
  assert.ok(golf.features.some((f) => f.external_id.endsWith(':battery')));
  assert.ok(!rex.features.some((f) => f.external_id.endsWith(':battery')), 'no battery');
  assert.equal(last(gladys, GOLF, 'latitude'), 48.85661);
  assert.equal(last(gladys, GOLF, 'longitude'), 2.35222);
  assert.equal(last(gladys, GOLF, 'speed'), 0);
  assert.equal(last(gladys, GOLF, 'battery'), 58);
  assert.equal(last(gladys, GOLF, 'last_seen'), '2026-10-22 07:59 UTC');
  assert.equal(last(gladys, GOLF, 'at_home'), 1);
  assert.ok(last(gladys, GOLF, 'distance_home') < 5);
  assert.equal(last(gladys, REX, 'at_home'), 0);
  assert.ok(Math.abs(last(gladys, REX, 'distance_home') - 392_000) < 5000, 'Paris - Lyon');
  assert.equal(last(gladys, REX, 'speed'), 12);
  assert.deepEqual(badges(gladys), { [deviceId(GOLF)]: 'cloud', [deviceId(REX)]: 'cloud' });
  assert.equal(timers.intervals().length, 1);
  assert.equal(gladys.fake.sceneEvents.length, 0);
});

test('the credentials go only in the login query, over https, never with a token', async () => {
  const { paj } = await setup();
  const [login, ...rest] = paj.requests;
  const query = new URL(login.url).searchParams;
  assert.equal(query.get('email'), EMAIL);
  assert.equal(query.get('password'), PASSWORD);
  assert.equal(login.headers.authorization, undefined);
  for (const request of rest) {
    assert.ok(
      !request.url.includes(encodeURIComponent(PASSWORD)) && !request.url.includes('password'),
    );
    assert.match(request.url, /^https:\/\/connect\.paj-gps\.de\//);
  }
});

test('pace: nothing before the interval, then one reading with the same token', async () => {
  const { paj, minutes } = await setup();
  const before = paj.requests.length;
  await minutes(4);
  assert.equal(paj.requests.length, before, 'no request before 5 min');
  await minutes(1);
  assert.equal(paj.count('/api/v1/login'), 1, 'the token is reused');
  assert.equal(paj.count('/api/v1/device'), 2);
  // The alerts of the created trackers: the first reading only took the baseline.
  assert.equal(paj.count('/api/v1/customnotifications/'), 2);
});

test('a restart, a reconnection, an unchanged configuration, the test button: never sooner', async () => {
  const store = memoryStore();
  const first = await setup({ store });
  const before = first.paj.requests.length;
  await reconnect(first.gladys, first.app);
  assert.equal(first.paj.requests.length, before, 'reconnection');
  await first.gladys.fake.configUpdated({ ...BASE_CONFIG });
  assert.equal(first.paj.requests.length, before, 'unchanged configuration');
  const ack = await first.gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.en, /^Not read again/);
  await first.gladys.fake.scanRequest();
  assert.equal(first.paj.requests.length, before, 'test button and Discovery');
  await running.shutdown();
  // A restart 2 minutes later: the time of the attempt is in /data.
  const second = await setup({ store, paj: first.paj, now: T0 + 2 * MIN });
  assert.equal(first.paj.requests.length, before, 'restart');
  assert.match(
    second.gladys.fake.connectionStatus.message.en,
    /Waiting for the next reading at 08:05/,
  );
  await second.minutes(3);
  assert.ok(first.paj.requests.length > before, 'read at 08:05');
});

test('the status and Discovery are sent again at every connection to Gladys', async () => {
  const { gladys, app } = await setup();
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  await reconnect(gladys, app);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, discoveries + 1);
});

test('a restart never republishes an old position as new; a newer one goes', async () => {
  const store = memoryStore();
  const first = await setup({ store });
  const paj = first.paj;
  await running.shutdown();
  const second = await setup({ store, paj, now: T0 + 10 * MIN });
  await second.minutes(1);
  assert.equal(stateCount(second.gladys, GOLF, 'latitude'), 0, 'same fix: nothing');
  paj.points[GOLF] = point(GOLF, { lat: 48.9, at: T0 + 10 * MIN });
  await second.minutes(5);
  assert.equal(last(second.gladys, GOLF, 'latitude'), 48.9);
  assert.equal(last(second.gladys, GOLF, 'at_home'), 0);
  assert.equal(stateCount(second.gladys, REX, 'latitude'), 0, 'Rex did not move');
});

test('refused credentials: final, persisted, never retried by themselves', async () => {
  const store = memoryStore();
  const { gladys, paj, minutes, clock } = await setup({ store, config: { password: WRONG } });
  assert.deepEqual(paj.paths(), ['/api/v1/login']);
  assert.equal(paj.count('/api/v1/login'), 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /refused the e-mail address or the password \(HTTP 401\)/,
  );
  assert.match(gladys.fake.connectionStatus.message.fr, /a refusé l’adresse e-mail/);
  assert.ok(Object.values(badges(gladys)).every((t) => t === 'unreachable'));
  await minutes(24 * 60);
  assert.equal(paj.count('/api/v1/login'), 1, 'never again by itself');
  assert.ok(store.data.refused, 'kept in /data');
  // A restart: still nothing.
  await running.shutdown();
  const second = await setup({ store, paj, config: { password: WRONG }, now: clock.now });
  assert.equal(paj.count('/api/v1/login'), 1);
  assert.match(second.gladys.fake.connectionStatus.message.en, /nothing more is sent/);
  // The test button: one try (the interval has passed), refused again.
  let ack = await second.gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, false);
  assert.equal(paj.count('/api/v1/login'), 2);
  ack = await second.gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, false);
  assert.equal(paj.count('/api/v1/login'), 2, 'not twice within the interval');
  // The right password, saved: at once, and the refusal is forgotten.
  await second.gladys.fake.configUpdated({ ...BASE_CONFIG });
  await settle(second.app);
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.refused, null, 'no fingerprint of credentials that work');
});

test('the test button after a refusal erases it only when the login works', async () => {
  const store = memoryStore();
  const { gladys, paj, clock } = await setup({ store });
  paj.password = 'changed-elsewhere';
  paj.refuseRefresh = true;
  paj.expire();
  clock.now += POLL;
  await running.tick();
  await running.reading;
  assert.match(gladys.fake.connectionStatus.message.en, /refused the e-mail address/);
  assert.equal(paj.count('/api/v1/updatetoken'), 1, 'the refresh token first');
  // The password is set back at PAJ: the test button (spaced) works and erases the refusal.
  paj.password = PASSWORD;
  clock.now += POLL;
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, true, ack.error);
  assert.equal(store.data.refused, null);
});

test('an expired token is renewed once with the refresh token, never in a loop', async () => {
  const { gladys, paj, minutes } = await setup();
  paj.expire();
  await minutes(5);
  assert.equal(paj.count('/api/v1/updatetoken'), 1);
  assert.equal(paj.count('/api/v1/login'), 1, 'no new login');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  // The refresh token refused too: one login.
  paj.expire();
  paj.refuseRefresh = true;
  await minutes(5);
  assert.equal(paj.count('/api/v1/updatetoken'), 2);
  assert.equal(paj.count('/api/v1/login'), 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  // Every token refused, even new ones: one renewal, then the reading fails (no loop).
  paj.refuseAllTokens = true;
  const before = paj.requests.length;
  await minutes(5);
  assert.equal(paj.requests.length - before, 4, 'device, updatetoken, login, device');
  assert.match(gladys.fake.connectionStatus.message.en, /new session was refused again/);
  await minutes(4);
  assert.equal(paj.requests.length - before, 4, 'retried at the interval only');
});

test('HTTP 429: a bounded pause of every path, kept across a restart; the button never lifts it', async () => {
  const store = memoryStore();
  const paj = createFakePaj();
  paj.failures.push({
    status: 429,
    path: '/api/v1/device',
    headers: { 'retry-after': '99999999' },
  });
  const { gladys, minutes } = await setup({ paj, store });
  assert.match(gladys.fake.connectionStatus.message.en, /asked Gladys to wait \(HTTP 429\).*6 h/);
  assert.equal(store.data.pause.until, T0 + PACING.PAUSE_MAX, 'capped at 6 h');
  const before = paj.requests.length;
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, false);
  await minutes(60);
  assert.equal(paj.requests.length, before);
  await running.shutdown();
  const second = await setup({ paj, store, now: T0 + 2 * HOUR });
  assert.equal(paj.requests.length, before, 'nor a restart');
  assert.match(second.gladys.fake.connectionStatus.message.en, /4 h/);
  second.clock.now = T0 + 6 * HOUR - MIN;
  await second.minutes(1);
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.pause, null, 'forgotten after a reading that works');
});

test('HTTP 503 without Retry-After pauses; a 403 page of a firewall pauses 6 h', async () => {
  const paj = createFakePaj();
  paj.failures.push({ status: 503, path: '/api/v1/device' });
  const { gladys, store } = await setup({ paj });
  assert.match(gladys.fake.connectionStatus.message.en, /HTTP 503/);
  assert.equal(store.data.pause.until, T0 + PACING.PAUSE_DEFAULT);
  await running.shutdown();
  const firewall = createFakePaj();
  firewall.failures.push({ status: 403, body: '<html>Forbidden</html>', path: '/api/v1/device' });
  const second = await setup({ paj: firewall });
  assert.match(second.gladys.fake.connectionStatus.message.en, /Not about the credentials/);
  assert.equal(second.store.data.pause.until, T0 + PACING.PAUSE_MAX);
  assert.equal(second.store.data.refused, null);
});

test('a network failure is retried at the interval only, even after a reconnection', async () => {
  const { gladys, paj, app, minutes } = await setup();
  paj.unreachable = true;
  await minutes(5);
  assert.match(gladys.fake.connectionStatus.message.en, /no connection. Next try at 08:10 UTC/);
  const before = paj.requests.length;
  await reconnect(gladys, app);
  await minutes(4);
  assert.equal(paj.requests.length, before);
  paj.unreachable = false;
  await minutes(1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('alerts: the first reading takes a baseline; a new SOS fires once; old ones never', async () => {
  const store = memoryStore();
  const { gladys, paj, minutes, clock } = await setup({ store });
  paj.alerts[GOLF] = [
    alert(1, GOLF, 4, T0 + 2 * MIN),
    alert(2, GOLF, 1, T0 + 3 * MIN),
    alert(3, GOLF, 2, T0 - 10 * MIN, { note: 'before the baseline' }),
  ];
  paj.alerts[REX] = [alert(4, REX, 77, T0 + 4 * MIN)];
  await minutes(5);
  assert.deepEqual(
    gladys.fake.sceneEvents.map((e) => [e.key, e.data.device_name, e.data.alert_type]),
    [
      [SCENE_TRIGGERS.TRACKER_ALERT, 'Golf', 'sos'],
      [SCENE_TRIGGERS.TRACKER_ALERT, 'Golf', 'shock'],
      [SCENE_TRIGGERS.TRACKER_ALERT, 'Rex', 'other'],
    ],
  );
  assert.deepEqual(gladys.fake.sceneEvents[0].data, {
    device: deviceId(GOLF),
    alert_type: 'sos',
    device_name: 'Golf',
    at: '2026-10-22 08:02 UTC',
  });
  for (const event of gladys.fake.sceneEvents) {
    for (const value of Object.values(event.data)) {
      assert.ok(value !== undefined && !Number.isNaN(value));
    }
  }
  await minutes(5);
  assert.equal(gladys.fake.sceneEvents.length, 3, 'not twice');
  // A second alert in the same second as the last one seen still fires.
  paj.alerts[GOLF].push(alert(5, GOLF, 10, T0 + 3 * MIN));
  await minutes(5);
  assert.equal(gladys.fake.sceneEvents.length, 4);
  assert.equal(gladys.fake.sceneEvents[3].data.alert_type, 'area_enter');
  // A restart: nothing again; an alert of more than an hour ago is recorded, not fired.
  await running.shutdown();
  const second = await setup({ store, paj, now: clock.now + 3 * HOUR });
  paj.alerts[GOLF].push(alert(6, GOLF, 4, clock.now + HOUR));
  await second.minutes(1);
  assert.equal(second.gladys.fake.sceneEvents.length, 0);
});

test('alerts: only the created trackers; a 5xx skips them, a 429 pauses after the states', async () => {
  const paj = createFakePaj();
  const { gladys, minutes, store } = await setup({ paj, devices: [created(GOLF, 'Golf')] });
  await minutes(5);
  assert.deepEqual(
    paj.requests.filter((r) => r.path.includes('customnotifications')).map((r) => r.path),
    [`/api/v1/customnotifications/${GOLF}`],
  );
  paj.failures.push({ status: 500, path: '/api/v1/customnotifications/' });
  await minutes(5);
  assert.equal(gladys.fake.connectionStatus.connected, true, 'a secondary 5xx stops nothing');
  assert.equal(store.data.pause, null);
  paj.points[GOLF] = point(GOLF, { lat: 48.7, at: T0 + 14 * MIN });
  paj.failures.push({
    status: 429,
    path: '/api/v1/customnotifications/',
    headers: { 'retry-after': '600' },
  });
  await minutes(5);
  assert.equal(last(gladys, GOLF, 'latitude'), 48.7, 'the states first');
  assert.match(gladys.fake.connectionStatus.message.en, /HTTP 429/);
  assert.ok(store.data.pause.until > T0);
});

test('presence: a margin against jitter; no located house, no home features', async () => {
  const { gladys, paj, minutes } = await setup();
  // 250 m away: beyond 200 m but within the margin (300 m): still at home.
  paj.points[GOLF] = point(GOLF, { lat: 48.85885, at: T0 + 4 * MIN });
  await minutes(5);
  assert.ok(last(gladys, GOLF, 'distance_home') > 200);
  assert.equal(last(gladys, GOLF, 'at_home'), 1);
  paj.points[GOLF] = point(GOLF, { lat: 48.8616, at: T0 + 9 * MIN });
  await minutes(5);
  assert.equal(last(gladys, GOLF, 'at_home'), 0, 'beyond 300 m: away');
  await running.shutdown();
  const none = await setup({ houses: [], devices: [] });
  assert.ok(
    none.gladys.fake.discoveredDevices.every(
      (d) => !d.features.some((f) => /:(distance_home|at_home)$/.test(f.external_id)),
    ),
  );
  assert.match(none.gladys.fake.connectionStatus.message.en, /No house of Gladys has a position/);
});

test('privacy: no credentials, token, position, name nor id in the logs or /data', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'paj-gps-'));
  const store = fileStore(dataDir);
  const paj = createFakePaj();
  paj.alerts[GOLF] = [alert(987654321, GOLF, 4, T0 + 2 * MIN)];
  const { gladys, logs, minutes } = await setup({ store, paj, config: { password: WRONG } });
  await gladys.fake.configUpdated({ ...BASE_CONFIG });
  await settle(running);
  await minutes(5);
  paj.failures.push({ status: 503 });
  await minutes(5);
  const written = readdirSync(dataDir)
    .map((file) => readFileSync(join(dataDir, file), 'utf8'))
    .join('\n');
  assert.ok(written.includes('lastAttemptAt'), 'the file is written');
  for (const secret of [
    EMAIL,
    'someone',
    PASSWORD,
    WRONG,
    'tok-',
    'ref-',
    '48.85',
    '2.35',
    '45.76',
    '4.83',
    '50.79',
    'Golf',
    'Rex',
    String(GOLF),
    String(REX),
    '987654321',
    '867530900000001',
  ]) {
    assert.ok(!logs.some((l) => l.includes(secret)), `log: ${secret}`);
    assert.ok(!written.includes(secret), `/data: ${secret}`);
  }
  const published = JSON.stringify(gladys.fake.discoveredDevices);
  assert.ok(!published.includes(String(GOLF)) && !published.includes('867530900000001'));
});

test('a late answer of a former configuration publishes nothing and sets no status', async () => {
  const paj = createFakePaj();
  const { gladys, app, clock } = await setup({ paj });
  let release;
  paj.gate = new Promise((resolve) => (release = resolve));
  clock.now += POLL;
  const reading = app.tick();
  for (let i = 0; i < 10; i += 1) await tick();
  const statuses = gladys.fake.connectionStatuses.length;
  paj.devices = [device(GOLF, 'Renamed')];
  await gladys.fake.configUpdated({ ...BASE_CONFIG, home_radius: '500' });
  const afterConfig = gladys.fake.connectionStatuses.length;
  release();
  paj.gate = null;
  await reading;
  await settle(app);
  assert.ok(afterConfig >= statuses);
  assert.ok(
    !gladys.fake.discoveredDevices.some((d) => d.name === 'Renamed'),
    'the old reading published nothing',
  );
});

test('a published device never loses a feature of the created one', async () => {
  const golf = created(GOLF, 'Golf');
  golf.features.push({ ...golf.features[0], external_id: `${golf.external_id}:old_feature` });
  const { gladys } = await setup({ devices: [golf], houses: [] });
  const published = gladys.fake.discoveredDevices.find((d) => d.name === 'Golf');
  const kept = published.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(kept.includes('old_feature'));
  assert.ok(kept.includes('at_home'), 'kept although no house has a position now');
});

test('the cap of 20 keeps the created trackers first', async () => {
  const paj = createFakePaj();
  paj.devices = [];
  paj.points = {};
  for (let i = 0; i < 25; i += 1) {
    const id = 100 + i;
    paj.devices.push(device(id, `T${String(i).padStart(2, '0')}`));
    paj.points[id] = point(id);
  }
  const { gladys } = await setup({ paj, devices: [created(124, 'T24')] });
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /25 trackers.*5 more trackers are left out/,
  );
  assert.equal(last(gladys, 124, 'latitude'), 48.85661, 'created: followed beyond the 20th');
  const names = gladys.fake.discoveredDevices.map((d) => d.name);
  assert.equal(names.length, LIMITS.DEVICES);
  assert.ok(names.includes('T24') && !names.includes('T19'));
  assert.equal(JSON.parse(paj.requests.at(-1).body).deviceIDs.length, LIMITS.DEVICES);
});

test('read only: every command is refused, nothing reaches PAJ', async () => {
  const { gladys, paj } = await setup();
  const golf = created(GOLF, 'Golf');
  const before = paj.requests.length;
  for (const feature of golf.features) {
    const ack = await gladys.fake.setValue(golf, feature, 0);
    assert.equal(ack.success, false);
    assert.match(ack.error, /only reads PAJ GPS/);
  }
  assert.equal(paj.requests.length, before);
});

test('configuration errors: said, nothing sent', async () => {
  const cases = [
    [{ email: '' }, /Type the e-mail address and the password/],
    [{ password: '' }, /Type the e-mail address and the password/],
    [{ email: 'not-an-address' }, /is not one/],
    [{ password: 'pass\u0007word' }, /control character/],
  ];
  for (const [config, message] of cases) {
    const { gladys, paj } = await setup({ config });
    assert.equal(gladys.fake.connectionStatus.connected, false);
    assert.match(gladys.fake.connectionStatus.message.en, message);
    assert.equal(paj.requests.length, 0);
    await running.shutdown();
  }
});

test('a tracker without a name, a deleted one, an empty account', async () => {
  const paj = createFakePaj();
  paj.devices = [
    device(GOLF, '  '),
    device(REX, 'Rex', { deleted_at: '2026-10-01 10:00:00' }),
    { name: 'no id' },
  ];
  const { gladys, minutes } = await setup({ paj, devices: [] });
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.name),
    [`PAJ GPS ${trackerKey(GOLF).slice(0, 4)}`],
  );
  paj.devices = [];
  await minutes(5);
  assert.match(gladys.fake.connectionStatus.message.en, /has no tracker/);
});

test('a device created later gets its current values at once', async () => {
  const { gladys } = await setup({ devices: [] });
  assert.equal(last(gladys, GOLF, 'latitude'), undefined);
  await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
  await settle(running);
  assert.equal(last(gladys, GOLF, 'latitude'), 48.85661);
});

test('the time of the attempt goes to /data before the request, at most once a minute', async () => {
  const store = memoryStore();
  const paj = createFakePaj();
  let seenAtRequest = null;
  const original = paj.request;
  paj.request = async (url, options) => {
    seenAtRequest ??= store.data?.lastAttemptAt ?? null;
    return original(url, options);
  };
  await setup({ store, paj });
  assert.equal(seenAtRequest, T0);
});

test('Gladys does not give the configuration: said, asked again, nothing sent', async () => {
  const paj = createFakePaj();
  const gladys = createFakeGladys({ selector: SELECTOR, config: BASE_CONFIG, houses: HOUSES });
  const timers = createFakeTimers();
  const app = new PajApp({
    gladys,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    request: paj.request,
    store: memoryStore(),
    now: () => T0,
    timers,
  });
  running = app;
  const getConfig = gladys.getConfig.bind(gladys);
  // The SDK reads an empty configuration when it connects; the handler's read fails.
  let calls = 0;
  gladys.getConfig = async () => {
    calls += 1;
    if (calls === 1) return {};
    throw new Error('unavailable');
  };
  registerHandlers(gladys, app);
  await gladys.connect();
  await settle(app);
  assert.match(gladys.fake.connectionStatus.message.en, /did not give the configuration/);
  assert.equal(paj.requests.length, 0);
  const retry = timers.timeouts().find((t) => t.ms === PACING.CONFIG_RETRY);
  assert.ok(retry, 'asked again later');
  gladys.getConfig = getConfig;
  await timers.runTimeouts();
  await settle(app);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('the state budget holds with two publications at the same time', async () => {
  const paj = createFakePaj();
  paj.devices = [];
  paj.points = {};
  const devices = [];
  for (let i = 0; i < 20; i += 1) {
    const id = 100 + i;
    paj.devices.push(device(id, `T${String(i).padStart(2, '0')}`));
    paj.points[id] = point(id, { lat: 45 + i / 100 });
    devices.push(created(id, `T${i}`));
  }
  const { gladys, app, clock } = await setup({ paj, devices });
  const first = gladys.fake.states.length;
  assert.ok(first <= LIMITS.STATES_PER_MINUTE);
  clock.now += 2 * MIN;
  for (const tracker of app.trackers.values()) {
    tracker.point = { ...tracker.point, lat: tracker.point.lat + 0.5, speed: 50, atMs: clock.now };
  }
  await Promise.all([app.publishStates(), app.publishStates()]);
  assert.ok(gladys.fake.states.length - first <= LIMITS.STATES_PER_MINUTE);
});
