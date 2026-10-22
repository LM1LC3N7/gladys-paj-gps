// -----------------------------------------------------------------------------
// Gladys devices (pure).
//
//   device   `ext:<selector>:device:<tracker key>`
//            one per PAJ GPS tracker: latitude, longitude, speed, battery
//            (trackers with their own battery), last seen (text), and, once a
//            house of Gladys has a position, distance to home and at home
//
// The key is a digest of the PAJ id of the tracker (stable; the id itself
// never appears in Gladys). Renaming a tracker in the PAJ app keeps the same
// Gladys device (Discovery shows the new name).
//
// A device published again never loses a feature: the core would mark it
// `structure_changed`, and "Update" would drop the history of the missing
// one. The features of the device created in Gladys (`gladys.devices`, kept
// up to date by the SDK) are added back when the blueprint lacks them.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, FEATURES, LIMITS } from './constants.js';

export const ID_PATTERN = /^[0-9a-f]{16}$/;

/** The id of a PAJ tracker in Gladys: a digest of its PAJ id (fixed forever). */
export const trackerKey = (id) =>
  createHash('sha256').update(`gladys-paj-gps:tracker:${id}`).digest('hex').slice(0, 16);

export const deviceIds = (gladys, key) => gladys.externalIds(DEVICE_TYPE, key);

const feature = (ids, key, name, spec, keepHistory = false) => ({
  name,
  external_id: ids.feature(key),
  read_only: true,
  has_feedback: false,
  ...spec,
  keep_history: keepHistory,
});

/** The features of the created device the blueprint lacks, appended (never fewer). */
export function withCreatedFeatures(gladys, device, devices = gladys.devices) {
  const created = (devices ?? []).find((d) => d?.external_id === device.external_id);
  if (!created) return device;
  const known = new Set(device.features.map((f) => f.external_id));
  const extra = (created.features ?? []).filter(
    (f) => f && typeof f.external_id === 'string' && !known.has(f.external_id),
  );
  if (extra.length === 0) return device;
  return { ...device, features: [...device.features, ...extra] };
}

/**
 * Units and types: only the pairs and units the core lists
 * (server/utils/constants.js: DEVICE_FEATURE_UNITS_BY_CATEGORY). The core has
 * no category for coordinates: latitude and longitude are `unknown`/`unknown`
 * without unit. What tells where the tracker is (positions, speed, distance,
 * at home) keeps no history by default (privacy; the user may turn it on).
 *
 * @param {{ key: string, name: string, hasBattery?: boolean, hasHome?: boolean }} tracker
 */
export function buildDevice(gladys, { key, name, hasBattery = false, hasHome = false }) {
  const ids = deviceIds(gladys, key);
  const features = [
    feature(ids, FEATURES.LATITUDE, 'Latitude', {
      category: C.UNKNOWN,
      type: T.UNKNOWN.UNKNOWN,
      min: -90,
      max: 90,
    }),
    feature(ids, FEATURES.LONGITUDE, 'Longitude', {
      category: C.UNKNOWN,
      type: T.UNKNOWN.UNKNOWN,
      min: -180,
      max: 180,
    }),
    feature(ids, FEATURES.SPEED, 'Speed', {
      category: C.SPEED_SENSOR,
      type: T.SPEED_SENSOR.DECIMAL,
      unit: U.KILOMETER_PER_HOUR,
      min: 0,
      max: 2000,
    }),
  ];
  if (hasBattery) {
    features.push(
      feature(
        ids,
        FEATURES.BATTERY,
        'Battery',
        { category: C.BATTERY, type: T.BATTERY.INTEGER, unit: U.PERCENT, min: 0, max: 100 },
        true,
      ),
    );
  }
  features.push(
    feature(ids, FEATURES.LAST_SEEN, 'Last seen', {
      category: C.TEXT,
      type: T.TEXT.TEXT,
      min: 0,
      max: 0,
    }),
  );
  if (hasHome) {
    features.push(
      feature(ids, FEATURES.DISTANCE_HOME, 'Distance to home', {
        category: C.DISTANCE_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: U.M,
        min: 0,
        max: 20_100_000,
      }),
      // Never a switch nor a presence or motion sensor: the core hands
      // switches to the voice assistants and scenes, and reads the sensors
      // as someone in the house. Read-only `unknown`/`binary`.
      feature(ids, FEATURES.AT_HOME, 'At home', {
        category: C.UNKNOWN,
        type: T.SENSOR.BINARY,
        min: 0,
        max: 1,
      }),
    );
  }
  return withCreatedFeatures(gladys, {
    name: name.slice(0, LIMITS.NAME_LENGTH),
    external_id: ids.device,
    model: 'PAJ GPS tracker',
    should_poll: false,
    features,
  });
}

/**
 * What a device or feature external id of this integration designates:
 * { key, feature } | null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string') return null;
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  if (!externalId.startsWith(prefix)) return null;
  const [key, featureKey, ...rest] = externalId.slice(prefix.length).split(':');
  if (rest.length > 0 || !ID_PATTERN.test(key ?? '')) return null;
  return { key, feature: featureKey ?? null };
}

/** The created devices of this integration: [{ key, externalId, features }]. */
export function createdDevices(gladys, devices = gladys.devices) {
  const list = [];
  for (const device of devices ?? []) {
    const parsed = parseExternalId(gladys, device?.external_id);
    if (!parsed || parsed.feature !== null) continue;
    const features = new Set(
      (device.features ?? []).map((f) => f?.external_id).filter((id) => typeof id === 'string'),
    );
    list.push({ key: parsed.key, externalId: device.external_id, features });
  }
  return list;
}
