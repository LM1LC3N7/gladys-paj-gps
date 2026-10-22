// -----------------------------------------------------------------------------
// PajApp: the integration. One PAJ GPS account, read through the API of
// connect.paj-gps.de (e-mail address and password, then a token). Read only.
//
//   pace       one reading every `poll_interval` s (5 min by default, never
//              less): the trackers, their last positions, then the alerts of
//              the trackers created in Gladys. The time of the last attempt
//              is kept in /data (written before the reading): neither a
//              restart, nor a reconnection to Gladys, nor saving an
//              unchanged configuration, nor the test button, nor Discovery
//              reads sooner. A minute tick decides; it makes no request
//              unless a reading is due.
//   failures   credentials refused by the API: final, persisted (a
//              fingerprint of the refused credentials only); nothing more is
//              sent with them until the configuration changes or the test
//              button tries once, never sooner than the interval. HTTP 429
//              and 5xx: a bounded pause of every request, persisted. A 403
//              page of a firewall: the longest pause. Anything else: the
//              next interval. A token refused is renewed once per reading
//              (src/paj/client.js), never in a loop.
//   presence   the distance to the nearest located house of Gladys (read
//              with `location: true`, kept in memory only) and "at home"
//              within a radius, with a margin against jitter.
//   positions  never logged, never written to /data; a position already
//              published (its date is kept in /data under a salted key) is
//              never published again as a new one after a restart.
//
// Every await of a reading is followed by a check of the generation: a late
// answer of an older configuration publishes nothing and sets no status (what
// PAJ answered about the credentials or a pause is still kept in /data).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { Budget } from './budget.js';
import { configFingerprint, isComplete, normalizeConfig } from './config.js';
import { ALERT_TYPES, FEATURES, LIMITS, PACING, SCENE_TRIGGERS } from './constants.js';
import { buildDevice, createdDevices, deviceIds, parseExternalId, trackerKey } from './devices.js';
import { distanceHome, housesOf, presence } from './geo.js';
import { T } from './i18n.js';
import { PajClient } from './paj/client.js';
import { CODES, PajError, isBusy } from './paj/errors.js';
import { httpRequest } from './paj/http.js';
import { formatDate } from './paj/parse.js';
import {
  alertKey,
  credentialsHash,
  fileStore,
  markKey,
  normalizeMemory,
  scopeHash,
  serializeMemory,
} from './store.js';

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
/** Entries per publishTransports call (the SDK refuses more). */
export const TRANSPORTS_PER_CALL = 100;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** The value of a state entry, number or text, as one comparable key. */
const valueOf = (s) => (s.text !== undefined ? `t:${s.text}` : `s:${s.state}`);
/** HH:MM UTC of a date. */
const clock = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
/** A scene event value: never undefined nor NaN. */
const safe = (value) =>
  value === undefined || (typeof value === 'number' && !Number.isFinite(value)) ? null : value;
/** Transport failures: the other alerts of the round are not tried. */
const TRANSPORT = new Set([CODES.UNREACHABLE, CODES.TIMEOUT, CODES.TLS_UNTRUSTED]);
/** A failure that says something about the credentials or a pause (kept in /data). */
const keep = (err) =>
  err instanceof PajError &&
  (err.code === CODES.REFUSED || err.code === CODES.FORBIDDEN || isBusy(err))
    ? err
    : null;

export class PajApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the HTTP transport (tests inject a fake PAJ API)
   * @param {object} [options.store] the persistent state (src/store.js)
   * @param {() => number} [options.now] the wall clock (ms)
   * @param {() => number} [options.monotonic] a clock that never jumps (ms), for the state budget
   * @param {object} [options.timers]
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'paj-gps' }),
    request = httpRequest,
    store = fileStore(),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    apiUrl,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.store = store;
    this.now = now;
    this.timers = timers;
    this.apiUrl = apiUrl;
    this.budget = new Budget({ perMinute: LIMITS.STATES_PER_MINUTE, now: monotonic });
    this.config = normalizeConfig();
    this.fingerprint = undefined;
    this.client = undefined;
    this.memory = undefined;
    this.generation = 0;
    this.queue = Promise.resolve();
    this.tickTimer = undefined;
    this.saveTimer = undefined;
    this.configTimer = undefined;
    this.savedAt = 0;
    /** The attempt time last written to /data (written at most once a minute). */
    this.savedAttemptAt = null;
    /** The reading in progress (a second request joins it). */
    this.reading = undefined;
    this.readingGeneration = -1;
    /** New credentials or a new account: the first reading need not wait. */
    this.immediate = false;
    /** The failure of the last reading (cleared by a reading that works). */
    this.lastError = undefined;
    this.lastStatus = undefined;
    /** The located houses of Gladys: [{ lat, lon }], memory only. */
    this.houses = [];
    /** key -> tracker of the last reading (memory only). */
    this.trackers = new Map();
    this.capped = 0;
    this.readAt = undefined;
    this.online = false;
    /** key -> 1 | 0: at home at the last reading (the margin against jitter). */
    this.presence = new Map();
    /** Keys of the trackers that have a battery (once seen, kept: never fewer features). */
    this.batteries = new Set();
    /** Keys whose position states may go even without a newer fix (published in this process). */
    this.sent = new Set();
    this.discoveredKey = null;
    this.transports = new Map();
    /** Values last accepted by Gladys (feature -> value), to budget only changes. */
    this.published = new Map();
    /** Where the next cut of each group of states starts (they take turns). */
    this.cursors = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Run `task` after every start already queued. */
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  async loadMemory() {
    if (!this.memory) {
      const raw = await this.store.load().catch(() => null);
      this.memory ??= normalizeMemory(raw, this.now());
      this.savedAttemptAt ??= this.memory.lastAttemptAt;
    }
    return this.memory;
  }

  /**
   * Gladys (re)connected: the status and Discovery are published again (the
   * core keeps them in memory only). The same configuration resumes as it
   * was: no reading before its time, the pauses and refusals stay, a reading
   * in progress goes on (and is not started again).
   */
  connected(raw = {}) {
    return this.enqueue(async () => {
      this.lastStatus = undefined;
      this.discoveredKey = null;
      this.transports.clear();
      this.clearConfigRetry();
      await this.loadHouses();
      if (raw === null && this.fingerprint === undefined) {
        // Gladys did not give the configuration and none runs: said, read again later.
        await this.setStatusOnce(false, T.status.configUnreadable);
        this.configTimer = this.timers.setTimeout(() => {
          this.configTimer = undefined;
          this.gladys
            .getConfig()
            .then((config) => this.connected(config ?? {}))
            .catch(() => this.connected(null))
            .catch((err) => this.logger.warn(`Start failed: ${err.message}`));
        }, PACING.CONFIG_RETRY);
        return;
      }
      if (
        this.fingerprint !== undefined &&
        (raw === null || configFingerprint(raw) === this.fingerprint)
      ) {
        this.startTick();
        await this.publishDiscovered(true);
        await this.publishTransports();
        await this.reportStatus();
        await this.tick();
        return;
      }
      await this.start(raw);
    });
  }

  clearConfigRetry() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  /** A status outside statusOf() (no configuration yet). */
  async setStatusOnce(connected, message) {
    this.lastStatus = JSON.stringify([connected, message]);
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = undefined;
      this.logger.warn(`Connection status not sent: ${err.message}`);
    });
  }

  /** A configuration saved: only a real change restarts. */
  configUpdated(raw = {}) {
    return this.enqueue(async () => {
      this.clearConfigRetry();
      if (configFingerprint(raw) === this.fingerprint) return;
      this.logger.info('Configuration updated');
      await this.start(raw);
    });
  }

  /** The located houses of Gladys (coordinates in memory only, never logged). */
  async loadHouses() {
    try {
      this.houses = housesOf(await this.gladys.getHouses());
    } catch (err) {
      this.houses = [];
      this.logger.warn(`Houses of Gladys not read (no distance to home): ${err.message}`);
    }
  }

  async start(raw = {}) {
    this.stopTick();
    this.generation += 1;
    const generation = this.generation;
    const memory = await this.loadMemory();
    if (generation !== this.generation) return;
    const config = normalizeConfig(raw);
    this.fingerprint = configFingerprint(raw);
    this.config = config;
    this.lastError = undefined;
    this.online = false;
    this.client?.close();
    this.client = undefined;
    if (!isComplete(config)) {
      await this.publishTransports();
      await this.reportStatus();
      return;
    }
    const scope = scopeHash(memory.salt, config);
    if (memory.scope !== scope) {
      // Another account: its own marks, and no wait for the first reading.
      memory.scope = scope;
      memory.marks = new Map();
      this.trackers = new Map();
      this.presence = new Map();
      this.batteries = new Set();
      this.sent = new Set();
      this.readAt = undefined;
      this.immediate = true;
      await this.persist({ urgent: true });
      if (generation !== this.generation) return;
    }
    if (memory.refused && memory.refused.hash !== credentialsHash(memory.salt, config)) {
      // Other credentials than the ones refused: they may be tried at once.
      this.immediate = true;
    }
    const client = new PajClient({
      email: config.email,
      password: config.password,
      request: this.request,
      ...(this.apiUrl ? { apiUrl: this.apiUrl } : {}),
    });
    client.onLogin = () => this.loggedIn();
    this.client = client;
    // Never the e-mail address.
    this.logger.info('Following the configured PAJ GPS account');
    this.startTick();
    await this.publishDiscovered(true);
    await this.publishTransports();
    await this.reportStatus();
    await this.tick();
  }

  /** Stop the timers; a reading in progress ends but publishes nothing. */
  stop() {
    this.generation += 1;
    this.stopTick();
    this.clearConfigRetry();
    this.client?.close();
    this.client = undefined;
    this.fingerprint = undefined;
  }

  /** Gladys went away: the timers stop, the state stays for the reconnection. */
  disconnected() {
    this.stopTick();
  }

  async shutdown() {
    this.stop();
    if (this.saveTimer !== undefined) {
      this.timers.clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      await this.writeMemory();
    }
  }

  startTick() {
    this.stopTick();
    this.tickTimer = this.timers.setInterval(
      () => this.tick().catch((err) => this.logger.warn(`Tick failed: ${err.message}`)),
      PACING.TICK,
    );
  }

  stopTick() {
    if (this.tickTimer !== undefined) {
      this.timers.clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  // --- Persistence -------------------------------------------------------------

  async writeMemory() {
    this.savedAt = this.now();
    const data = serializeMemory(this.memory);
    try {
      await this.store.save(data);
      this.savedAttemptAt = data.lastAttemptAt;
    } catch (err) {
      this.logger.warn(`State not saved: ${err.code ?? 'error'}`);
    }
  }

  /** Written at most once a minute; a refusal, a pause or a mark is written at once. */
  async persist({ urgent = false } = {}) {
    if (!this.memory) return;
    if (urgent || this.now() - this.savedAt >= PACING.SAVE_MIN_GAP) {
      if (this.saveTimer !== undefined) {
        this.timers.clearTimeout(this.saveTimer);
        this.saveTimer = undefined;
      }
      await this.writeMemory();
      return;
    }
    if (this.saveTimer === undefined) {
      this.saveTimer = this.timers.setTimeout(
        () => {
          this.saveTimer = undefined;
          this.writeMemory();
        },
        PACING.SAVE_MIN_GAP - (this.now() - this.savedAt),
      );
    }
  }

  // --- Scheduling ----------------------------------------------------------------

  intervalMs() {
    return this.config.pollSeconds * 1000;
  }

  /** The credentials of the configuration are the ones PAJ refused. */
  refused() {
    const refused = this.memory?.refused;
    return Boolean(
      refused && this.client && refused.hash === credentialsHash(this.memory.salt, this.config),
    );
  }

  paused() {
    return Boolean(this.memory?.pause && this.memory.pause.until > this.now());
  }

  /** When the next reading may start (null: none until the configuration changes). */
  nextReadAt() {
    if (!this.client || !this.memory || this.refused()) return null;
    const now = this.now();
    const memory = this.memory;
    // A clock set back: the last attempt counts as now, never a long wait.
    if (memory.lastAttemptAt !== null && memory.lastAttemptAt > now) memory.lastAttemptAt = now;
    let at =
      this.immediate || !memory.lastAttemptAt ? now : memory.lastAttemptAt + this.intervalMs();
    if (memory.pause) {
      memory.pause.until = Math.min(memory.pause.until, now + PACING.PAUSE_MAX);
      if (memory.pause.until > at) at = memory.pause.until;
    }
    return at;
  }

  /** The minute tick: a reading when it is due. */
  async tick() {
    const at = this.nextReadAt();
    if (at !== null && at <= this.now() && !this.readingCurrent()) await this.read();
  }

  /** A reading of the current configuration is in progress. */
  readingCurrent() {
    return this.reading !== undefined && this.readingGeneration === this.generation;
  }

  /**
   * One reading at a time: a second call joins the one in progress. A
   * reading of a former configuration publishes nothing, but the new one
   * waits for its end: never two sessions at once.
   */
  read() {
    if (!this.readingCurrent()) {
      const previous = this.reading ?? Promise.resolve();
      const promise = previous
        .catch(() => {})
        .then(() => this.doRead())
        .catch((err) => this.logger.error(`Reading failed: ${err?.name}: ${err?.message}`))
        .finally(() => {
          if (this.reading === promise) this.reading = undefined;
        });
      this.reading = promise;
      this.readingGeneration = this.generation;
    }
    return this.reading;
  }

  async doRead() {
    const generation = this.generation;
    const { client, config, memory } = this;
    if (!client || client.closed) return;
    const now = this.now();
    this.immediate = false;
    memory.lastAttemptAt = now;
    // The attempt is in /data before the request leaves (at most once a minute).
    const urgent = this.savedAttemptAt === null || now - this.savedAttemptAt >= PACING.SAVE_MIN_GAP;
    await this.persist({ urgent });
    if (generation !== this.generation) return;
    client.beginReading();
    let devices;
    let points;
    let followed;
    try {
      devices = await client.devices();
      if (generation !== this.generation) return;
      const createdKeys = new Set(createdDevices(this.gladys).map((c) => c.key));
      const keyed = devices.map((d) => ({ ...d, key: trackerKey(d.id) }));
      // The cap keeps the trackers created in Gladys first, then the others by id.
      followed = [
        ...keyed.filter((d) => createdKeys.has(d.key)),
        ...keyed.filter((d) => !createdKeys.has(d.key)),
      ].slice(0, LIMITS.DEVICES);
      points = await client.lastPositions(
        followed.map((d) => d.id),
        this.now() + PACING.FUTURE,
      );
    } catch (err) {
      await this.failed(err, generation, config);
      return;
    }
    if (generation !== this.generation) return;

    const cleared = memory.pause !== null;
    memory.pause = null;
    this.lastError = undefined;
    this.online = true;
    this.readAt = this.now();
    this.capped = devices.length - followed.length;
    const trackers = new Map();
    for (const device of followed) {
      const point = points.get(device.id) ?? null;
      const distance = distanceHome(point, this.houses);
      const home = presence(distance, this.config.homeRadius, this.presence.get(device.key));
      if (home === null) this.presence.delete(device.key);
      else this.presence.set(device.key, home);
      if (device.hasBattery || (point && point.battery !== null)) this.batteries.add(device.key);
      trackers.set(device.key, {
        id: device.id,
        key: device.key,
        mark: markKey(memory.salt, device.id),
        name: device.name ?? `PAJ GPS ${device.key.slice(0, 4)}`,
        hasBattery: this.batteries.has(device.key),
        point,
        distance,
        home,
      });
    }
    // The marks of trackers no longer read are dropped (bounded /data).
    const marks = new Set([...trackers.values()].map((t) => t.mark));
    for (const key of [...memory.marks.keys()]) {
      if (!marks.has(key)) memory.marks.delete(key);
    }
    this.trackers = new Map(
      [...trackers.values()]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id))
        .map((t) => [t.key, t]),
    );
    this.logger.info(
      `PAJ GPS read: ${trackers.size} tracker(s), ${[...trackers.values()].filter((t) => t.point).length} position(s)`,
    );
    if (cleared) await this.persist({ urgent: true });
    if (generation !== this.generation) return;
    await this.publishDiscovered(false);
    if (generation !== this.generation) return;
    await this.publishStates();
    if (generation !== this.generation) return;
    await this.publishTransports();
    if (generation !== this.generation) return;

    // The alerts (secondary): never block what was published above.
    const { events, failure } = await this.readAlerts(client, generation);
    if (generation !== this.generation) {
      if (failure) await this.keepFailure(failure, config);
      return;
    }
    await this.persist({ urgent: true });
    if (generation !== this.generation) return;
    for (const event of events.slice(0, LIMITS.EVENTS_PER_ROUND)) {
      if (generation !== this.generation) return;
      await this.gladys
        .publishSceneEvent(SCENE_TRIGGERS.TRACKER_ALERT, event)
        .catch((err) => this.logger.warn(`Scene event not sent: ${err.message}`));
    }
    if (events.length > LIMITS.EVENTS_PER_ROUND) {
      this.logger.info(`${events.length - LIMITS.EVENTS_PER_ROUND} alert(s) recorded, not fired`);
    }
    if (generation !== this.generation) return;
    if (failure) {
      await this.failed(failure, generation, config);
      return;
    }
    await this.reportStatus();
  }

  /**
   * The new alerts of the trackers created in Gladys, as scene events (the
   * marks are updated in memory; the caller writes them before firing). A
   * tracker seen for the first time only records the date (no event for
   * what happened before). Returns { events, failure }: `failure` a 429, a
   * refusal or a firewall answer that must take the usual path.
   */
  async readAlerts(client, generation) {
    const memory = this.memory;
    const created = new Map(createdDevices(this.gladys).map((c) => [c.key, c]));
    const now = this.now();
    const nowSec = Math.floor(now / 1000);
    const events = [];
    let failure = null;
    let skipped = 0;
    for (const tracker of this.trackers.values()) {
      const device = created.get(tracker.key);
      if (!device) continue;
      const mark = memory.marks.get(tracker.mark) ?? { f: null, a: null, i: [] };
      if (mark.a === null) {
        memory.marks.set(tracker.mark, { ...mark, a: nowSec, i: [] });
        continue;
      }
      let alerts;
      try {
        const start = Math.max(mark.a, nowSec - PACING.ALERT_LOOKBACK / 1000);
        alerts = await client.alerts(tracker.id, start, nowSec + 60);
      } catch (err) {
        if (generation !== this.generation) return { events, failure: keep(err) };
        if (!(err instanceof PajError) || err.code === CODES.CLOSED) {
          if (!(err instanceof PajError)) {
            this.logger.warn(`Alerts not read: ${err?.name}: ${err?.message}`);
          }
          break;
        }
        if (err.code === CODES.REFUSED || err.code === CODES.FORBIDDEN || err.status === 429) {
          failure = err;
          break;
        }
        skipped += 1;
        if (TRANSPORT.has(err.code)) break;
        continue;
      }
      if (generation !== this.generation) return { events, failure: null };
      let newest = mark.a;
      let ids = new Set(mark.i);
      for (const alert of alerts) {
        const sec = Math.floor(alert.atMs / 1000);
        if (alert.atMs > now + PACING.FUTURE) continue;
        const key = alertKey(memory.salt, alert.id);
        if (sec < mark.a || (sec === mark.a && mark.i.includes(key))) continue;
        if (now - alert.atMs <= PACING.ALERT_MAX_AGE) {
          events.push({
            atMs: alert.atMs,
            data: {
              device: safe(device.externalId),
              alert_type: ALERT_TYPES[alert.type] ?? 'other',
              device_name: safe(tracker.name.slice(0, LIMITS.NAME_LENGTH)),
              at: safe(formatDate(alert.atMs)),
            },
          });
        }
        if (sec > newest) {
          newest = sec;
          ids = new Set([key]);
        } else if (sec === newest) {
          ids.add(key);
        }
      }
      // The mark as it is now (a position may have been marked meanwhile).
      const current = memory.marks.get(tracker.mark) ?? mark;
      memory.marks.set(tracker.mark, { ...current, a: newest, i: [...ids].slice(-50) });
    }
    if (skipped > 0) this.logger.debug(`Alerts of ${skipped} tracker(s) not read this time`);
    events.sort((a, b) => a.atMs - b.atMs);
    return { events: events.map((e) => e.data), failure };
  }

  /** What a failure says about the credentials or a pause, kept in /data whatever the generation. */
  async keepFailure(err, config) {
    const memory = this.memory;
    if (!(err instanceof PajError) || !memory) return;
    if (err.code === CODES.REFUSED) {
      memory.refused = {
        hash: credentialsHash(memory.salt, config),
        status: err.status ?? null,
        at: this.now(),
      };
      await this.persist({ urgent: true });
    } else if (err.code === CODES.FORBIDDEN) {
      memory.pause = { until: this.now() + PACING.PAUSE_MAX, reason: 'forbidden', status: 403 };
      await this.persist({ urgent: true });
    } else if (isBusy(err)) {
      const wait = clamp(
        err.retryAfterMs ?? PACING.PAUSE_DEFAULT,
        Math.max(PACING.PAUSE_MIN, config.pollSeconds * 1000),
        PACING.PAUSE_MAX,
      );
      memory.pause = { until: this.now() + wait, reason: 'busy', status: err.status };
      await this.persist({ urgent: true });
    }
  }

  async failed(err, generation, config) {
    if (err instanceof PajError) {
      this.logger.warn(
        `PAJ GPS reading failed (${err.code}${err.status ? `, HTTP ${err.status}` : ''})`,
      );
    } else {
      // A fault of the integration: its name and message, never a value read.
      this.logger.error(`Internal error of the integration: ${err?.name}: ${err?.message}`);
    }
    await this.keepFailure(err, config);
    if (generation !== this.generation) return;
    this.lastError = err instanceof PajError ? err : { code: 'internal' };
    this.online = false;
    await this.publishTransports();
    if (generation !== this.generation) return;
    await this.reportStatus();
  }

  /**
   * A login with the password worked: the refusal kept in /data (of these
   * credentials or of former ones) is erased at once. Never before a login
   * succeeded.
   */
  loggedIn() {
    const memory = this.memory;
    if (memory?.refused) {
      memory.refused = null;
      this.persist({ urgent: true });
    }
  }

  // --- Status --------------------------------------------------------------------

  statusOf() {
    const config = this.config;
    if (!config.email || !config.password) {
      return { connected: false, message: T.status.missingCredentials };
    }
    if (config.emailInvalid) return { connected: false, message: T.status.emailInvalid };
    if (config.passwordInvalid) return { connected: false, message: T.status.passwordInvalid };
    if (this.refused()) {
      return { connected: false, message: T.status.refused(this.memory.refused.status) };
    }
    const now = this.now();
    if (this.paused()) {
      const { until, reason, status } = this.memory.pause;
      return {
        connected: false,
        message:
          reason === 'forbidden'
            ? T.status.forbidden(until - now)
            : T.status.busy(status, until - now),
      };
    }
    const next = this.nextReadAt();
    const nextText = next === null ? '—' : clock(Math.max(next, now));
    if (this.lastError) {
      return { connected: false, message: T.status.failed(this.lastError, nextText) };
    }
    if (this.readAt !== undefined && this.online) {
      if (this.trackers.size === 0)
        return { connected: true, message: T.status.noDevice(nextText) };
      return {
        connected: true,
        message: T.status.ok({
          total: this.trackers.size + this.capped,
          capped: this.capped,
          at: clock(this.readAt),
          next: nextText,
          home: this.houses.length > 0,
        }),
      };
    }
    return { connected: true, message: T.status.waiting(nextText) };
  }

  async reportStatus() {
    const { connected, message } = this.statusOf();
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = undefined;
      this.logger.warn(`Connection status not sent: ${err.message}`);
    });
  }

  // --- Publication -------------------------------------------------------------------

  /** Never throws: a refusal of Gladys is not a PAJ failure. */
  async publishDiscovered(force) {
    const hasHome = this.houses.length > 0;
    const list = [...this.trackers.values()];
    const key = JSON.stringify([hasHome, list.map((t) => [t.key, t.name, t.hasBattery])]);
    if (!force && key === this.discoveredKey) return;
    if (list.length === 0 && this.readAt === undefined) return;
    const devices = list.map((t) =>
      buildDevice(this.gladys, { key: t.key, name: t.name, hasBattery: t.hasBattery, hasHome }),
    );
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discoveredKey = key;
    } catch (err) {
      this.logger.warn(`Discovery not published: ${err.message}`);
    }
  }

  /** Discovery (scan button): reads only when a reading is due, else what is known. */
  async publishDiscovery() {
    if (this.readingCurrent()) {
      await this.reading;
    } else {
      const at = this.nextReadAt();
      if (at !== null && at <= this.now()) await this.read();
    }
    await this.publishDiscovered(true);
  }

  /**
   * The states of the created devices, by priority: the position (latitude
   * and longitude always together), at home and the distance, the battery,
   * the speed, the last seen text. Only the features of the created device
   * get a state. A position whose date was already published (kept in
   * /data) is never sent again as a new one after a restart: it goes only
   * when newer, when this process already published that tracker, or when
   * the device was just created.
   */
  statesOf() {
    const groups = { position: [], presence: [], battery: [], numbers: [], texts: [] };
    const touched = [];
    for (const created of createdDevices(this.gladys)) {
      const tracker = this.trackers.get(created.key);
      if (!tracker?.point) continue;
      const point = tracker.point;
      const pointSec = Math.floor(point.atMs / 1000);
      const mark = this.memory.marks.get(tracker.mark);
      const fresh =
        this.sent.has(tracker.key) ||
        mark?.f === null ||
        mark?.f === undefined ||
        pointSec > mark.f;
      if (!fresh) continue;
      touched.push([tracker, pointSec]);
      const ids = deviceIds(this.gladys, tracker.key);
      const state = (key, value) =>
        value === null || value === undefined || !created.features.has(ids.feature(key))
          ? null
          : { device_feature_external_id: ids.feature(key), state: value };
      const bundle = (...states) => states.filter(Boolean);
      const lat = state(FEATURES.LATITUDE, point.lat);
      const lon = state(FEATURES.LONGITUDE, point.lon);
      if (lat && lon) groups.position.push([lat, lon]);
      groups.presence.push(
        bundle(
          state(FEATURES.AT_HOME, tracker.home),
          state(FEATURES.DISTANCE_HOME, tracker.distance),
        ),
      );
      groups.battery.push(bundle(state(FEATURES.BATTERY, point.battery)));
      groups.numbers.push(bundle(state(FEATURES.SPEED, point.speed)));
      const lastSeen = formatDate(point.atMs);
      if (lastSeen && created.features.has(ids.feature(FEATURES.LAST_SEEN))) {
        groups.texts.push([
          { device_feature_external_id: ids.feature(FEATURES.LAST_SEEN), text: lastSeen },
        ]);
      }
    }
    return { groups, touched };
  }

  /**
   * Publish what changed, every state within the minute budget (POST /state
   * admits 300 per minute; this integration stays under 250), group by group
   * in priority order. A bundle is never split; when a group is cut, its
   * bundles take turns. What is held back goes at a later reading.
   */
  async publishStates() {
    if (!this.memory) return;
    const changed = (bundle) =>
      bundle.filter((s) => this.published.get(s.device_feature_external_id) !== valueOf(s));
    const { groups, touched } = this.statesOf();
    let room = this.budget.remaining();
    const list = [];
    let held = 0;
    for (const [name, bundles] of Object.entries(groups)) {
      const fresh = bundles.map(changed).filter((b) => b.length > 0);
      const size = fresh.reduce((sum, b) => sum + b.length, 0);
      if (size <= room) {
        for (const b of fresh) list.push(...b);
        room -= size;
        continue;
      }
      const start = fresh.length > 0 ? (this.cursors.get(name) ?? 0) % fresh.length : 0;
      let taken = 0;
      for (let i = 0; i < fresh.length; i += 1) {
        const b = fresh[(start + i) % fresh.length];
        if (b.length > room) break;
        list.push(...b);
        room -= b.length;
        taken += 1;
      }
      this.cursors.set(name, start + taken);
      held += fresh.slice(taken).reduce((sum, b) => sum + b.length, 0);
    }
    if (held > 0) this.logger.debug(`${held} state(s) held back (state budget)`);
    if (list.length > 0) {
      // Counted before the request: a publication running at the same time
      // (a device created during a reading) sees what this one takes. Gladys
      // may count them even when the request fails.
      this.budget.record(list.length);
      try {
        await this.gladys.publishChangedStates(list);
        for (const s of list) this.published.set(s.device_feature_external_id, valueOf(s));
      } catch (err) {
        this.logger.warn(`States not published: ${err.message}`);
        return;
      }
    }
    let marked = false;
    for (const [tracker, pointSec] of touched) {
      this.sent.add(tracker.key);
      const mark = this.memory.marks.get(tracker.mark) ?? { f: null, a: null, i: [] };
      if (mark.f === null || pointSec > mark.f) {
        this.memory.marks.set(tracker.mark, { ...mark, f: pointSec });
        marked = true;
      }
    }
    if (marked) await this.persist({ urgent: true });
  }

  /** Forget what was published for a device (Gladys forgot it too). */
  forget(externalId) {
    if (typeof externalId !== 'string') return;
    const prefix = `${externalId}:`;
    for (const id of [...this.published.keys()]) {
      if (id === externalId || id.startsWith(prefix)) this.published.delete(id);
    }
  }

  async publishTransports() {
    const entries = createdDevices(this.gladys).map(({ key, externalId }) => ({
      external_id: externalId,
      transport: this.online && this.trackers.has(key) ? 'cloud' : 'unreachable',
    }));
    const changed = entries.filter((e) => this.transports.get(e.external_id) !== e.transport);
    for (let start = 0; start < changed.length; start += TRANSPORTS_PER_CALL) {
      const batch = changed.slice(start, start + TRANSPORTS_PER_CALL);
      for (const entry of batch) this.transports.set(entry.external_id, entry.transport);
      await this.gladys.publishTransports(batch).catch((err) => {
        for (const entry of batch) this.transports.delete(entry.external_id);
        this.logger.debug(`Transports not published: ${err.message}`);
      });
    }
  }

  // --- Devices created / deleted in Gladys -----------------------------------

  /** Created or updated: the SDK forgot the values of this device, so do we; its values go. */
  async deviceCreated(device) {
    const parsed = parseExternalId(this.gladys, device?.external_id);
    this.forget(device?.external_id);
    this.transports.delete(device?.external_id);
    if (parsed && parsed.feature === null) this.sent.add(parsed.key);
    if (this.online) await this.publishStates();
    await this.publishTransports();
  }

  async deviceUpdated(device) {
    await this.deviceCreated(device);
  }

  deviceDeleted(device) {
    this.forget(device?.external_id);
    this.transports.delete(device?.external_id);
  }

  /** Read only: nothing is ever sent to PAJ GPS. */
  async setValue() {
    throw new Error(T.errors.readOnly);
  }

  // --- Configuration button --------------------------------------------------

  /** Resolves `promise`, or rejects with `message` after `ms`. */
  within(promise, ms, message) {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  /**
   * "Test the connection": reads now only when a reading is due (refused
   * credentials included: one more try, never sooner than the interval, the
   * refusal erased only by a login that works); otherwise shows the last
   * result and when the next reading comes. Never lifts a pause.
   */
  async testConnection() {
    return this.within(this.test(), PACING.TEST_BUDGET, T.errors.testTooLong);
  }

  async test() {
    await this.queue;
    if (!this.client) {
      throw new Error(this.statusOf().message.en);
    }
    const answer = async () => {
      await this.reportStatus();
      const status = this.statusOf();
      if (!status.connected) throw new Error(status.message.en);
      return T.test.read(status.message);
    };
    if (this.readingCurrent()) {
      await this.reading;
      return answer();
    }
    const last = this.memory.lastAttemptAt;
    const spaced = !last || this.now() - last >= this.intervalMs();
    if (this.refused() && spaced && !this.paused()) {
      await this.read();
      return answer();
    }
    const at = this.nextReadAt();
    if (at !== null && at <= this.now()) {
      await this.read();
      return answer();
    }
    const status = this.statusOf();
    if (!status.connected) throw new Error(status.message.en);
    return T.test.notDue(status.message);
  }
}
