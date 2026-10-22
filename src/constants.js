// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys, the trigger keys and the
// external id shapes are stored in user scenes and devices: never rename them
// (test/manifest.test.js ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
});

export const SCENE_TRIGGERS = Object.freeze({
  TRACKER_ALERT: 'tracker_alert',
});

/**
 * Device external ids: `ext:<selector>:device:<tracker key>`, the tracker key
 * a hexadecimal digest of the PAJ id of the tracker (src/devices.js).
 */
export const DEVICE_TYPE = 'device';

export const FEATURES = Object.freeze({
  LATITUDE: 'latitude',
  LONGITUDE: 'longitude',
  SPEED: 'speed',
  BATTERY: 'battery',
  LAST_SEEN: 'last_seen',
  DISTANCE_HOME: 'distance_home',
  AT_HOME: 'at_home',
});

/**
 * The alert types of the PAJ API (the `meldungtyp` of a notification, as
 * pajgps-api's `alert_types.py` documents them) -> the value of the trigger.
 * Any other number is `other`.
 */
export const ALERT_TYPES = Object.freeze({
  1: 'shock',
  2: 'battery',
  3: 'radius',
  4: 'sos',
  5: 'speed',
  6: 'power_cut',
  7: 'ignition',
  9: 'drop',
  10: 'area_enter',
  11: 'area_leave',
  13: 'voltage',
  22: 'turn_off',
});
/** The values of the `alert_type` field of the trigger, in the manifest order. */
export const ALERT_VALUES = Object.freeze([...Object.values(ALERT_TYPES), 'other']);

/** Seconds between two readings: 5 minutes at least (a cloud shared by many customers). */
export const POLL_INTERVALS = Object.freeze(['300', '600', '900', '1800', '3600']);

/** Meters around a house of Gladys within which a tracker is "at home". */
export const HOME_RADII = Object.freeze(['100', '200', '300', '500', '1000']);

/** Caps: what is read, published and fired. */
export const LIMITS = Object.freeze({
  /** Trackers followed on the account (the rest is counted in the status). */
  DEVICES: 20,
  /** Scene events sent in one reading. */
  EVENTS_PER_ROUND: 30,
  /** Alerts asked per tracker and reading (`noOfNotification`). */
  ALERTS_PER_TRACKER: 20,
  /** POST /state admits 300 states per minute per integration: stay under 250. */
  STATES_PER_MINUTE: 250,
  /** A tracker name published to Gladys is cut to this length. */
  NAME_LENGTH: 100,
  /** Entries read from one list of the API at most (linear, bounded). */
  ENTRIES: 2000,
  /** A token longer than this is no token. */
  TOKEN_LENGTH: 4096,
});

export const PACING = Object.freeze({
  /** The scheduler runs once a minute; it makes no request unless a reading is due. */
  TICK: 60_000,
  /** One request never waits longer than this. */
  REQUEST_TIMEOUT: 20_000,
  /** The "Test the connection" button waits 60 s: answer within 55 s. */
  TEST_BUDGET: 55_000,
  /** HTTP 429 or 5xx: pause of every request, within these bounds (Retry-After if given). */
  PAUSE_MIN: 60_000,
  PAUSE_DEFAULT: 15 * 60_000,
  PAUSE_MAX: 6 * 3600_000,
  /** Gladys did not give the configuration: asked again after this. */
  CONFIG_RETRY: 60_000,
  /** The time of the last attempt is written to /data at most this often. */
  SAVE_MIN_GAP: 60_000,
  /** An alert older than this when it is read is recorded, never fired. */
  ALERT_MAX_AGE: 3600_000,
  /** The alerts are never asked further back than this. */
  ALERT_LOOKBACK: 24 * 3600_000,
  /** A date more than this ahead of the clock of Gladys is no date. */
  FUTURE: 24 * 3600_000,
});

/** Size cap of an answer read from PAJ GPS. */
export const MAX_BYTES = 1024 * 1024;

/** The persistent state (see src/store.js). */
export const STATE_FILE = 'paj-gps-state.json';

/** The API of PAJ GPS (the default of pajgps-api). */
export const API_URL = 'https://connect.paj-gps.de';
