// 로컬 gw-fan 대역(local-fan-gateway.mjs)과 가짜 API(mock-api.mjs)가 진짜 gw-fan보다 넓지 않은지(웨이브 끝 리뷰 W7-WIR-06, BUILD_ORDER HOT-400).
// 화면 시험은 gw-fan 대신 이 대역을 쓰므로, 대역이 사전 요청에서 더 많은 머리를 허용하거나 ticket:buy를 보지 않으면 운영에서 막힐 요청이 로컬·CI에서는 통과한다.
// 기준은 deploy/gateways/gw-fan.yaml의 api 호스트 정책 값이다(그 YAML을 읽어 견준다. 값을 시험에 옮겨 적지 않는다).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { parseAllDocuments } from 'yaml';
import { startLocalFanGateway } from './local-fan-gateway.mjs';
import { startMockApi } from './mock-api.mjs';

const WEB = 'http://localhost:3000';
const ISSUER = 'https://identity.peaket.test';
const GW_FAN = fileURLToPath(new URL('../../../deploy/gateways/gw-fan.yaml', import.meta.url));
const docs = parseAllDocuments(readFileSync(GW_FAN, 'utf8'))
  .map((d) => d.toJS())
  .filter(Boolean);
const lc = (s) => String(s).toLowerCase();
const set = (list) => new Set((list ?? []).map(lc));
const route = (name) => docs.find((o) => o.kind === 'HTTPRoute' && o.metadata?.name === name);
/** 그 라우트를 겨눈 SecurityPolicy */
const security = (name) => docs.find((o) => o.kind === 'SecurityPolicy' && (o.spec?.targetRefs ?? []).some((t) => t.kind === 'HTTPRoute' && t.name === name));
/** 경로를 받는 api 호스트 라우트 이름(정의의 경로 매치로 찾는다) */
function routeNameFor(method, path) {
  const candidates = docs.filter((o) => o.kind === 'HTTPRoute' && (o.spec?.hostnames ?? []).includes('api.peaket.example'));
  let best;
  for (const r of candidates)
    for (const rule of r.spec?.rules ?? []) {
      if (!(rule.backendRefs ?? []).length) continue;
      for (const m of rule.matches ?? [{}]) {
        if (m.method && m.method !== method) continue;
        const v = m.path?.value ?? '/';
        const t = m.path?.type ?? 'PathPrefix';
        const ok = t === 'Exact' ? v === path : t === 'RegularExpression' ? new RegExp(`^${v}$`).test(path) : path === v || path.startsWith(v.endsWith('/') ? v : `${v}/`) || v === '/';
        const score = t === 'Exact' ? 1e6 : t === 'RegularExpression' ? 1 : 10 + v.length;
        if (ok && (!best || score > best.score)) best = { name: r.metadata.name, score };
      }
    }
  assert.ok(best, `gw-fan api에 ${method} ${path} 라우트가 없다`);
  return best.name;
}
const seconds = (d) => {
  const m = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?$/.exec(String(d));
  return Number(m?.[1] ?? 0) * 3600 + Number(m?.[2] ?? 0) * 60 + Number(m?.[3] ?? 0);
};

let upstream;
let gw;
let keys;
const seen = [];

before(async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  keys = { privateKey, jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: 'fan-1', alg: 'ES256', use: 'sig' }] } };
  upstream = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  gw = await startLocalFanGateway({ port: 0, identityUrl: base, purchaseUrl: base, webOrigin: WEB, jwks: keys.jwks, issuer: ISSUER, env: { PEAKET_ENV: 'ci' } });
});
after(async () => {
  await gw?.close();
  await new Promise((r) => upstream.close(r));
});

const token = (scope) =>
  new SignJWT({ sid: 's-1', scope, pid: 'pid-1' })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'fan-1' })
    .setIssuer(ISSUER)
    .setAudience('fan')
    .setSubject('acc-1')
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(keys.privateKey);

const CASES = [
  ['POST', '/v1/events/e2e-id-10/holds'],
  ['GET', '/v1/events/e2e-id-10/seatmap-snapshot'],
  ['POST', '/v1/orders'],
  ['POST', '/v1/identity/access-tokens'],
];

test('W7-WIR-06 로컬 gw-fan 대역의 사전 요청 허용 머리·Max-Age가 deploy/gateways/gw-fan.yaml의 그 라우트 정책 값과 같다', async () => {
  for (const [method, path] of CASES) {
    const cors = security(routeNameFor(method, path))?.spec?.cors;
    assert.ok(cors, `${method} ${path}: 정의에 CORS가 없다`);
    const r = await fetch(`${gw.url}${path}`, { method: 'OPTIONS', headers: { origin: WEB, 'access-control-request-method': method, 'access-control-request-headers': 'content-type' } });
    assert.ok(r.status === 204 || r.status === 200, `${method} ${path}: 사전 요청 ${r.status}`);
    const allow = set((r.headers.get('access-control-allow-headers') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    assert.deepEqual([...allow].sort(), [...set(cors.allowHeaders)].sort(), `${method} ${path}: 허용 머리`);
    assert.equal(Number(r.headers.get('access-control-max-age')), seconds(cors.maxAge), `${method} ${path}: Max-Age`);
  }
});

test('W7-WIR-06 로컬 gw-fan 대역의 노출 머리가 deploy/gateways/gw-fan.yaml의 그 라우트 정책 값과 같다', async () => {
  const at = await token('ticket:buy');
  for (const [method, path] of CASES) {
    const cors = security(routeNameFor(method, path))?.spec?.cors;
    const r = await fetch(`${gw.url}${path}`, { method, headers: { origin: WEB, cookie: `__Secure-peaket_at=${at}`, 'content-type': 'application/json', 'x-admission-token': 'e2e' }, ...(method === 'GET' ? {} : { body: '{}' }) });
    const expose = set((r.headers.get('access-control-expose-headers') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    assert.deepEqual([...expose].sort(), [...set(cors.exposeHeaders)].sort(), `${method} ${path}: 노출 머리`);
  }
});

test('W7-WIR-06 로컬 gw-fan 대역도 구매 경로에서 ticket:buy가 없으면 403이고 purchase로 넘기지 않는다(gw-fan-buy 인가와 같다)', async () => {
  const buy = security(routeNameFor('POST', '/v1/events/e2e-id-10/holds'));
  // 정의가 구매 경로에 ticket:buy를 요구하는지 먼저 본다(이 시험의 기준)
  assert.match(JSON.stringify(buy?.spec?.authorization ?? {}), /ticket:buy/);
  const without = await token('profile');
  for (const [method, path] of [['POST', '/v1/events/e2e-id-10/holds'], ['POST', '/v1/orders']]) {
    const before = seen.length;
    const r = await fetch(`${gw.url}${path}`, { method, headers: { origin: WEB, cookie: `__Secure-peaket_at=${without}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 403, `${method} ${path}: ticket:buy 없음`);
    assert.equal(seen.length, before, `${method} ${path}: purchase로 넘겼다`);
  }
  const ok = await fetch(`${gw.url}/v1/orders`, { method: 'POST', headers: { origin: WEB, cookie: `__Secure-peaket_at=${await token('ticket:buy')}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(ok.status, 200, 'ticket:buy 있음');
});

test('W7-WIR-06 가짜 API는 사전 요청의 요청 머리를 그대로 허용하지 않는다', async () => {
  const server = await startMockApi({ port: 0 });
  try {
    const { port } = server.address();
    const r = await fetch(`http://127.0.0.1:${port}/v1/events/e2e-id-10/holds`, { method: 'OPTIONS', headers: { origin: WEB, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-not-in-openapi, x-evil' } });
    const allow = set((r.headers.get('access-control-allow-headers') ?? '').split(',').map((s) => s.trim()));
    for (const h of ['x-not-in-openapi', 'x-evil']) assert.ok(!allow.has(h), `가짜 API가 ${h}를 허용한다`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
