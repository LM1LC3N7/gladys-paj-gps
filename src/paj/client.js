// -----------------------------------------------------------------------------
// The PAJ GPS API (https://connect.paj-gps.de), as pajgps-api 0.4.1 (MIT,
// src/pajgps_api/pajgps_api.py and pajgps_requests.py, ported to JavaScript)
// uses it with the account of the customer:
//   POST /api/v1/login?email=&password=          -> token, refresh_token
//   POST /api/v1/updatetoken?email=&refresh_token= -> a new token
//   GET  /api/v1/device                             the trackers
//   POST /api/v1/trackerdata/getalllastpositions    their last positions
//   GET  /api/v1/customnotifications/<id>           the alerts of one tracker
// Read only: no other route, no command, no notification marked read.
//
// The login and the renewal put the credentials in the query, as the API
// documents them: no URL is ever logged or put in an error. The token and the
// refresh token live in memory only. A token refused (HTTP 401) is renewed at
// most once per reading (refresh token, then the password); a second refusal
// is an error of that reading, never a loop.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { API_URL, LIMITS, MAX_BYTES, PACING } from '../constants.js';
import { CODES, PajError, envelopeOf } from './errors.js';
import { httpRequest } from './http.js';
import { parseAlerts, parseDevices, parsePositions } from './parse.js';

/** Retry-After (seconds, or an HTTP date) in ms, or null. */
export function retryAfterMs(value, now = Date.now()) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const text = raw.trim();
  if (/^\d{1,9}$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) && at > now ? at - now : null;
}

/** gladys-paj-gps/<version>, from package.json (copied into the image): honest, never an app's. */
export const USER_AGENT = (() => {
  try {
    const { version } = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    return typeof version === 'string' ? `gladys-paj-gps/${version}` : 'gladys-paj-gps';
  } catch {
    return 'gladys-paj-gps';
  }
})();

/** A token fit for an Authorization header. */
const TOKEN = new RegExp(`^[\\x21-\\x7e]{1,${LIMITS.TOKEN_LENGTH}}$`);

export class PajClient {
  /**
   * @param {object} options
   * @param {string} options.email the e-mail address of the PAJ account
   * @param {string} options.password its password
   * @param {Function} [options.request] the HTTP transport (tests inject a fake PAJ API)
   * @param {string} [options.apiUrl]
   */
  constructor({ email, password, request = httpRequest, apiUrl = API_URL }) {
    this.email = email;
    this.password = password;
    this.request = request;
    this.apiUrl = apiUrl;
    this.token = null;
    this.refreshToken = null;
    this.closed = false;
    /** The token was already renewed in this reading. */
    this.renewed = false;
    /** Called once a login with the password worked. */
    this.onLogin = null;
  }

  close() {
    this.closed = true;
    this.token = null;
    this.refreshToken = null;
  }

  /** A new reading: the token may be renewed once again. */
  beginReading() {
    this.renewed = false;
  }

  async send(method, path, { query, body, auth = true } = {}) {
    if (this.closed) throw new PajError(CODES.CLOSED, 'Client closed');
    const search = query ? `?${new URLSearchParams(query).toString()}` : '';
    const headers = { 'user-agent': USER_AGENT };
    if (auth && this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await this.request(`${this.apiUrl}${path}${search}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      timeout: PACING.REQUEST_TIMEOUT,
      maxBytes: MAX_BYTES,
    });
    if (this.closed) throw new PajError(CODES.CLOSED, 'Client closed');
    return response;
  }

  httpError(response) {
    const status = response.status;
    if (status === 403 && !envelopeOf(response.body ?? '')) {
      return new PajError(CODES.FORBIDDEN, 'HTTP 403', { status });
    }
    return new PajError(CODES.HTTP, `HTTP ${status}`, {
      status,
      retryAfterMs: retryAfterMs(response.headers?.['retry-after']),
    });
  }

  /**
   * The token of a login or a renewal. A refusal answered by the API itself
   * (its JSON envelope with an HTTP 4xx, any 401, or a 2xx with `error`) is
   * REFUSED; 429, 5xx, a 403 page of a firewall and the transport failures
   * are passing.
   */
  async authenticate(path, query) {
    const response = await this.send('POST', path, { query, auth: false });
    const status = response.status;
    const envelope = envelopeOf(response.body ?? '');
    if (status === 429 || status >= 500) throw this.httpError(response);
    if (status >= 200 && status <= 299) {
      const success = envelope?.success;
      if (success && typeof success === 'object' && TOKEN.test(success.token ?? '')) {
        this.token = success.token;
        this.refreshToken = TOKEN.test(success.refresh_token ?? '') ? success.refresh_token : null;
        return;
      }
      if (envelope && Object.hasOwn(envelope, 'error')) {
        throw new PajError(CODES.REFUSED, `Login refused (HTTP ${status})`, { status });
      }
      throw new PajError(CODES.BAD_ANSWER, 'Login answered without a token');
    }
    if (status === 401 || (status >= 400 && status <= 499 && envelope)) {
      throw new PajError(CODES.REFUSED, `Login refused (HTTP ${status})`, { status });
    }
    throw this.httpError(response);
  }

  /** pajgps-api `login`: the password, once. */
  async login() {
    this.token = null;
    this.refreshToken = null;
    await this.authenticate('/api/v1/login', { email: this.email, password: this.password });
    this.onLogin?.();
  }

  /**
   * pajgps-api `update_token`, then `login` when the refresh token is
   * refused (never a loop: one renewal per reading).
   */
  async renew() {
    this.renewed = true;
    if (this.refreshToken) {
      const refreshToken = this.refreshToken;
      this.token = null;
      try {
        await this.authenticate('/api/v1/updatetoken', {
          email: this.email,
          refresh_token: refreshToken,
        });
        return;
      } catch (err) {
        const passing =
          err?.code !== CODES.REFUSED && err?.code !== CODES.BAD_ANSWER && err?.status !== 404;
        if (passing) throw err;
      }
    }
    await this.login();
  }

  /** A data request with the token; a 401 renews it once per reading. */
  async call(method, path, options = {}) {
    if (this.closed) throw new PajError(CODES.CLOSED, 'Client closed');
    if (!this.token) {
      if (this.renewed) throw new PajError(CODES.SESSION, 'No token');
      this.renewed = true;
      await this.login();
    }
    let response = await this.send(method, path, options);
    if (response.status === 401) {
      if (this.renewed) throw new PajError(CODES.SESSION, 'Token refused again', { status: 401 });
      await this.renew();
      response = await this.send(method, path, options);
      if (response.status === 401) {
        this.token = null;
        throw new PajError(CODES.SESSION, 'Token refused again', { status: 401 });
      }
    }
    if (response.status < 200 || response.status > 299) throw this.httpError(response);
    try {
      return JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new PajError(CODES.BAD_ANSWER, 'Not JSON');
    }
  }

  /** The trackers of the account. Rejects a PajError. */
  async devices() {
    const devices = parseDevices(await this.call('GET', '/api/v1/device'));
    if (!devices) throw new PajError(CODES.BAD_ANSWER, 'Not the list of trackers');
    return devices;
  }

  /** The last point of each of these trackers (Map id -> point), dated at most `maxMs`. */
  async lastPositions(ids, maxMs = Infinity) {
    if (ids.length === 0) return new Map();
    const value = await this.call('POST', '/api/v1/trackerdata/getalllastpositions', {
      body: { deviceIDs: ids, fromLastPoint: false },
    });
    const points = parsePositions(value, maxMs);
    if (!points) throw new PajError(CODES.BAD_ANSWER, 'Not a list of positions');
    return points;
  }

  /** The alerts of one tracker between two dates (unix seconds), never their position. */
  async alerts(id, startSec, endSec) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new PajError(CODES.BAD_ANSWER, 'Not a tracker id');
    }
    const value = await this.call('GET', `/api/v1/customnotifications/${id}`, {
      query: {
        startDate: String(startSec),
        endDate: String(endSec),
        noOfNotification: String(LIMITS.ALERTS_PER_TRACKER),
      },
    });
    const alerts = parseAlerts(value);
    if (!alerts) throw new PajError(CODES.BAD_ANSWER, 'Not a list of alerts');
    return alerts;
  }
}
