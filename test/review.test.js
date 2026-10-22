// -----------------------------------------------------------------------------
// The scenarios of review 1 (S1 to S12), inverted: each test passes only when
// the defect found by the review is gone.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PajApp } from '../src/app.js';
import { LIMITS, PACING } from '../src/constants.js';
import { buildDevice, trackerKey } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { EMAIL, GOLF, PASSWORD, REX, T0, alert, createFakePaj, point } from './helpers/fakePaj.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const MIN = 60_000;
const HOUR = 3600_000;
const SELECTOR = 'paj-gps';
const ids = createFakeGladys({ selector: SELECTOR });
const HOUSES = [{ id: 'h1', name: 'Home', selector: 'home', latitude: 48.8566, longitude: 2.3522 }];
const created = (id, name, options = {}) =>
  buildDevice(ids, { key: trackerKey(id), name, hasBattery: true, hasHome: true, ...options });
const featureId = (id, feature) => `ext:${SELECTOR}:device:${trackerKey(id)}:${feature}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));

let running;
afterEach(async () => {
  await running?.shutdown();
  running = undefined;
});

async function settle(app) {
  for (let i = 0; i < 5; i += 1) await tick();
  await app.queue;
  await app.reading;
}

async function setup({ config = {}, paj, store, now = T0, devices, houses = HOUSES, wait = true }) {
  const clock = { now };
  paj ??= createFakePaj();
  store ??= memoryStore();
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { email: EMAIL, password: PASSWORD, ...config },
    devices: devices ?? [created(GOLF, 'Golf'), created(REX, 'Rex', { hasBattery: false })],
    houses,
  });
  const timers = createFakeTimers();
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
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
  const connecting = gladys.connect();
  if (wait) {
    await connecting;
    await settle(app);
  }
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
  return { gladys, paj, timers, clock, app, store, minutes, connecting };
}

const last = (gladys, id, f) => gladys.fake.lastState(featureId(id, f));

test('S1: an older position than the one published is never published', async () => {
  const paj = createFakePaj();
  paj.points[GOLF] = point(GOLF, { lat: 48.9, lng: 2.4, at: T0 - MIN });
  const { gladys, minutes } = await setup({ paj });
  assert.equal(last(gladys, GOLF, 'latitude'), 48.9);
  paj.points[GOLF] = point(GOLF, { lat: 47.0, lng: 1.0, at: T0 - 2 * HOUR });
  await minutes(5);
  assert.equal(last(gladys, GOLF, 'latitude'), 48.9);
  assert.equal(last(gladys, GOLF, 'last_seen'), '2026-10-22 07:59 UTC');
  // A newer one goes.
  paj.points[GOLF] = point(GOLF, { lat: 48.95, lng: 2.4, at: T0 + 4 * MIN });
  await minutes(5);
  assert.equal(last(gladys, GOLF, 'latitude'), 48.95);
});

test('S2: a point dated in the future is refused; the marks are bounded after a restart', async () => {
  const paj = createFakePaj();
  const store = memoryStore();
  paj.points[GOLF] = point(GOLF, { lat: 48.9, lng: 2.4, at: T0 + 20 * HOUR });
  const first = await setup({ paj, store });
  assert.equal(last(first.gladys, GOLF, 'latitude'), undefined, 'never published');
  await first.app.shutdown();
  paj.points[GOLF] = point(GOLF, { lat: 45.0, lng: 3.0, at: T0 + 9 * MIN });
  const second = await setup({ paj, store, now: T0 + 10 * MIN });
  await second.minutes(5);
  assert.equal(last(second.gladys, GOLF, 'latitude'), 45.0, 'the real point goes');
  // A mark written in the future (an older version, a file by hand) is capped when read back.
  await second.app.shutdown();
  for (const mark of Object.values(store.data.marks)) mark.f = Math.floor(T0 / 1000) + 20 * 3600;
  const third = await setup({ paj, store, now: T0 + 30 * MIN });
  // Capped at the restart + 5 min (T0 + 35 min): a real point after that goes.
  await third.minutes(9);
  paj.points[GOLF] = point(GOLF, { lat: 44.0, lng: 3.0, at: T0 + 38 * MIN });
  await third.minutes(6);
  assert.equal(last(third.gladys, GOLF, 'latitude'), 44.0);
});

test('S2: an alert dated in the future never fires nor moves the mark', async () => {
  const paj = createFakePaj();
  const { gladys, minutes, clock } = await setup({ paj });
  await minutes(5); // the first alerts round only marks
  paj.alerts[GOLF] = [alert(1, GOLF, 4, clock.now + 10 * HOUR)];
  await minutes(5);
  assert.equal(gladys.fake.sceneEvents.length, 0);
  paj.alerts[GOLF] = [alert(2, GOLF, 4, clock.now + MIN)];
  await minutes(5);
  assert.deepEqual(
    gladys.fake.sceneEvents.map((e) => e.data.alert_type),
    ['sos'],
    'a real SOS after it still fires',
  );
});

test('S3: a restart within the margin keeps "at home" (the value Gladys keeps)', async () => {
  const paj = createFakePaj();
  const store = memoryStore();
  paj.points[GOLF] = point(GOLF, { lat: 48.85795, lng: 2.3522, at: T0 - MIN });
  const first = await setup({ paj, store });
  assert.equal(last(first.gladys, GOLF, 'at_home'), 1);
  await first.app.shutdown();
  // Gladys kept at_home = 1; a newer fix at ~260 m (within radius + margin).
  const golf = created(GOLF, 'Golf');
  for (const feature of golf.features) {
    if (feature.external_id.endsWith(':at_home')) feature.last_value = 1;
  }
  paj.points[GOLF] = point(GOLF, { lat: 48.85894, lng: 2.3522, at: T0 + 8 * MIN });
  const second = await setup({
    paj,
    store,
    now: T0 + 9 * MIN,
    devices: [golf, created(REX, 'Rex', { hasBattery: false })],
  });
  await second.minutes(6);
  assert.ok(last(second.gladys, GOLF, 'distance_home') > 200);
  assert.equal(last(second.gladys, GOLF, 'at_home'), 1);
});

test('S4: a 403 or a 401 on the alerts of one tracker only skips the alerts', async () => {
  const paj = createFakePaj();
  const { app, gladys, minutes } = await setup({ paj });
  await minutes(5);
  paj.failures.push({
    status: 403,
    path: `/api/v1/customnotifications/${REX}`,
    body: '{"message":"This action is unauthorized."}',
  });
  await minutes(5);
  assert.equal(app.memory.pause, null);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  paj.failures.push({ status: 403, path: '/api/v1/customnotifications/', body: '<html>x</html>' });
  await minutes(5);
  assert.equal(app.memory.pause, null, 'a firewall page on the alerts: no pause either');
  // The same on the list of trackers pauses 6 h.
  paj.failures.push({ status: 403, path: '/api/v1/device', body: '<html>x</html>' });
  await minutes(5);
  assert.equal(app.memory.pause?.reason, 'forbidden');
});

test('S5: a configuration saved during a slow reading is applied at once; the old one publishes nothing', async () => {
  const paj = createFakePaj();
  let release;
  paj.gate = new Promise((resolve) => (release = resolve));
  const { gladys, app, connecting } = await setup({ paj, wait: false });
  await connecting;
  for (let i = 0; i < 10; i += 1) await tick();
  assert.ok(app.reading, 'a reading waits for PAJ');
  let applied = false;
  const saving = app
    .configUpdated({ email: 'other@example.org', password: 'x', home_radius: '500' })
    .then(() => {
      applied = true;
    });
  for (let i = 0; i < 20; i += 1) await tick();
  assert.equal(applied, true, 'not behind the reading');
  const states = gladys.fake.states.length;
  release();
  paj.gate = null;
  await saving;
  await settle(app);
  // The new account is refused by the fake PAJ: any state would come from the old reading.
  assert.equal(gladys.fake.states.length, states, 'the old reading published no state');
});

test('S6: a token refused again on the alerts: no other alert request with it', async () => {
  const paj = createFakePaj();
  const devices = [];
  for (let i = 1; i <= 20; i += 1) {
    paj.devices.push({ ...paj.devices[0], id: 900000 + i, name: `T${i}` });
    paj.points[900000 + i] = point(900000 + i);
    devices.push(created(900000 + i, `T${i}`));
  }
  const { app, minutes } = await setup({ paj, devices });
  await minutes(5);
  paj.expire();
  paj.refuseRefresh = true;
  const before = paj.requests.length;
  const original = paj.request;
  let logins = 0;
  const wrapped = async (url, options) => {
    if (url.includes('/login')) logins += 1;
    const answer = await original(url, options);
    if (url.includes('/trackerdata/')) paj.refuseAllTokens = true;
    return answer;
  };
  app.client.request = wrapped;
  await minutes(5);
  const alerts = paj.requests.slice(before).filter((r) => r.path.includes('customnotif'));
  assert.equal(logins, 1, 'one login only');
  assert.equal(alerts.length, 1, 'one refused alert request, then the round stops');
});

test('S7: above the cap, the most recent alerts (the SOS) fire', async () => {
  const paj = createFakePaj();
  const { gladys, clock, minutes } = await setup({ paj });
  await minutes(5);
  const base = clock.now;
  paj.alerts[GOLF] = [];
  for (let i = 0; i < 20; i += 1) paj.alerts[GOLF].push(alert(1000 + i, GOLF, 1, base + i * 1000));
  paj.alerts[REX] = [];
  for (let i = 0; i < 10; i += 1) paj.alerts[REX].push(alert(2000 + i, REX, 1, base + i * 1000));
  paj.alerts[REX].push(alert(3000, REX, 4, base + MIN));
  await minutes(5);
  const types = gladys.fake.sceneEvents.map((e) => e.data.alert_type);
  assert.equal(types.length, LIMITS.EVENTS_PER_ROUND);
  assert.equal(types.at(-1), 'sos');
});

test('S7: the alerts are never asked further back than an hour and two minutes', async () => {
  const paj = createFakePaj();
  const { minutes, clock } = await setup({ paj });
  await minutes(5);
  clock.now += 5 * HOUR; // a long pause of the readings
  await minutes(1);
  const request = paj.requests.filter((r) => r.path.includes('customnotif')).at(-1);
  const start = Number(new URL(request.url).searchParams.get('startDate'));
  assert.equal(start, Math.floor(clock.now / 1000) - 3600 - 120);
});

test('S11: a house located after the start counts at the next reading', async () => {
  const paj = createFakePaj();
  const { app, gladys, minutes } = await setup({ paj, houses: [] });
  assert.equal(app.houses.length, 0);
  gladys.fake.houses.push({ ...HOUSES[0] });
  paj.points[GOLF] = point(GOLF, { at: T0 + 4 * MIN });
  await minutes(5);
  assert.equal(app.houses.length, 1);
  assert.equal(last(gladys, GOLF, 'at_home'), 1);
});

test('S12: updating a device after a restart never sends the old position again', async () => {
  const paj = createFakePaj();
  const store = memoryStore();
  const first = await setup({ paj, store });
  await first.app.shutdown();
  const second = await setup({ paj, store, now: T0 + 10 * MIN });
  const device = second.gladys.devices.find((d) => d.external_id.endsWith(trackerKey(GOLF)));
  await second.app.deviceUpdated({ ...device, name: 'Golf (renamed)' });
  assert.equal(last(second.gladys, GOLF, 'latitude'), undefined);
  assert.equal(last(second.gladys, GOLF, 'at_home'), undefined);
});

test('M12: a 404 on the login says the route changed, not the credentials; never retried alone', async () => {
  const paj = createFakePaj();
  paj.failures.push({ status: 404, path: '/api/v1/login', body: '{"error":"Resource not found"}' });
  const { gladys, minutes } = await setup({ paj });
  assert.match(gladys.fake.connectionStatus.message.en, /login route was not found \(HTTP 404/);
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /refused the e-mail/);
  await minutes(60);
  assert.equal(paj.count('/api/v1/login'), 1);
});

test('R1: a permanent 403 on the alerts of the first tracker; the next one still fires', async () => {
  const paj = createFakePaj();
  const { app, gladys, minutes, clock } = await setup({ paj });
  await minutes(5); // the first alerts round only marks
  // Golf comes first (sorted by name): its alerts are always refused.
  paj.broken[`/api/v1/customnotifications/${GOLF}`] = 403;
  paj.alerts[REX] = [alert(77, REX, 4, clock.now + MIN)];
  await minutes(5);
  assert.deepEqual(
    gladys.fake.sceneEvents.map((e) => [e.data.device_name, e.data.alert_type]),
    [['Rex', 'sos']],
  );
  assert.equal(app.memory.pause, null);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
