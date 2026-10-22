// -----------------------------------------------------------------------------
// The answers of the PAJ GPS API -> plain objects. The shapes come from
// pajgps-api 0.4.1 (MIT, src/pajgps_api/models/ and the OpenAPI description
// `api-docs.json` of its repository), ported to JavaScript; never checked
// against a real account (TODO.md).
//
//   GET  /api/v1/device                        { success: [{ id, name, imei,
//        device_models: [{ standalone_battery, alarm_volt, ... }], ... }] }
//   POST /api/v1/trackerdata/getalllastpositions { success: [{ iddevice, lat,
//        lng, dateunix, speed, battery (or battery_level), direction, ... }] }
//   GET  /api/v1/customnotifications/<id>      { success: [{ id, iddevice,
//        meldungtyp, dateunix, lat, lng, ... }] }
//
// Every list is read once, entry by entry, up to LIMITS.ENTRIES. The IMEI,
// the phone number, the share link and the positions of an alert are never
// kept. Dates are unix seconds; outside 2000-2100 they are no date.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

const MIN_MS = Date.UTC(2000, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > 40) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const within = (value, min, max) => {
  const n = number(value);
  return n !== null && n >= min && n <= max ? n : null;
};
const round = (value, digits) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};
/** A positive integer id (number or digits), or null. */
const idOf = (value) => {
  const n = number(value);
  return n !== null && Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Unix seconds of the API -> ms, or null. */
export function dateOf(value) {
  const seconds = number(value);
  if (seconds === null) return null;
  const ms = Math.round(seconds * 1000);
  return ms >= MIN_MS && ms <= MAX_MS ? ms : null;
}

/** The `success` list of an answer, or null when the answer is not one. */
export function successList(value) {
  if (!isObject(value) || !Array.isArray(value.success)) return null;
  return value.success.length > LIMITS.ENTRIES
    ? value.success.slice(0, LIMITS.ENTRIES)
    : value.success;
}

/** The text of a name, trimmed, without control characters, or null. */
function nameOf(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return name ? name.slice(0, LIMITS.NAME_LENGTH) : null;
}

/** One tracker of the list, or null when it is not usable. */
export function parseDevice(entry) {
  if (!isObject(entry)) return null;
  const id = idOf(entry.id);
  if (id === null) return null;
  // A deleted tracker is not followed.
  if (entry.deleted_at !== null && entry.deleted_at !== undefined && entry.deleted_at !== '') {
    return null;
  }
  const model = Array.isArray(entry.device_models) ? entry.device_models[0] : null;
  return {
    id,
    name: nameOf(entry.name),
    // pajgps-api `Device.has_battery`: only standalone_battery = 1 means a battery.
    hasBattery: isObject(model) && Number(model.standalone_battery) === 1,
  };
}

/** The trackers of the account (sorted by id, no duplicate), or null when not a list. */
export function parseDevices(value) {
  const list = successList(value);
  if (!list) return null;
  const devices = [];
  const seen = new Set();
  for (const entry of list) {
    const device = parseDevice(entry);
    if (device && !seen.has(device.id)) {
      seen.add(device.id);
      devices.push(device);
    }
  }
  devices.sort((a, b) => a.id - b.id);
  return devices;
}

/** A position needs both coordinates, rounded to 6 decimals (a lone one is never kept). */
export function position(rawLat, rawLon) {
  const lat = within(rawLat, -90, 90);
  const lon = within(rawLon, -180, 180);
  if (lat === null || lon === null) return null;
  // 0, 0 is the "no fix" of many trackers, never a real place here.
  if (lat === 0 && lon === 0) return null;
  return { lat: round(lat, 6), lon: round(lon, 6) };
}

/**
 * The last point of each tracker: Map(id -> { lat, lon, atMs, speed,
 * battery }), the newest dated point at most `maxMs` per tracker, or null
 * when the answer is not a list.
 */
export function parsePositions(value, maxMs = Infinity) {
  const list = successList(value);
  if (!list) return null;
  const points = new Map();
  for (const entry of list) {
    if (!isObject(entry)) continue;
    const id = idOf(entry.iddevice);
    const atMs = dateOf(entry.dateunix);
    const where = position(entry.lat, entry.lng);
    if (id === null || atMs === null || atMs > maxMs || !where) continue;
    const known = points.get(id);
    if (known && known.atMs >= atMs) continue;
    const speed = within(entry.speed, 0, 2000);
    const battery = within(entry.battery ?? entry.battery_level, 0, 100);
    points.set(id, {
      ...where,
      atMs,
      speed: speed === null ? null : round(speed, 1),
      battery: battery === null ? null : Math.round(battery),
    });
  }
  return points;
}

/**
 * The alerts of a tracker: [{ id, type, atMs }] sorted by date then id,
 * never their position; null when the answer is not a list.
 */
export function parseAlerts(value) {
  const list = successList(value);
  if (!list) return null;
  const alerts = [];
  for (const entry of list) {
    if (!isObject(entry)) continue;
    const id = idOf(entry.id);
    const atMs = dateOf(entry.dateunix);
    const type = number(entry.meldungtyp);
    if (id === null || atMs === null || type === null || !Number.isInteger(type)) continue;
    alerts.push({ id, type, atMs });
  }
  alerts.sort((a, b) => a.atMs - b.atMs || a.id - b.id);
  return alerts;
}

/** `YYYY-MM-DD HH:MM UTC`, or null. */
export function formatDate(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
