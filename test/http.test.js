// -----------------------------------------------------------------------------
// The transport (src/paj/http.js) and the client against loopback http
// servers: deadline, size cap, no redirect, no URL in an error; what a
// refusal of the login is, and the renewal of the token without a loop.
// -----------------------------------------------------------------------------

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PajClient, retryAfterMs } from '../src/paj/client.js';
import { CODES, PajError, isBusy } from '../src/paj/errors.js';
import { httpRequest } from '../src/paj/http.js';

let server;
let base;
const seen = [];
/** path -> [status, headers, body] answered by the loopback server. */
const routes = new Map();

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: `${Buffer.concat(chunks)}`,
      });
      const path = req.url.split('?')[0];
      if (path === '/slow') return; // never answers
      if (path === '/big') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(Buffer.alloc(4096, 0x20));
        return;
      }
      if (path === '/redirect') {
        res.writeHead(302, { location: 'https://elsewhere.example.org/' });
        res.end();
        return;
      }
      const route = routes.get(path);
      if (route) {
        const [status, headers, body] = typeof route === 'function' ? route(req) : route;
        res.writeHead(status, headers);
        res.end(body);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html>Not found</html>');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

const loopback = (url, options) => httpRequest(url, { ...options, allowHttp: true });
const JSON_TYPE = { 'content-type': 'application/json' };
const ok = (value) => [200, JSON_TYPE, JSON.stringify(value)];
const client = () =>
  new PajClient({
    email: 'user@example.org',
    password: 'pä ss&word=1',
    request: loopback,
    apiUrl: base,
  });

test('plain http is refused unless the loopback tests allow it', async () => {
  await assert.rejects(httpRequest(`${base}/x`, { timeout: 1000, maxBytes: 100 }), (err) => {
    assert.equal(err.code, CODES.BAD_ANSWER);
    assert.ok(!err.message.includes('127.0.0.1'));
    return true;
  });
});

test('a deadline, a size cap, no redirect followed; no URL in the errors', async () => {
  await assert.rejects(
    loopback(`${base}/slow?password=secret`, { timeout: 200, maxBytes: 100 }),
    (err) => {
      assert.equal(err.code, CODES.TIMEOUT);
      assert.ok(!err.message.includes('secret') && !err.message.includes('slow'));
      return true;
    },
  );
  await assert.rejects(loopback(`${base}/big`, { timeout: 2000, maxBytes: 1000 }), {
    code: CODES.TOO_LARGE,
  });
  const redirect = await loopback(`${base}/redirect`, { timeout: 2000, maxBytes: 1000 });
  assert.equal(redirect.status, 302, 'given back, not followed');
  await assert.rejects(
    loopback('http://127.0.0.1:1/x?password=secret', { timeout: 2000, maxBytes: 100 }),
    (err) =>
      err instanceof PajError && err.code === CODES.UNREACHABLE && !err.message.includes('secret'),
  );
});

test('the login: credentials in the query, the token as a bearer, a JSON body for positions', async () => {
  routes.set('/api/v1/login', ok({ success: { token: 'T1', refresh_token: 'R1', userID: 3 } }));
  routes.set('/api/v1/device', (req) =>
    req.headers.authorization === 'Bearer T1'
      ? ok({ success: [{ id: 7, name: 'T', device_models: [{ standalone_battery: 1 }] }] })
      : [401, JSON_TYPE, '{"error":"Unauthenticated"}'],
  );
  routes.set('/api/v1/trackerdata/getalllastpositions', ok({ success: [] }));
  const paj = client();
  paj.beginReading();
  const devices = await paj.devices();
  assert.deepEqual(devices, [{ id: 7, name: 'T', hasBattery: true }]);
  const login = seen.find((s) => s.url.startsWith('/api/v1/login'));
  assert.equal(login.method, 'POST');
  const query = new URL(login.url, base).searchParams;
  assert.equal(query.get('email'), 'user@example.org');
  assert.equal(query.get('password'), 'pä ss&word=1');
  assert.equal(login.headers.authorization, undefined);
  await paj.lastPositions([7]);
  const positions = seen.at(-1);
  assert.equal(positions.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(positions.body), { deviceIDs: [7], fromLastPoint: false });
  assert.match(positions.headers['user-agent'], /^gladys-paj-gps\//);
  paj.close();
  await assert.rejects(paj.devices(), { code: CODES.CLOSED });
});

test('what a refusal of the login is', async () => {
  const cases = [
    [[401, JSON_TYPE, '{"error":"Unauthenticated"}'], CODES.REFUSED],
    [[400, JSON_TYPE, '{"error":"Bad request"}'], CODES.REFUSED],
    [[401, { 'content-type': 'text/html' }, '<html>no</html>'], CODES.REFUSED],
    [ok({ error: 'Invalid credentials' }), CODES.REFUSED],
    [[403, { 'content-type': 'text/html' }, '<html>Forbidden</html>'], CODES.FORBIDDEN],
    [[429, { 'retry-after': '120' }, ''], CODES.HTTP],
    [[503, {}, ''], CODES.HTTP],
    [[404, { 'content-type': 'text/html' }, '<html>Not found</html>'], CODES.HTTP],
    [ok({ success: { token: 'bad token with spaces' } }), CODES.BAD_ANSWER],
    [[200, { 'content-type': 'text/html' }, '<html>portal</html>'], CODES.BAD_ANSWER],
  ];
  for (const [answer, code] of cases) {
    routes.set('/api/v1/login', answer);
    const paj = client();
    paj.beginReading();
    await assert.rejects(paj.devices(), (err) => {
      assert.equal(err.code, code, `${answer[0]} ${answer[2]}`);
      return true;
    });
  }
  routes.set('/api/v1/login', [429, { 'retry-after': '120' }, '']);
  const paj = client();
  paj.beginReading();
  await assert.rejects(paj.devices(), (err) => {
    assert.equal(err.retryAfterMs, 120_000);
    assert.equal(isBusy(err), true);
    return true;
  });
});

test('a token refused: one renewal per reading (refresh token, then password), never a loop', async () => {
  let logins = 0;
  let refreshes = 0;
  let valid = 'T1';
  routes.set('/api/v1/login', () => {
    logins += 1;
    valid = `L${logins}`;
    return ok({ success: { token: valid, refresh_token: `R${logins}` } });
  });
  routes.set('/api/v1/updatetoken', () => {
    refreshes += 1;
    return [401, JSON_TYPE, '{"error":"Unauthenticated"}'];
  });
  routes.set('/api/v1/device', (req) =>
    req.headers.authorization === `Bearer ${valid}`
      ? ok({ success: [] })
      : [401, JSON_TYPE, '{"error":"Unauthenticated"}'],
  );
  const paj = client();
  paj.beginReading();
  await paj.devices();
  assert.equal(logins, 1);
  // The token expires: refresh refused, then one login.
  valid = 'expired-for-good';
  paj.beginReading();
  routes.set('/api/v1/login', () => {
    logins += 1;
    return ok({ success: { token: `L${logins}`, refresh_token: `R${logins}` } });
  });
  await assert.rejects(paj.devices(), { code: CODES.SESSION });
  assert.equal(refreshes, 1);
  assert.equal(logins, 2);
  // Within the same reading, no other renewal.
  await assert.rejects(paj.devices(), { code: CODES.SESSION });
  assert.equal(refreshes, 1);
  assert.equal(logins, 2);
});

test('Retry-After in seconds or as a date', () => {
  assert.equal(retryAfterMs('120'), 120_000);
  assert.equal(
    retryAfterMs('Thu, 22 Oct 2026 08:10:00 GMT', Date.parse('2026-10-22T08:00:00Z')),
    600_000,
  );
  assert.equal(retryAfterMs('soon'), null);
  assert.equal(retryAfterMs(undefined), null);
});

test('an alert request needs a numeric tracker id', async () => {
  const paj = client();
  await assert.rejects(paj.alerts('../x', 1, 2), { code: CODES.BAD_ANSWER });
});
