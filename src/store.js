// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), so that a restart never reads PAJ GPS before its time, never
// tries refused credentials again, and never republishes an old position as
// a new one:
// - `salt`: a random key generated once, for the fingerprints below;
// - `lastAttemptAt`: the time of the last reading attempt (written before the
//   reading, at most once a minute);
// - `pause`: the end of a pause asked by PAJ (429, 5xx) or a firewall (403);
// - `refused`: the fingerprint (HMAC with the salt) of the credentials PAJ
//   refused, erased at the first successful login. Never any fingerprint of
//   credentials that worked;
// - `scope`: a fingerprint of the account (its e-mail address), so that the
//   marks below belong to it;
// - `marks`: per tracker (an HMAC of its PAJ id), the date of the last
//   position published (`f`, unix seconds) and of the last alert seen (`a`),
//   with fingerprints of the alerts of that second (`i`).
// Never an e-mail address, a password, a token, a position, a tracker name or
// id. Bounded when read back. The file is readable by the container user only.
// -----------------------------------------------------------------------------

import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LIMITS, PACING, STATE_FILE } from './constants.js';

/** The state file in the data directory: one write at a time, atomic. */
export function fileStore(dataDir = process.env.DATA_DIR ?? '/data') {
  const path = join(dataDir, STATE_FILE);
  let chain = Promise.resolve();
  return {
    path,
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 256 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = `${JSON.stringify(data)}\n`;
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        try {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(temporary, text, { mode: 0o600 });
          await rename(temporary, path);
        } catch (err) {
          await rm(temporary, { force: true }).catch(() => {});
          throw err;
        }
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const HEX64 = /^[0-9a-f]{64}$/;
const MARK_KEY = /^[0-9a-f]{32}$/;
const ALERT_ID = /^[0-9a-f]{16}$/;
const MAX_MARKS = 4 * LIMITS.DEVICES;
const seconds = (value, nowSec) =>
  Number.isSafeInteger(value) && value > 0 ? Math.min(value, nowSec + PACING.FUTURE / 1000) : null;

/** The persisted state, repaired and bounded (`now` caps what lies in the future). */
export function normalizeMemory(raw, now) {
  const data = isObject(raw) ? raw : {};
  const pause = isObject(data.pause) ? data.pause : {};
  const refused = isObject(data.refused) ? data.refused : {};
  const nowSec = Math.floor(now / 1000);
  const marks = new Map();
  if (isObject(data.marks)) {
    for (const [key, value] of Object.entries(data.marks)) {
      if (marks.size >= MAX_MARKS) break;
      if (!MARK_KEY.test(key) || !isObject(value)) continue;
      marks.set(key, {
        f: seconds(value.f, nowSec),
        a: seconds(value.a, nowSec),
        i: Array.isArray(value.i)
          ? value.i.filter((id) => typeof id === 'string' && ALERT_ID.test(id)).slice(0, 50)
          : [],
      });
    }
  }
  return {
    salt:
      typeof data.salt === 'string' && HEX64.test(data.salt)
        ? data.salt
        : randomBytes(32).toString('hex'),
    // A last attempt "in the future" (a clock set back) counts as now.
    lastAttemptAt:
      Number.isFinite(data.lastAttemptAt) && data.lastAttemptAt > 0
        ? Math.min(data.lastAttemptAt, now)
        : null,
    pause:
      Number.isFinite(pause.until) && pause.until > now
        ? {
            until: Math.min(pause.until, now + PACING.PAUSE_MAX),
            reason: pause.reason === 'forbidden' ? 'forbidden' : 'busy',
            status: Number.isInteger(pause.status) ? pause.status : null,
          }
        : null,
    refused:
      typeof refused.hash === 'string' && HEX64.test(refused.hash)
        ? {
            hash: refused.hash,
            status: Number.isInteger(refused.status) ? refused.status : null,
            at: Number.isFinite(refused.at) ? Math.min(refused.at, now) : now,
          }
        : null,
    scope: typeof data.scope === 'string' && HEX64.test(data.scope) ? data.scope : null,
    marks,
  };
}

/** The JSON written to /data. */
export function serializeMemory(memory) {
  return {
    salt: memory.salt,
    lastAttemptAt: memory.lastAttemptAt,
    pause: memory.pause,
    refused: memory.refused,
    scope: memory.scope,
    marks: Object.fromEntries(memory.marks),
  };
}

const hmac = (salt, parts) =>
  createHmac('sha256', salt).update(JSON.stringify(parts)).digest('hex');

/** The fingerprint of credentials, kept only once PAJ refused them. */
export const credentialsHash = (salt, config) =>
  hmac(salt, ['credentials', config.email.toLowerCase(), config.password]);

/** Which account is read: no password in it. */
export const scopeHash = (salt, config) => hmac(salt, ['scope', config.email.toLowerCase()]);

/** The key of a tracker in /data: never its PAJ id in clear. */
export const markKey = (salt, id) => hmac(salt, ['tracker', String(id)]).slice(0, 32);

/** The fingerprint of an alert in /data (only to tell two alerts of the same second apart). */
export const alertKey = (salt, id) => hmac(salt, ['alert', String(id)]).slice(0, 16);
