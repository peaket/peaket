// 로컬 게이트웨이 대역(scripts/local-fan-gateway.mjs, docs/features/identity.md §5 '로컬 게이트웨이 대역', BUILD_ORDER BOT-010).
// 앞에 대역을 띄우고 뒤에 받은 요청을 기록하는 가짜 identity-svc를 둔다.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { startLocalFanGateway } from './local-fan-gateway.mjs';

const WEB = 'http://localhost:3000';
const ISSUER = 'https://identity.peaket.test';
let upstream;
let gw;
let keys;
const seen = [];

before(async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  keys = { privateKey, jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: 'fan-1', alg: 'ES256', use: 'sig' }] } };
  upstream = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === '/v1/identity/gz') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(gzipSync(JSON.stringify({ zipped: true })));
        return;
      }
      if (req.url === '/v1/identity/access-tokens') {
        res.writeHead(204, { 'set-cookie': ['__Secure-peaket_at=new; Path=/; HttpOnly; Secure; SameSite=Strict', '__Secure-peaket_rt=r2; Path=/v1/identity/access-tokens; HttpOnly; Secure; SameSite=Strict'], 'cache-control': 'no-store' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  gw = await startLocalFanGateway({ port: 0, identityUrl: `http://127.0.0.1:${upstream.address().port}`, webOrigin: WEB, jwks: keys.jwks, issuer: ISSUER, env: { PEAKET_ENV: 'ci' } });
});
after(async () => {
  await gw?.close();
  await new Promise((r) => upstream.close(r));
});

const token = (claims = {}, o = {}) =>
  new SignJWT({ sid: 's-1', scope: 'ticket:buy', pid: 'pid-1', ...claims })
    .setProtectedHeader({ alg: 'ES256', typ: o.typ ?? 'at+jwt', kid: 'fan-1' })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? 'fan')
    .setSubject(o.sub ?? 'acc-1')
    .setIssuedAt()
    .setExpirationTime(o.exp ?? '15m')
    .sign(keys.privateKey);
const call = (path, init = {}) => fetch(`${gw.url}${path}`, init);
const last = () => seen.at(-1);

test('I-T45 맞는 팬 액세스 쿠키면 신원 머리를 실어 identity로 넘기고, 바깥에서 온 신원 머리는 지운다', async () => {
  const at = await token();
  const r = await call('/v1/identity/verifications', {
    method: 'POST',
    headers: { origin: WEB, cookie: `other=1; __Secure-peaket_at=${at}`, 'content-type': 'application/json', 'x-user-id': 'attacker', x_user_scope: 'admin', 'x-session-id': 'evil' },
    body: JSON.stringify({ next: '/' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), WEB);
  assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
  // gw-fan처럼 Date를 노출한다: 화면의 보정 시계가 캐시하지 않는 응답의 Date를 표본으로 쓴다(docs/frontend.md §3.3, BOT-043이 넘긴 것)
  assert.match(r.headers.get('access-control-expose-headers') ?? '', /\bDate\b/);
  const h = last().headers;
  assert.equal(h['x-user-id'], 'acc-1');
  assert.equal(h['x-session-id'], 's-1');
  assert.equal(h['x-user-aud'], 'fan');
  assert.equal(h['x-user-scope'], 'ticket:buy');
  assert.equal(h['x-user-pid'], 'pid-1');
  assert.equal(h.x_user_scope, undefined);
  assert.equal(h.cookie, undefined, '갱신 경로가 아니면 쿠키를 넘기지 않는다');
  assert.equal(last().body, JSON.stringify({ next: '/' }));
});

test('I-T45 틀린 토큰(서명·typ·iss·aud·만료·머리에 못 싣는 글자)은 신원 없이 넘긴다', async () => {
  const other = await generateKeyPair('ES256');
  const forged = await new SignJWT({ sid: 's-1' }).setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'fan-1' }).setIssuer(ISSUER).setAudience('fan').setSubject('acc-1').setExpirationTime('15m').sign(other.privateKey);
  for (const at of [
    forged,
    await token({}, { typ: 'reauth+jwt' }),
    await token({}, { iss: 'https://evil.example' }),
    await token({}, { aud: 'ops' }),
    await token({}, { exp: Math.floor(Date.now() / 1000) - 10 }),
    await token({ sid: 's 1\r\nx-user-id: root' }),
    'not-a-jwt',
  ]) {
    const r = await call('/v1/identity/verifications/x/result', { headers: { cookie: `__Secure-peaket_at=${at}` } });
    assert.equal(r.status, 200);
    assert.equal(last().headers['x-user-id'], undefined);
    assert.equal(last().headers['x-session-id'], undefined);
  }
});

test('I-T45 쓰기 요청은 Origin이 소비자 웹 출처여야 하고, CORS는 그 출처 하나에만 연다 [ASVS v5.0.0-3.5.1]', async () => {
  const n = seen.length;
  for (const origin of [undefined, 'https://evil.example', 'null']) {
    const r = await call('/v1/identity/verifications', { method: 'POST', headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(seen.length, n, '막은 요청은 넘기지 않는다');
  const pre = await call('/v1/identity/verifications', { method: 'OPTIONS', headers: { origin: WEB, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), WEB);
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  assert.match(pre.headers.get('access-control-allow-headers'), /content-type/);
  const bad = await call('/v1/identity/verifications', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(bad.status, 403);
});

test('I-T45 토큰 갱신 경로에만 쿠키를 넘기고, identity가 준 쿠키 둘을 그대로 돌려준다', async () => {
  const r = await call('/v1/identity/access-tokens', { method: 'POST', headers: { origin: WEB, cookie: '__Secure-peaket_rt=r1; __Secure-peaket_at=old' } });
  assert.equal(r.status, 204);
  assert.equal(last().headers.cookie, '__Secure-peaket_rt=r1; __Secure-peaket_at=old');
  assert.equal(r.headers.getSetCookie().length, 2);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('I-T45 identity 경로가 아니거나 Host가 루프백이 아니면 받지 않고, local·ci에서만 127.0.0.1에 묶는다', async () => {
  assert.equal((await call('/v1/orders')).status, 404);
  // DNS 리바인딩: 다른 이름으로 이 포트에 닿은 요청
  const port = new URL(gw.url).port;
  const viaRebind = await new Promise((resolve, reject) => {
    const q = httpRequest({ host: '127.0.0.1', port, path: '/v1/identity/verifications/x/result', headers: { host: `evil.example:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    q.on('error', reject);
    q.end();
  });
  assert.equal(viaRebind, 421);
  assert.equal(new URL(gw.url).hostname, '127.0.0.1');
  for (const env of [{ PEAKET_ENV: 'prod' }, { PEAKET_ENV: 'demo' }, {}]) {
    await assert.rejects(startLocalFanGateway({ port: 0, identityUrl: 'http://127.0.0.1:1', webOrigin: WEB, jwks: keys.jwks, issuer: ISSUER, env }), /local·ci/);
  }
});

test('I-T45 응답에 nosniff를 붙이고, identity가 Cache-Control을 주지 않으면 no-store를 붙인다', async () => {
  const r = await call('/v1/identity/verifications/x/result');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('I-T45 게이트웨이가 정하는 머리(남은 시간·앱 이름·앞단 주소·추적)는 바깥 값을 지우고, 압축을 푼 본문에는 압축 머리를 달지 않는다(새 맥락 리뷰 L6)', async () => {
  await call('/v1/identity/verifications/x/result', {
    headers: { 'x-peaket-deadline-ms': '999999', 'x-peaket-app': 'evil', 'x-forwarded-for': '1.2.3.4', forwarded: 'for=1.2.3.4', 'x-real-ip': '1.2.3.4', traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', tracestate: 'a=b', baggage: 'k=v' },
  });
  const h = last().headers;
  for (const k of ['x-peaket-deadline-ms', 'x-peaket-app', 'x-forwarded-for', 'forwarded', 'x-real-ip', 'traceparent', 'tracestate', 'baggage']) assert.equal(h[k], undefined, k);
  const r = await call('/v1/identity/gz');
  assert.equal(r.headers.get('content-encoding'), null);
  assert.deepEqual(await r.json(), { zipped: true });
});

test('V2 구매 경로는 purchaseUrl로, 나머지는 fallbackUrl로 가고 대역 신원은 쿠키가 없을 때만 실린다. local-dev 입장 경로를 넘긴다', async () => {
  const purchase = [];
  const mk = (sink) => createServer((req, res) => {
    sink.push({ url: req.url, headers: req.headers });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const a = mk(purchase);
  const b = mk([]);
  const c = mk(purchase);
  await Promise.all([a, b, c].map((s) => new Promise((f) => s.listen(0, '127.0.0.1', f))));
  const url = (s) => `http://127.0.0.1:${s.address().port}`;
  const g = await startLocalFanGateway({ identityUrl: 'http://127.0.0.1:1', webOrigin: WEB, jwks: { keys: [] }, issuer: ISSUER, env: { PEAKET_ENV: 'local' }, purchaseUrl: url(a), fallbackUrl: url(b), localAdmissionUrl: url(c), devIdentity: { 'x-user-id': 'dev' } });
  try {
    await fetch(`${g.url}/v1/holds/h1`, { headers: { 'x-user-id': 'attacker' } });
    assert.equal(purchase[0].url, '/v1/holds/h1');
    assert.equal(purchase[0].headers['x-user-id'], 'dev');
    await fetch(`${g.url}/v1/events/e1/seatmap-snapshot`);
    assert.equal(purchase[1].url, '/v1/events/e1/seatmap-snapshot');
    assert.equal((await fetch(`${g.url}/v1/events/e1`)).status, 200);
    assert.equal(purchase.length, 2);
    await fetch(`${g.url}/v1/local-dev/admission`, { method: 'POST', headers: { origin: WEB }, body: '{}' });
    assert.equal(purchase[2].url, '/v1/local-dev/admission');
    const pre = await fetch(`${g.url}/v1/orders`, { method: 'OPTIONS', headers: { origin: WEB } });
    assert.match(pre.headers.get('access-control-allow-headers'), /x-purchase-mac/);
  } finally {
    await g.close();
    for (const s of [a, b, c]) s.close();
  }
});

