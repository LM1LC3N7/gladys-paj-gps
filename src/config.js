// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { HOME_RADII, POLL_INTERVALS } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  poll_interval: '300',
  home_radius: '200',
});

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const pick = (key, list) => (list.includes(String(raw[key])) ? String(raw[key]) : DEFAULTS[key]);
  const email = typeof raw.email === 'string' ? raw.email.trim() : '';
  // A password pasted with its line end: the line end is not part of it.
  const password = typeof raw.password === 'string' ? raw.password.replace(/[\r\n]+$/, '') : '';
  return {
    email,
    password,
    emailInvalid:
      email !== '' &&
      (CONTROL.test(email) || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)),
    passwordInvalid: password !== '' && (CONTROL.test(password) || password.length > 512),
    pollSeconds: Number(pick('poll_interval', POLL_INTERVALS)),
    homeRadius: Number(pick('home_radius', HOME_RADII)),
  };
}

/** Everything needed to log in is there and usable. */
export const isComplete = (config) =>
  Boolean(config.email && config.password && !config.emailInvalid && !config.passwordInvalid);

/**
 * What restarts the integration when it changes: every key it reads. Kept
 * in memory only (it covers the password); a reconnection to Gladys or a
 * configuration saved unchanged changes nothing.
 */
export function configFingerprint(raw = {}) {
  const value = raw ?? {};
  const keys = ['email', 'password', 'poll_interval', 'home_radius'];
  return createHash('sha256')
    .update(JSON.stringify(keys.map((key) => [key, value[key] ?? null])))
    .digest('hex');
}
