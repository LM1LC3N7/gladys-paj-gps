// -----------------------------------------------------------------------------
// A fake PAJ GPS API (in memory): the routes the integration uses, behind the
// login and the bearer token. The shapes come from pajgps-api 0.4.1 (MIT, its
// models and the OpenAPI description of its repository); never checked
// against a real account (TODO.md). Test data is made up.
// -----------------------------------------------------------------------------

import { CODES, PajError } from '../../src/paj/errors.js';

export const EMAIL = 'someone@example.org';
export const PASSWORD = 's3cr3t-Pa55';
/** 2026-10-22T08:00:00Z, the clock of the tests. */
export const T0 = Date.parse('2026-10-22T08:00:00Z');
export const sec = (ms) => Math.floor(ms / 1000);

export function device(id, name, extra = {}) {
  return {
    id,
    name,
    imei: '867530900000001',
    telefonnummer: '+491700000000',
    share_link: 'https://share.example.org/abcdef',
    status: 1,
    device_models: [{ standalone_battery: 1, alarm_volt: 0 }],
    deleted_at: null,
    ...extra,
  };
}

export function point(id, { lat = 48.85661, lng = 2.35222, at = T0 - 60_000, ...rest } = {}) {
  return {
    id: `p${id}-${at}`,
    lat,
    lng,
    direction: 58,
    dateunix: sec(at),
    battery: 58,
    speed: 0,
    iddevice: id,
    steps: 0,
    heartbeat: 0,
    accuracy: 0,
    wifi: null,
    note: null,
    upt: null,
    wzp: false,
    ...rest,
  };
}

export function alert(id, deviceId, type, at, extra = {}) {
  return {
    id,
    iddevice: deviceId,
    icon: 'icon-info',
    bezeichnung: 'Alarm',
    meldungtyp: type,
    dateunix: sec(at),
    lat: 50.7983971,
    lng: 7.6081834,
    isread: 0,
    radiusin: 0,
    radiusout: 0,
    zuendon: 0,
    zuendoff: 0,
    push: 0,
    suppressed: 0,
    ...extra,
  };
}

export const GOLF = 1272814;
export const REX = 555001;

export function createFakePaj() {
  let counter = 0;
  const fake = {
    requests: [],
    devices: [device(GOLF, 'Golf'), device(REX, 'Rex', { device_models: [] })],
    points: {
      [GOLF]: point(GOLF),
      [REX]: point(REX, { lat: 45.764, lng: 4.8357, speed: 12, battery: undefined }),
    },
    /** id -> alerts of that tracker. */
    alerts: {},
    /** { status, headers, body, path } answered once each (FIFO); `path` limits it to a prefix. */
    failures: [],
    /** path prefix -> HTTP status answered every time. */
    broken: {},
    unreachable: false,
    tokens: new Set(),
    refreshTokens: new Set(),
    /** The refresh tokens are refused (the login still works). */
    refuseRefresh: false,
    /** Every token is refused, even new ones. */
    refuseAllTokens: false,
    password: PASSWORD,
    /** A promise the API waits for before answering (a slow reading). */
    gate: null,
  };

  const json = (status, value, headers = {}) => ({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify(value)),
  });
  const issue = () => {
    counter += 1;
    const token = `tok-${counter}-abcdef`;
    const refresh = `ref-${counter}-abcdef`;
    fake.tokens.add(token);
    fake.refreshTokens.add(refresh);
    return json(200, { success: { token, refresh_token: refresh, userID: 1, routeIcon: 'x' } });
  };
  const unauthenticated = () => json(401, { error: 'Unauthenticated' });

  function answer(url, method, headers, body) {
    const broken = Object.entries(fake.broken).find(([path]) => url.pathname.startsWith(path));
    if (broken) return json(broken[1], { error: 'broken' });
    const index = fake.failures.findIndex((f) => !f.path || url.pathname.startsWith(f.path));
    if (index >= 0) {
      const [f] = fake.failures.splice(index, 1);
      if (f.body !== undefined) {
        return { status: f.status, headers: f.headers ?? {}, body: Buffer.from(f.body) };
      }
      return json(f.status, { error: 'failure' }, f.headers ?? {});
    }
    const q = url.searchParams;
    if (url.pathname === '/api/v1/login' && method === 'POST') {
      return q.get('email') === EMAIL && q.get('password') === fake.password
        ? issue()
        : unauthenticated();
    }
    if (url.pathname === '/api/v1/updatetoken' && method === 'POST') {
      if (fake.refuseRefresh || !fake.refreshTokens.has(q.get('refresh_token') ?? '')) {
        return unauthenticated();
      }
      fake.refreshTokens.delete(q.get('refresh_token'));
      return issue();
    }
    const bearer = (headers.authorization ?? '').replace(/^Bearer /, '');
    if (fake.refuseAllTokens || !fake.tokens.has(bearer)) return unauthenticated();
    if (url.pathname === '/api/v1/device' && method === 'GET') {
      return json(200, { success: fake.devices, number_of_records: fake.devices.length });
    }
    if (url.pathname === '/api/v1/trackerdata/getalllastpositions' && method === 'POST') {
      const ids = JSON.parse(body ?? '{}').deviceIDs ?? [];
      const list = ids.map((id) => fake.points[id]).filter(Boolean);
      return json(200, { success: list, number_of_records: list.length });
    }
    const m = /^\/api\/v1\/customnotifications\/(\d+)$/.exec(url.pathname);
    if (m && method === 'GET') {
      const start = Number(q.get('startDate'));
      const end = Number(q.get('endDate'));
      const list = (fake.alerts[m[1]] ?? [])
        .filter((a) => a.dateunix >= start && a.dateunix <= end)
        .slice(0, Number(q.get('noOfNotification')) || 50);
      return json(200, { success: list, number_of_records: list.length });
    }
    return json(404, { error: 'Resource not found' });
  }

  /** The transport of src/paj/http.js, in memory. */
  fake.request = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const method = options.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    fake.requests.push({ url: rawUrl, path: url.pathname, method, headers, body: options.body });
    if (fake.gate) await fake.gate;
    if (fake.unreachable) throw new PajError(CODES.UNREACHABLE, 'ECONNREFUSED');
    return answer(url, method, headers, options.body);
  };

  fake.paths = () => fake.requests.map((r) => r.path);
  fake.count = (path) => fake.requests.filter((r) => r.path.startsWith(path)).length;
  /** Every token issued so far stops working (expired). */
  fake.expire = () => fake.tokens.clear();

  return fake;
}
