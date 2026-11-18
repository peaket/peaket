// gw-fan 구매 경로의 입장 토큰 확인 kind 시험(BUILD_ORDER HOT-400 묶음 BAT-057 계획 §6 K1~K12·K14~K18, S-T28 ①·Q-T69 ②, docs/security/asvs/queue-admission.md 9.1.3·9.2.1·9.2.2·9.2.3).
// 정본: docs/infra.md §4.1 '입장 토큰 확인'(차례 ①~⑨, 401 admission-token-invalid·403, 사전 요청 건너뜀, 키 출처 칸 무시, 거절 응답의 교차 출처 머리, 남는 차이),
// docs/features/queue-admission.md §6 '입장 토큰 공개키 묶음과 게이트웨이 확인'('받는 쪽의 끝 시각', '묶음 배포'), docs/features/seat-hold.md §2 '구매 세션은 회차 하나에 묶인다',
// ADR-0288 결정 4~6. 값(401 본문·WWW-Authenticate·403 본문·2,048자·typ·aud·발급자)은 정본에서 그대로 적는다(Lua·cluster.mjs에서 가져오지 않는다).
// 바탕은 BAT-055의 손님 도구와 접속 정보(gateway-client.mjs 머리 주석)이고, 입장 토큰 시험 키 넷은 접속 정보의 admission 칸이다. 그 칸이 없는 접속 정보(BAT-057 전)에서는
// 그 키를 쓰는 시험이 '접속 정보에 admission 칸이 없다'로 단언 실패한다. 키 없이 볼 수 있는 사례(공격자 키·팬 토큰·꼴이 틀린 값·토큰 없음)는 그 단언보다 앞에 둔다.
// '대역 백엔드에 닿지 않음'은 응답이 대역(echo)의 JSON이 아님으로, 거절이 있었다는 것은 접근 로그의 그 경로 줄로 본다. 키 목록을 바꾸는 시험(K13)은 gateway-admission-fault.e2e.mjs다.
// 실행(저장소 뿌리, Docker 차례 잠금을 잡고): PEAKET_CLUSTER=<이름> node tools/local/cluster.mjs up → node tools/local/cluster.mjs gateways →
//   node --test tools/local/e2e/gateway-admission.e2e.mjs (PEAKET_CLUSTER는 같은 값. exp 경계 시험이 kind 노드 시계를 docker exec로 읽는다)
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { CLUSTER } from '../cluster.mjs';
import { accessToken, echoed, edge, loadContract, send, token, waitLogLine } from './gateway-client.mjs';

// ---- 정본 값 ----
const INVALID_BODY = { type: 'https://peaket.example/problems/admission-token-invalid', title: '입장 확인이 끝났습니다', status: 401 };
const INVALID_CHALLENGE = 'Cookie realm="peaket"';
const FORBIDDEN_BODY = { type: 'about:blank', title: 'Forbidden', status: 403 };
const MAX_CHARS = 2048;
const TYP = 'admission+jwt';
const AUD = 'purchase';
const ISSUER = 'https://queue.peaket.example';
const HSTS = 'max-age=31536000; includeSubDomains';

const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const EVENT = `e2e-${RUN}`;
let c;
let n = 0;
const nextSub = () => `adm-${RUN}-${++n}`;
const nextIp = () => `203.0.113.${1 + (n++ % 250)}`;

before(() => {
  c = loadContract();
});

/** 입장 토큰 시험 키(접속 정보 admission). 없으면 단언으로 실패한다(BAT-057 전의 접속 정보) */
function keys() {
  assert.ok(c.admission, '접속 정보에 admission 칸이 없다(입장 토큰 시험 키 넷, BAT-057 계획 §5): node tools/local/cluster.mjs gateways가 만들지 않았다');
  for (const k of ['current', 'next']) assert.ok(c.admission[k]?.kid && c.admission[k]?.d, `admission.${k}이 개인 JWK가 아니다`);
  for (const k of ['previous', 'expired']) assert.ok(c.admission[k]?.jwk?.kid && Number.isInteger(c.admission[k]?.until), `admission.${k}이 { jwk, until }이 아니다`);
  assert.equal(c.admission.issuer, ISSUER, '접속 정보의 입장 토큰 발급자');
  return { current: c.admission.current, next: c.admission.next, previous: c.admission.previous.jwk, expired: c.admission.expired.jwk };
}

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const privKey = (jwk) => createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, format: 'jwk' });
/** 머리·본문을 그대로 서명한다(ES256, r‖s 64바이트) */
function signed(jwk, header, body) {
  const input = `${b64(header)}.${b64(body)}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key: privKey(jwk), dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
/** 이 시험이 만든 공격자 키(목록 밖) */
function attackerJwk(kid) {
  const j = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  return { kty: 'EC', crv: 'P-256', x: j.x, y: j.y, d: j.d, kid };
}
/** 정상 클레임(queue-svc가 싣는 꼴). over의 undefined는 그 칸을 뺀다 */
function claims(event, over = {}, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const sub = `acct-${RUN}`;
  return { iss: ISSUER, sub, aud: AUD, jti: randomUUID(), sid: `s-${sub}`, event, jny: randomUUID(), iat, exp: iat + 600, ...over };
}
/** 그 키로 서명한 입장 토큰. header·claims로 칸을 바꾼다 */
const admission = (jwk, event, { header = {}, over = {}, nowMs } = {}) => signed(jwk, { alg: 'ES256', typ: TYP, kid: jwk.kid, ...header }, claims(event, over, nowMs));

/** 구매 경로 요청(팬 토큰 ticket:buy는 늘 맞게 싣는다. adm이 undefined면 X-Admission-Token을 싣지 않는다, 배열이면 여러 줄) */
function buy(method, path, adm, { origin, fan = true, extra = {} } = {}) {
  const sub = nextSub();
  const headers = edge(c, nextIp(), {
    ...(fan ? { authorization: `Bearer ${accessToken(c, 'gw-fan', sub)}` } : {}),
    ...(adm !== undefined ? { 'x-admission-token': adm } : {}),
    ...(origin ? { origin } : method !== 'GET' && method !== 'OPTIONS' ? { origin: c.origins.www } : {}),
    ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    ...extra,
  });
  return send(c, 'api', { method, path, headers, ...(method === 'POST' ? { body: '{}' } : {}) });
}
const snapshot = (event, adm, o) => buy('GET', `/v1/events/${event}/seatmap-snapshot`, adm, o);

const isEcho = (r) => {
  try {
    echoed(r);
    return true;
  } catch {
    return false;
  }
};
/** 401 admission-token-invalid(정본 본문·WWW-Authenticate)이고 대역에 닿지 않았다 */
function assertInvalid(r, label) {
  assert.equal(r.status, 401, `${label}: 상태 ${r.status} ${r.text.slice(0, 160)}`);
  assert.ok(!isEcho(r), `${label}: 대역 백엔드에 닿았다`);
  assert.match(String(r.headers['content-type'] ?? ''), /^application\/problem\+json\b/, `${label}: 형식`);
  assert.deepEqual(JSON.parse(r.text), INVALID_BODY, `${label}: 본문`);
  assert.equal(r.headers['www-authenticate'], INVALID_CHALLENGE, `${label}: WWW-Authenticate`);
}
/** 403 about:blank이고 대역에 닿지 않았다 */
function assertForbidden(r, label) {
  assert.equal(r.status, 403, `${label}: 상태 ${r.status} ${r.text.slice(0, 160)}`);
  assert.ok(!isEcho(r), `${label}: 대역 백엔드에 닿았다`);
  assert.match(String(r.headers['content-type'] ?? ''), /^application\/problem\+json\b/, `${label}: 형식`);
  assert.deepEqual(JSON.parse(r.text), FORBIDDEN_BODY, `${label}: 본문`);
}
/** 대역에 닿았고 대역이 받은 X-Admission-Token이 보낸 값 그대로다 */
function assertPassed(r, adm, label) {
  assert.ok(r.status < 400, `${label}: 상태 ${r.status} ${r.text.slice(0, 160)}`);
  const h = echoed(r);
  if (typeof adm === 'string') assert.equal(h['x-admission-token'], adm, `${label}: 대역이 받은 X-Admission-Token`);
}

// ===================== S-T28 ① 주소의 회차(⑨) =====================

test('S-T28 ① 회차 A의 입장 토큰으로 회차 B 주소의 스냅샷 GET·홀드 POST·구매 세션 DELETE는 403이고 대역에 닿지 않는다. 경계: 앞부분만 같은 회차(e1·e10 양쪽)와 대소문자', async () => {
  const k = keys();
  const A = `${EVENT}-a1`;
  const B = `${EVENT}-b`;
  const tA = admission(k.current, A);
  for (const [method, path] of [
    ['GET', `/v1/events/${B}/seatmap-snapshot`],
    ['POST', `/v1/events/${B}/holds`],
    ['DELETE', `/v1/events/${B}/purchase-session`],
  ])
    assertForbidden(await buy(method, path, tA), `${method} ${path}`);
  // 앞부분만 같다: 토큰 A(…-a1)로 주소 …-a10, 토큰 …-a10으로 주소 …-a1
  assertForbidden(await snapshot(`${A}0`, tA), '토큰 a1 → 주소 a10');
  assertForbidden(await snapshot(A, admission(k.current, `${A}0`)), '토큰 a10 → 주소 a1');
  // 대소문자: 글자 그대로 견준다
  assertForbidden(await snapshot(A.toUpperCase(), tA), '토큰 소문자 → 주소 대문자');
  // 대조군: 같은 토큰으로 같은 회차 주소는 통과한다(위 403이 토큰 탓이 아니다)
  assertPassed(await snapshot(A, tA), tA, '같은 회차');
  // 거절은 접근 로그에 403 줄로 남는다(보안 이벤트)
  const lines = await waitLogLine(c, 'gw-fan', `/v1/events/${B}/seatmap-snapshot`);
  assert.ok(lines.some((l) => String(l.status) === '403'), `접근 로그의 403 줄: ${JSON.stringify(lines.map((l) => l.status))}`);
});

test('S-T28 ① 같은 회차 주소의 스냅샷 GET·홀드 POST·구매 세션 DELETE는 통과하고 대역이 받은 X-Admission-Token이 보낸 값 그대로다', async () => {
  const E = `${EVENT}-same`;
  // 입장 토큰 확인이 없는 게이트웨이(BAT-057 전)에서도 이 시험은 통과한다(대조군): 그때는 접속 정보에 키가 없어 이 시험이 만든 값을 싣는다
  const t = c.admission ? admission(keys().current, E) : `e2e-admission-${RUN}`;
  for (const [method, path] of [
    ['GET', `/v1/events/${E}/seatmap-snapshot`],
    ['POST', `/v1/events/${E}/holds`],
    ['DELETE', `/v1/events/${E}/purchase-session`],
  ])
    assertPassed(await buy(method, path, t), t, `${method} ${path}`);
});

test('S-T28 ① 주소에 회차가 없는 구매 경로(GET·DELETE /v1/holds/{holdId}, POST …/extension, POST /v1/orders, POST …/payments·…/payment-acceptance)는 회차 대조 없이 통과한다', async () => {
  const t = c.admission ? admission(keys().current, `${EVENT}-other`) : `e2e-admission-${RUN}`;
  const hold = `e2e-hold-${RUN}`;
  const order = `e2e-order-${RUN}`;
  for (const [method, path] of [
    ['GET', `/v1/holds/${hold}`],
    ['DELETE', `/v1/holds/${hold}`],
    ['POST', `/v1/holds/${hold}/extension`],
    ['POST', '/v1/orders'],
    ['POST', `/v1/orders/${order}/payments`],
    ['POST', `/v1/orders/${order}/payment-acceptance`],
  ])
    assertPassed(await buy(method, path, t), t, `${method} ${path}`);
});

// ===================== 9.1.3 키 출처와 kid(②③④) =====================

test('[ASVS v5.0.0-9.1.3] 머리에 jwk(공격자 공개키)·jku·x5u·x5c를 싣고 공격자 키로 서명한 입장 토큰은 401 admission-token-invalid이고 대역에 닿지 않는다', async () => {
  const E = `${EVENT}-k4`;
  const sources = (jwk) => ({ jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: jwk.kid }, jku: 'https://evil.example/jwks.json', x5u: 'https://evil.example/cert.pem', x5c: ['MIIB'] });
  // 키 목록 밖 kid(키 없이도 본다)
  const outside = attackerJwk(`evil-${RUN}`);
  assertInvalid(await snapshot(E, admission(outside, E, { header: sources(outside) })), '공격자 kid + 키 출처 칸');
  // 목록의 kid를 달고 공격자 키로 서명(머리의 jwk를 믿으면 통과한다)
  const k = keys();
  const forged = attackerJwk(k.current.kid);
  assertInvalid(await snapshot(E, admission(forged, E, { header: sources(forged) })), '목록 kid + 공격자 키 + 키 출처 칸');
  assertInvalid(await snapshot(E, admission(forged, E)), '목록 kid + 공격자 키');
  assertPassed(await snapshot(E, admission(k.current, E, { header: sources(forged) })), undefined, '목록 키로 서명 + 키 출처 칸(칸은 읽지 않는다)');
});

test('Q-T69 ② [ASVS v5.0.0-9.1.3] 목록에 없는 kid·kid 없음·글이 아닌 kid·목록의 키로 서명했지만 kid만 모르는 값인 입장 토큰은 401이다', async () => {
  const E = `${EVENT}-k5`;
  const outside = attackerJwk(`not-listed-${RUN}`);
  assertInvalid(await snapshot(E, admission(outside, E)), '목록에 없는 키와 kid');
  const k = keys();
  assertInvalid(await snapshot(E, admission(k.current, E, { header: { kid: `unknown-${RUN}` } })), '목록의 키 + 모르는 kid');
  assertInvalid(await snapshot(E, admission(k.current, E, { header: { kid: undefined } })), 'kid 없음');
  assertInvalid(await snapshot(E, admission(k.current, E, { header: { kid: 7 } })), 'kid 숫자');
  // 다른 목록 키의 kid를 달고 지금 키로 서명(kid로 고른 키로만 확인한다)
  assertInvalid(await snapshot(E, admission(k.current, E, { header: { kid: k.next.kid } })), 'kid는 다음 키, 서명은 지금 키');
  assertPassed(await snapshot(E, admission(k.current, E)), undefined, '대조군');
});

// ===================== 9.2.1 exp(⑧)와 옛 키 끝 시각(③) =====================

/** kind 노드 시계 − 이 PC 시계(밀리초)와 그 불확실성. 프록시는 노드와 같은 시계를 쓴다(docker exec 왕복의 가운데로 잰다, 세 번 가운데 왕복이 가장 짧은 것) */
function nodeClockOffset() {
  let best;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const out = execFileSync('docker', ['exec', `${CLUSTER}-control-plane`, 'date', '+%s%3N'], { encoding: 'utf8' }).trim();
    const t1 = Date.now();
    const m = { offset: Number(out) - (t0 + t1) / 2, half: (t1 - t0) / 2 };
    assert.ok(Number.isFinite(m.offset), `노드 시계를 읽지 못했다: ${out}`);
    if (!best || m.half < best.half) best = m;
  }
  return best;
}
/** 게이트웨이 시계로 한 초의 가운데(400~600ms)가 될 때까지 기다리고 그 초(S)를 돌려준다 */
async function midSecond(offset) {
  for (;;) {
    const g = Date.now() + offset;
    const frac = ((g % 1000) + 1000) % 1000;
    if (frac >= 400 && frac <= 600) return Math.floor(g / 1000);
    await new Promise((r) => setTimeout(r, frac < 400 ? 400 - frac : 1400 - frac));
  }
}

test('[ASVS v5.0.0-9.2.1] exp가 지금 − 1초·지금의 초면 401이고, 다음 초·지금 + 60초는 통과한다(게이트웨이 시계로 한 초의 가운데에 보낸다)', async () => {
  const E = `${EVENT}-k6`;
  const k = keys();
  const { offset, half } = nodeClockOffset();
  // 가운데(±100ms)를 고르므로 시계 차 측정이 ±300ms 안이어야 경계를 바르게 본다
  assert.ok(half <= 300, `노드 시계 차를 ${half}ms 오차로만 쟀다(docker exec가 느리다)`);
  const at = async (dS, label) => {
    const S = await midSecond(offset);
    return [await snapshot(E, admission(k.current, E, { over: { iat: S - 60, exp: S + dS } })), label];
  };
  for (const [dS, label] of [
    [-1, '지금 − 1초'],
    [0, '지금의 초'],
  ]) {
    const [r] = await at(dS, label);
    assertInvalid(r, label);
  }
  for (const [dS, label] of [
    [1, '다음 초'],
    [60, '지금 + 60초'],
  ]) {
    const [r] = await at(dS, label);
    assertPassed(r, undefined, label);
  }
});

test('[ASVS v5.0.0-9.2.1] exp가 없거나 글이거나 소수면 401이다', async () => {
  const E = `${EVENT}-k7`;
  const k = keys();
  const now = Math.floor(Date.now() / 1000);
  for (const [exp, label] of [
    [undefined, 'exp 없음'],
    [String(now + 600), 'exp 글'],
    [now + 600.5, 'exp 소수'],
    [null, 'exp null'],
  ])
    assertInvalid(await snapshot(E, admission(k.current, E, { over: { exp } })), label);
  assertPassed(await snapshot(E, admission(k.current, E, { over: { exp: now + 600 } })), undefined, '대조군 정수 exp');
});

test('Q-T69 ② [ASVS v5.0.0-9.2.1] 지금 키·다음 키·끝 시각이 남은 옛 키의 토큰은 대역에 닿고, 끝 시각이 지난 옛 키의 토큰은 키 목록에 남아 있어도 401이다', async () => {
  const E = `${EVENT}-k8`;
  const k = keys();
  const now = Math.floor(Date.now() / 1000);
  assert.ok(c.admission.previous.until > now, '끝 시각이 남은 옛 키의 끝 시각이 이미 지났다(접속 정보가 오래됐다)');
  assert.ok(c.admission.expired.until < now, '끝 시각이 지난 옛 키의 끝 시각이 아직이다');
  for (const [jwk, label] of [
    [k.current, '지금 키'],
    [k.next, '다음 키'],
    [k.previous, '끝 시각이 남은 옛 키'],
  ]) {
    const t = admission(jwk, E);
    assertPassed(await snapshot(E, t), t, label);
  }
  assertInvalid(await snapshot(E, admission(k.expired, E)), '끝 시각이 지난 옛 키');
  // 끝 시각이 지난 옛 키는 '목록에 없는 키'처럼 늘 거절이다(다른 구매 경로도)
  assertInvalid(await buy('POST', '/v1/orders', admission(k.expired, E)), '끝 시각이 지난 옛 키 POST /v1/orders');
});

// ===================== 9.2.2 typ(⑤)·iss(⑥), 9.2.3 aud(⑦) =====================

test('[ASVS v5.0.0-9.2.2] 입장 키로 서명한 typ at+jwt·없음·ADMISSION+JWT·JWT·admission+jwt 뒤 빈칸은 401이다', async () => {
  const E = `${EVENT}-k9`;
  const k = keys();
  for (const typ of ['at+jwt', undefined, 'ADMISSION+JWT', 'JWT', 'admission+jwt ', 'reauth+jwt']) assertInvalid(await snapshot(E, admission(k.current, E, { header: { typ } })), `typ ${JSON.stringify(typ)}`);
  assertPassed(await snapshot(E, admission(k.current, E)), undefined, '대조군 typ admission+jwt');
});

test('[ASVS v5.0.0-9.2.2] iss가 없거나 다른 값(identity 발급자·끝 빗금·http·대문자)이면 401이다', async () => {
  const E = `${EVENT}-k10`;
  const k = keys();
  for (const iss of [undefined, c.issuer, `${ISSUER}/`, ISSUER.replace('https:', 'http:'), ISSUER.toUpperCase(), ''])
    assertInvalid(await snapshot(E, admission(k.current, E, { over: { iss } })), `iss ${JSON.stringify(iss)}`);
  assertPassed(await snapshot(E, admission(k.current, E, { over: { iss: ISSUER } })), undefined, '대조군');
});

test('[ASVS v5.0.0-9.2.2] 팬 액세스 토큰(팬 키, typ at+jwt)이나 팬 키로 서명한 입장 토큰 꼴을 X-Admission-Token에 넣으면 401이다', async () => {
  const E = `${EVENT}-k11`;
  const sub = nextSub();
  assertInvalid(await snapshot(E, accessToken(c, 'gw-fan', sub)), '팬 액세스 토큰');
  // 팬 키로 서명하고 typ·aud·iss·event를 입장 토큰처럼 꾸민 것(kid가 팬 키라 목록에 없다)
  assertInvalid(await snapshot(E, token(c, 'fan', { sub, iss: ISSUER, aud: AUD, event: E, jti: randomUUID(), sid: `s-${sub}`, jny: randomUUID() }, { typ: TYP })), '팬 키 + 입장 토큰 꼴');
});

test('[ASVS v5.0.0-9.2.3] aud가 없거나 fan·["purchase"]·"purchase "·["purchase","fan"]이면 401이다', async () => {
  const E = `${EVENT}-k12`;
  const k = keys();
  for (const aud of [undefined, 'fan', [AUD], `${AUD} `, [AUD, 'fan'], 'PURCHASE']) assertInvalid(await snapshot(E, admission(k.current, E, { over: { aud } })), `aud ${JSON.stringify(aud)}`);
  assertPassed(await snapshot(E, admission(k.current, E, { over: { aud: AUD } })), undefined, '대조군');
});

// ===================== 사전 요청·교차 출처 머리(ADR-0288 결정 4·6) =====================

test('HOT-400 ADR-0288 결정 4 구매 경로 사전 요청(OPTIONS, 입장 토큰 없음)은 www 출처의 교차 출처 응답을 받는다', async () => {
  const E = `${EVENT}-k14`;
  for (const [method, path] of [
    ['GET', `/v1/events/${E}/seatmap-snapshot`],
    ['POST', `/v1/events/${E}/holds`],
    ['DELETE', `/v1/holds/e2e-hold-${RUN}`],
    ['POST', '/v1/orders'],
  ]) {
    const r = await send(c, 'api', {
      method: 'OPTIONS',
      path,
      headers: edge(c, nextIp(), { origin: c.origins.www, 'access-control-request-method': method, 'access-control-request-headers': 'x-admission-token,content-type' }),
    });
    assert.ok(r.status >= 200 && r.status < 300, `OPTIONS ${path}(${method}): ${r.status} ${r.text.slice(0, 160)}`);
    assert.equal(r.headers['access-control-allow-origin'], c.origins.www, `OPTIONS ${path}: Allow-Origin`);
    assert.equal(r.headers['access-control-allow-credentials'], 'true', `OPTIONS ${path}: Allow-Credentials`);
    assert.match(String(r.headers['access-control-allow-headers'] ?? ''), /x-admission-token/i, `OPTIONS ${path}: Allow-Headers`);
  }
});

test('HOT-400 ADR-0288 결정 6 Lua가 낸 401·403에 www 출처의 교차 출처 머리 넷(Allow-Origin·Allow-Credentials·Vary: Origin·Expose-Headers의 WWW-Authenticate)이 있고, 허용 밖 출처(partner·남의 사이트·null)에는 Allow-Origin·Allow-Credentials가 없다', async () => {
  const E = `${EVENT}-k15`;
  // 401: 입장 토큰 없음(키 없이도 본다)
  const cases = [['401 토큰 없음', (origin) => snapshot(E, undefined, { origin })]];
  if (c.admission) cases.push(['403 다른 회차', (origin) => snapshot(`${E}-other`, admission(keys().current, E), { origin })]);
  for (const [label, call] of cases) {
    const r = await call(c.origins.www);
    assert.ok(r.status === 401 || r.status === 403, `${label}: ${r.status}`);
    assert.ok(!isEcho(r), `${label}: 대역에 닿았다`);
    assert.equal(r.headers['access-control-allow-origin'], c.origins.www, `${label}: Allow-Origin`);
    assert.equal(r.headers['access-control-allow-credentials'], 'true', `${label}: Allow-Credentials`);
    assert.ok(String(r.headers.vary ?? '').split(/\s*,\s*/).some((v) => v.toLowerCase() === 'origin'), `${label}: Vary ${r.headers.vary}`);
    assert.ok(String(r.headers['access-control-expose-headers'] ?? '').split(/\s*,\s*/).some((v) => v.toLowerCase() === 'www-authenticate'), `${label}: Expose-Headers ${r.headers['access-control-expose-headers']}`);
    for (const bad of [c.origins.partner, 'https://evil.example', 'null']) {
      const x = await call(bad);
      assert.ok(x.status === 401 || x.status === 403, `${label} ${bad}: ${x.status}`);
      assert.equal(x.headers['access-control-allow-origin'], undefined, `${label} ${bad}: Allow-Origin`);
      assert.equal(x.headers['access-control-allow-credentials'], undefined, `${label} ${bad}: Allow-Credentials`);
    }
  }
  assert.equal(cases.length, 2, '403 사례를 보려면 접속 정보에 admission 칸이 있어야 한다');
});

// ===================== 차례 ①④와 꼴(docs/infra.md §4.1 '입장 토큰 확인') =====================

/** 정확히 len자인 맞는 입장 토큰(머리·본문에 채움 칸을 더해 맞춘다) */
function tokenOfLength(jwk, event, len) {
  const b64len = (s) => Math.ceil((Buffer.byteLength(s) * 4) / 3);
  for (let hp = 0; hp < 8; hp++)
    for (let bp = 0; bp < len; bp++) {
      const header = { alg: 'ES256', typ: TYP, kid: jwk.kid, ...(hp ? { pad: 'h'.repeat(hp) } : {}) };
      const body = { ...claims(event), pad: 'b'.repeat(bp) };
      const total = b64len(JSON.stringify(header)) + 1 + b64len(JSON.stringify(body)) + 1 + 86;
      if (total === len) return signed(jwk, header, body);
      if (total > len) break;
    }
  throw new Error(`${len}자 토큰을 만들지 못했다`);
}

test('HOT-400 infra §4.1 입장 토큰 확인 ①④ X-Admission-Token 둘·2,049자·JWT 꼴 아님·서명 한 글자 바꿈·머리만 바꿈·본문만 바꿈·alg none·HS256·ES384는 401 admission-token-invalid(WWW-Authenticate: Cookie realm="peaket", 응답 보안 머리)이고, 2,048자 맞는 토큰은 통과한다', async () => {
  const E = `${EVENT}-k16`;
  // 키 없이 볼 수 있는 꼴 틀림
  for (const [v, label] of [
    ['not-a-jwt', '점 없음'],
    ['a.b', '마디 둘'],
    ['a.b.c.d', '마디 넷'],
    ['a..c', '빈 마디'],
    ['a.b.c d', '빈칸'],
    ['a.b.c=', '채움 글자'],
  ])
    assertInvalid(await snapshot(E, v), label);
  const k = keys();
  const good = admission(k.current, E);
  const [h, p, s] = good.split('.');
  const flip = (str, i) => `${str.slice(0, i)}${str[i] === 'A' ? 'B' : 'A'}${str.slice(i + 1)}`;
  const otherHead = b64({ alg: 'ES256', typ: TYP, kid: k.current.kid, x: 1 });
  const otherBody = b64({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), event: `${E}-x` });
  const hs = (() => {
    const head = b64({ alg: 'HS256', typ: TYP, kid: k.current.kid });
    return `${head}.${p}.${createHmac('sha256', Buffer.from(k.current.x, 'base64url')).update(`${head}.${p}`).digest('base64url')}`;
  })();
  const cases = [
    [[good, 'bad.value.here'], '값 둘(맞는 값 + 틀린 값)'],
    [[good, good], '같은 맞는 값 둘'],
    [tokenOfLength(k.current, E, MAX_CHARS + 1), '2,049자'],
    [`${h}.${p}.${flip(s, 10)}`, '서명 한 글자 바꿈'],
    [`${otherHead}.${p}.${s}`, '머리만 바꿈(서명 그대로)'],
    [`${h}.${otherBody}.${s}`, '본문만 바꿈(서명 그대로)'],
    [signed(k.current, { alg: 'none', typ: TYP, kid: k.current.kid }, claims(E)), 'alg none'],
    [hs, 'HS256(공개키 좌표를 비밀로)'],
    [signed(k.current, { alg: 'ES384', typ: TYP, kid: k.current.kid }, claims(E)), 'ES384'],
    [signed(k.current, { typ: TYP, kid: k.current.kid }, claims(E)), 'alg 없음'],
  ];
  for (const [v, label] of cases) {
    const r = await snapshot(E, v);
    assertInvalid(r, label);
    assert.equal(r.headers['strict-transport-security'], HSTS, `${label}: HSTS`);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', `${label}: nosniff`);
  }
  const max = tokenOfLength(k.current, E, MAX_CHARS);
  assert.equal(max.length, MAX_CHARS);
  assertPassed(await snapshot(E, max), max, '2,048자');
  assertPassed(await snapshot(E, good), good, '대조군');
});

test('HOT-400 infra §4.1 입장 토큰 확인 입장 토큰만 있고 팬 토큰이 없으면 401(JWT 확인)이고 대역에 닿지 않는다', async () => {
  const E = `${EVENT}-k17a`;
  const t = c.admission ? admission(keys().current, E) : `e2e-admission-${RUN}`;
  const r = await snapshot(E, t, { fan: false });
  assert.equal(r.status, 401, `${r.status} ${r.text.slice(0, 160)}`);
  assert.ok(!isEcho(r), '대역에 닿았다');
});

test('HOT-400 infra §4.1 입장 토큰 확인 팬 토큰만 있고 입장 토큰이 없으면 401 admission-token-invalid이고 대역에 닿지 않는다(빈 값도 같다)', async () => {
  const E = `${EVENT}-k17b`;
  assertInvalid(await snapshot(E, undefined), '입장 토큰 없음');
  assertInvalid(await snapshot(E, ''), '빈 입장 토큰');
  assertInvalid(await buy('POST', '/v1/orders', undefined), 'POST /v1/orders 입장 토큰 없음');
  // 끊긴 사례가 접근 로그에 401 줄로 남는다
  const lines = await waitLogLine(c, 'gw-fan', `/v1/events/${E}/seatmap-snapshot`);
  assert.ok(lines.some((l) => String(l.status) === '401'), `접근 로그의 401 줄: ${JSON.stringify(lines.map((l) => l.status))}`);
});

test('HOT-400 queue-admission §6 묶음 배포 gw-queue·gw-fan으로 /internal/jwks/admission.json을 부르면 404이고 묶음이 나가지 않는다', async () => {
  for (const host of ['queue', 'api', 'www']) {
    const r = await send(c, host, { path: '/internal/jwks/admission.json', headers: edge(c, nextIp()) });
    assert.equal(r.status, 404, `${host}: ${r.status}`);
    assert.doesNotMatch(r.text, /"keys"\s*:/, `${host}: 공개키 묶음이 나갔다`);
  }
});
