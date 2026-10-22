// -----------------------------------------------------------------------------
// PajError: every failure of a request to the PAJ GPS API, with a code the app
// maps to a status, a pause or a message. Messages never carry the
// credentials, a token, a tracker id, a position nor a URL (the login puts the
// e-mail address and the password in the query, as the API documents it).
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  UNREACHABLE: 'unreachable', // no TCP connection
  TIMEOUT: 'timeout', // no answer in time
  TLS_UNTRUSTED: 'tls_untrusted', // certificate refused
  HTTP: 'http', // an HTTP status other than 2xx (see `status`)
  BAD_ANSWER: 'bad_answer', // not the JSON expected
  TOO_LARGE: 'too_large', // answer above the size cap
  CLOSED: 'closed', // the client was replaced (new configuration)
  /** The login was refused by the API itself: final, nothing more is sent with these credentials. */
  REFUSED: 'refused',
  /** A new token was refused again on a data request: retried at the next interval. */
  SESSION: 'session',
  /** HTTP 403 not answered by the API (a firewall, a CDN): a long pause. */
  FORBIDDEN: 'forbidden',
});

export class PajError extends Error {
  constructor(code, message, { status, retryAfterMs } = {}) {
    super(message);
    this.name = 'PajError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined && retryAfterMs !== null) this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The answer is the API's own JSON envelope (`{ "success": ... }` or
 * `{ "error": "<text>" }`), not a page of a proxy or a firewall.
 */
export function envelopeOf(body) {
  try {
    const value = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Object.hasOwn(value, 'success') || Object.hasOwn(value, 'error')) return value;
    return null;
  } catch {
    return null;
  }
}

/** HTTP 429 or a 5xx: every request pauses. */
export const isBusy = (err) =>
  err?.code === CODES.HTTP && (err.status === 429 || err.status >= 500);
