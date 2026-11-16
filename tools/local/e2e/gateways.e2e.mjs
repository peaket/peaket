// 게이트웨이 다섯의 kind 통합 시험(BUILD_ORDER HOT-400, 묶음 BAT-055 계획 §6의 'K' 층, docs/infra.md §4.1 'Envoy 게이트웨이의 첫 구현').
// 실제 kind에 올린 Envoy Gateway와 대역 백엔드(echo·공개키 묶음)에 이 PC에서 포트 전달로 닿아, 시험 클라이언트가 CloudFront 몫(원본 확인 머리·끝단 머리·
// x-forwarded-for)을 대신 붙인다. 접속 정보·대역 백엔드의 약속은 gateway-client.mjs 머리에 적었다.
// 시험 값(HSTS·Max-Age 7200·한도 50/100·화면 출처 규칙)은 정본 값을 그대로 적는다. 같은 규칙은 다섯 게이트웨이 각각을 단언한다.
// 실행(저장소 뿌리, Docker 차례 잠금을 잡고): node tools/local/cluster.mjs up && node tools/local/cluster.mjs gateways && node --test tools/local/e2e/gateways.e2e.mjs
// 끝나면 시험이 만든 컨테이너는 docker rm -f -v로 지우고 잠금 폴더를 지운다(PROGRESS 턴 규칙 'Docker 차례').
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  API_CSP,
  AUD_OF,
  BEHIND_CLOUDFRONT,
  GATEWAYS,
  HSTS,
  SCREEN_OF,
  accessLog,
  accessToken,
  blank,
  echoed,
  edge,
  loadContract,
  pool,
  probe,
  send,
  token,
  waitLogLine,
} from './gateway-client.mjs';

const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const EVENT = `e2e-${RUN}`;
let c;
let n = 0;
/** 실행마다 다른 계정(접근 로그 줄을 찾는 표시) */
const nextSub = () => `acc-${RUN}-${++n}`;
/** 실행마다 다른 시청자 IP(문서용 대역) */
const nextIp = () => `203.0.113.${1 + (n++ % 250)}`;
const SENT_TRACE = '0af7651916cd43dd8448eb211c80319c';
const SENT_TRACEPARENT = `00-${SENT_TRACE}-b7ad6b7169203331-01`;
const traceIdOf = (tp) => /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(tp ?? '')?.[1];
/** 바깥 출처(목록 밖 값마다): 다른 화면 셋, 남의 사이트, null, 빈 값 */
const outsideOrigins = (gw) => [...Object.entries(c.origins).filter(([k]) => k !== SCREEN_OF[gw]).map(([, v]) => v), 'https://evil.example', 'null', ''];
const JA4 = () => `t13d1516h2_8daaf6152771_${randomBytes(6).toString('hex')}`; // 36자(JA4 a_b_c 꼴)

before(async () => {
  c = loadContract();
  // 다섯 게이트웨이가 모두 응답하는지(맞는 토큰으로 확인 경로가 백엔드에 닿는다)
  for (const gw of GATEWAYS) {
    const r = await probe(c, gw, { tokenValue: accessToken(c, gw, nextSub()), headers: edge(c, nextIp()), event: EVENT });
    assert.ok(r.status < 400, `${gw} 확인 경로가 ${r.status}: ${r.text.slice(0, 200)}`);
    echoed(r);
  }
});

// ===================== 호스트·내부 경로·TRACE =====================

test('[ASVS v5.0.0-13.4.4] 다섯 게이트웨이가 kind에서 TRACE에 405로 답하고 백엔드로 넘기지 않는다', async () => {
  for (const gw of GATEWAYS) {
    const p = c.probes[gw];
    const r = await send(c, p.host, { method: 'TRACE', path: p.path.replaceAll('{event}', EVENT), headers: edge(c, nextIp()) });
    assert.equal(r.status, 405, `${gw}: ${r.status}`);
    assert.throws(() => echoed(r), `${gw}: TRACE가 백엔드에 닿았다`);
  }
});

test('HOT-400 identity §3 gw-fan으로 /internal/jwks/fan.json을 부르면 404이고 공개키 묶음이 나가지 않는다', async () => {
  for (const host of ['api', 'www']) {
    for (const set of ['fan', 'admin', 'staff']) {
      const r = await send(c, host, { path: `/internal/jwks/${set}.json`, headers: edge(c, nextIp()) });
      assert.equal(r.status, 404, `${host} /internal/jwks/${set}.json: ${r.status}`);
      assert.doesNotMatch(r.text, /"keys"\s*:/, `${host}: 공개키 묶음이 나갔다`);
    }
  }
});

// ===================== 추적 문맥 =====================

test('V-T31 ① 같은 traceparent·baggage로 보낸 1,000건이 gw-fan·gw-queue 뒤에서 모두 다른 trace-id이고 보낸 trace-id·baggage가 백엔드에 닿지 않는다', async () => {
  for (const gw of ['gw-fan', 'gw-queue']) {
    const sub = nextSub();
    const tv = accessToken(c, gw, sub);
    const seen = await pool(1000, 16, async () => {
      const r = await probe(c, gw, { tokenValue: tv, event: EVENT, headers: edge(c, '198.51.100.20', { traceparent: SENT_TRACEPARENT, tracestate: 'peaket=e2e', baggage: 'queue.seq=999,session.id=forged' }) });
      assert.ok(r.status < 400, `${gw}: ${r.status}`);
      return echoed(r);
    });
    const ids = seen.map((h) => traceIdOf(h.traceparent));
    assert.ok(ids.every(Boolean), `${gw}: 백엔드가 게이트웨이가 시작한 traceparent를 받지 않았다(표본 100%)`);
    assert.equal(new Set(ids).size, 1000, `${gw}: trace-id가 겹친다`);
    assert.ok(!ids.includes(SENT_TRACE), `${gw}: 보낸 trace-id를 이었다`);
    for (const h of seen) {
      assert.ok(!(h.baggage ?? '').includes('queue.seq=999') && !(h.baggage ?? '').includes('forged'), `${gw}: baggage가 닿았다`);
      assert.ok(!(h.tracestate ?? '').includes('peaket=e2e'), `${gw}: tracestate가 닿았다`);
      assert.ok(!JSON.stringify(h).includes(SENT_TRACE), `${gw}: 보낸 trace-id가 다른 머리로 닿았다`);
    }
  }
});

test('V-T31 ② gw-fan·gw-partner 앱 서버 경로만 받은 traceparent를 x-peaket-browser-traceparent로 넘기고 api 경로와 다른 게이트웨이는 넘기지 않는다', async () => {
  for (const [gw, host] of [['gw-fan', 'www'], ['gw-partner', 'partner']]) {
    const r = await send(c, host, { path: c.appPaths[gw], headers: edge(c, nextIp(), { traceparent: SENT_TRACEPARENT }) });
    const h = echoed(r);
    assert.equal(h['x-peaket-browser-traceparent'], SENT_TRACEPARENT, `${gw} 앱 서버 경로`);
    assert.notEqual(traceIdOf(h.traceparent), SENT_TRACE, `${gw} 앱 서버 경로: 받은 값을 부모로 이었다`);
    // 바깥에서 지어 보낸 x-peaket-browser-traceparent는 그대로 넘지 않는다
    const forged = `00-${'f'.repeat(32)}-${'1'.repeat(16)}-01`;
    const f = echoed(await send(c, host, { path: c.appPaths[gw], headers: edge(c, nextIp(), { 'x-peaket-browser-traceparent': forged }) }));
    assert.notEqual(f['x-peaket-browser-traceparent'], forged, `${gw}: 지어 보낸 값이 넘었다`);
  }
  for (const gw of GATEWAYS) {
    const h = echoed(await probe(c, gw, { tokenValue: accessToken(c, gw, nextSub()), event: EVENT, headers: edge(c, nextIp(), { traceparent: SENT_TRACEPARENT, 'x-peaket-browser-traceparent': SENT_TRACEPARENT }) }));
    assert.equal(h['x-peaket-browser-traceparent'], undefined, `${gw} 확인 경로(api): x-peaket-browser-traceparent가 넘었다`);
  }
});

// ===================== 신원 머리 =====================

test('HOT-400 identity §3 바깥에서 보낸 신원 머리(X-User-*·X-Session-Id·X-Tenant-Id·밑줄 꼴)는 다섯 게이트웨이 뒤에 닿지 않고 토큰의 값만 실린다', async () => {
  for (const gw of GATEWAYS) {
    const sub = nextSub();
    const forged = {
      'x-user-id': 'forged-user',
      'x-session-id': 'forged-session',
      'x-user-aud': 'ops',
      'x-user-scope': 'ticket:buy ops:admin',
      'x-user-pid': 'forged-pid',
      'x-user-pid-prev': 'forged-pid-prev',
      'x-user-role': 'commander',
      'x-tenant-id': 'forged-tenant',
      x_user_id: 'forged-underscore',
      'x-peaket-app': 'forged-app',
    };
    const h = echoed(await probe(c, gw, { tokenValue: accessToken(c, gw, sub), event: EVENT, headers: edge(c, nextIp(), forged) }));
    assert.equal(h['x-user-id'], sub, `${gw}: x-user-id`);
    assert.equal(h['x-session-id'], `s-${sub}`, `${gw}: x-session-id`);
    assert.equal(h['x-user-aud'], AUD_OF[gw], `${gw}: x-user-aud`);
    for (const k of ['x-user-role', 'x-tenant-id', 'x_user_id']) assert.equal(h[k], undefined, `${gw}: ${k}`);
    assert.ok(!JSON.stringify(h).includes('forged-'), `${gw}: 위조 값이 닿았다 ${JSON.stringify(h)}`);
  }
  // 토큰 없이 보내면 신원 머리가 하나도 없다(공개 경로: gw-fan 토큰 갱신)
  const r = await send(c, 'api', { method: 'POST', path: '/v1/identity/access-tokens', headers: edge(c, nextIp(), { origin: c.origins.www, 'x-user-id': 'forged-user', 'x-session-id': 'forged-session' }) });
  const h = echoed(r);
  for (const k of ['x-user-id', 'x-session-id', 'x-user-aud', 'x-user-scope', 'x-user-pid']) assert.equal(h[k], undefined, `토큰 없음: ${k}`);
});

// ===================== 끝단 신호와 접근 로그 =====================

test('B-T18 ① 원본 확인이 맞는 대기열 요청은 접근 로그 줄의 ja4에 36자 값이, asn에 보낸 값이 실린다', async () => {
  const sub = nextSub();
  const ja4 = JA4();
  assert.equal(ja4.length, 36);
  const h = echoed(await probe(c, 'gw-queue', { tokenValue: accessToken(c, 'gw-queue', sub), event: EVENT, headers: edge(c, nextIp(), { 'cloudfront-viewer-ja4-fingerprint': ja4, 'cloudfront-viewer-asn': '4766' }) }));
  assert.equal(h['cloudfront-viewer-ja4-fingerprint'], ja4, '원본 확인이 맞으면 백엔드가 끝단 머리를 받는다');
  assert.equal(h['x-peaket-origin-verify'], undefined, '원본 확인 머리는 지운 뒤 넘긴다');
  const [line] = await waitLogLine(c, 'gw-queue', sub);
  assert.equal(line.ja4, ja4);
  assert.equal(String(line.ja4).length, 36);
  assert.equal(String(line.asn), '4766');
});

test('B-T18 ② JA4 머리가 없으면 접근 로그의 ja4만 비고 나머지 칸은 그대로다', async () => {
  const sub = nextSub();
  await probe(c, 'gw-queue', { tokenValue: accessToken(c, 'gw-queue', sub), event: EVENT, headers: edge(c, nextIp(), { 'cloudfront-viewer-asn': '9318' }) });
  const [line] = await waitLogLine(c, 'gw-queue', sub);
  assert.ok(blank(line.ja4), `ja4: ${line.ja4}`);
  assert.equal(String(line.asn), '9318');
  // 경로·메서드·상태 칸이 그대로 있다
  const values = Object.values(line).map(String);
  assert.ok(values.includes('GET') || values.includes(c.probes['gw-queue'].method ?? 'GET'), '메서드 칸');
  assert.ok(values.some((v) => v.includes(`/v1/`)), '경로 칸');
});

test('B-T18 ③ 대기열 경로 요청의 접근 로그 edgeBotLabels는 빈다(Bot Control 없음)', async () => {
  const sub = nextSub();
  await probe(c, 'gw-queue', { tokenValue: accessToken(c, 'gw-queue', sub), event: EVENT, headers: edge(c, nextIp(), { 'cloudfront-viewer-ja4-fingerprint': JA4() }) });
  const [line] = await waitLogLine(c, 'gw-queue', sub);
  assert.ok('edgeBotLabels' in line, 'edgeBotLabels 칸이 없다');
  assert.ok(blank(line.edgeBotLabels), `edgeBotLabels: ${line.edgeBotLabels}`);
});

test('B-T18 ④ 원본 확인 머리 없이(또는 틀린 값으로) 보낸 위조 CloudFront-Viewer-JA4-Fingerprint·CloudFront-Viewer-ASN·x-amzn-waf-bot-labels는 접근 로그와 백엔드 머리 어디에도 없다(게이트웨이 넷 각각, gw-scanner는 맞는 값이어도 지운다)', async () => {
  const cases = [
    ...BEHIND_CLOUDFRONT.flatMap((gw) => [
      { gw, verify: undefined },
      { gw, verify: 'wrong-origin-verify' },
      { gw, verify: '' },
    ]),
    { gw: 'gw-scanner', verify: c.originVerify },
    { gw: 'gw-scanner', verify: undefined },
  ];
  for (const { gw, verify } of cases) {
    const sub = nextSub();
    const ja4 = JA4();
    const forged = { 'cloudfront-viewer-ja4-fingerprint': ja4, 'cloudfront-viewer-asn': '64496', 'x-amzn-waf-bot-labels': 'awswaf:managed:aws:bot-control:bot:verified', 'cloudfront-viewer-address': '192.0.2.9:443', 'x-amzn-waf-forged': '1', 'x-peaket-arrival': 'forged-arrival' };
    const headers = { 'x-forwarded-for': nextIp(), ...forged, ...(verify === undefined ? {} : { 'x-peaket-origin-verify': verify }) };
    const h = echoed(await probe(c, gw, { tokenValue: accessToken(c, gw, sub), event: EVENT, headers }));
    const m = `${gw} 원본 확인=${verify === undefined ? '없음' : verify === c.originVerify ? '맞음' : `'${verify}'`}`;
    for (const k of Object.keys(forged)) assert.equal(h[k], undefined, `${m}: 백엔드에 ${k}`);
    assert.equal(h['x-peaket-origin-verify'], undefined, `${m}: 원본 확인 머리가 넘었다`);
    const [line] = await waitLogLine(c, gw, sub);
    assert.ok(blank(line.ja4) && blank(line.asn) && blank(line.edgeBotLabels), `${m}: 로그 ${JSON.stringify(line)}`);
    assert.ok(!JSON.stringify(line).includes(ja4), `${m}: 로그에 위조 JA4`);
  }
});

test('HOT-400 BOT-010 접근 로그는 /verify/return과 /booking/{eventId}/checkout/return의 쿼리를 남기지 않는다(infra §9)', async () => {
  const secret = `q${RUN}${randomBytes(4).toString('hex')}`;
  for (const path of [`/verify/return?result=${secret}&tx=${secret}`, `/booking/${EVENT}/checkout/return?paymentKey=${secret}&orderId=o-${RUN}`]) {
    await send(c, 'www', { path, headers: edge(c, nextIp()) });
  }
  // 두 경로의 줄이 남고(경로만), 비밀 값은 어느 줄에도 없다
  const lines = await waitLogLine(c, 'gw-fan', `/booking/${EVENT}/checkout/return`);
  assert.ok(lines.every((l) => Object.values(l).some((v) => v === `/booking/${EVENT}/checkout/return`)), '쿼리를 뗀 경로 칸');
  const all = await accessLog(c, 'gw-fan');
  assert.ok(all.some((l) => Object.values(l).includes('/verify/return')), '/verify/return 줄이 없다');
  assert.ok(!all.some((l) => JSON.stringify(l).includes(secret)), '쿼리 값이 접근 로그에 남았다');
});

// ===================== 클라이언트 IP =====================

test('[ASVS v5.0.0-15.3.4] 바깥에서 x-forwarded-for 여러 값을 보내도 CloudFront 뒤 넷의 백엔드는 맨 오른쪽 값 하나를, gw-scanner는 연결 상대 주소를 받는다', async () => {
  for (const gw of BEHIND_CLOUDFRONT) {
    for (const [sent, want] of [
      ['198.51.100.1, 203.0.113.7', '203.0.113.7'],
      ['10.0.0.1,198.51.100.2, 2001:db8::7', '2001:db8::7'],
      ['203.0.113.8', '203.0.113.8'],
    ]) {
      const h = echoed(await probe(c, gw, { tokenValue: accessToken(c, gw, nextSub()), event: EVENT, headers: edge(c, sent) }));
      assert.equal(h['x-forwarded-for'], want, `${gw} ${sent}`);
      for (const k of ['forwarded', 'x-real-ip']) assert.equal(h[k], undefined, `${gw}: ${k}`);
    }
  }
  const h = echoed(await probe(c, 'gw-scanner', { tokenValue: accessToken(c, 'gw-scanner', nextSub()), event: EVENT, headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.7' } }));
  assert.ok(h['x-forwarded-for'] && !h['x-forwarded-for'].includes(',') && !['198.51.100.1', '203.0.113.7'].includes(h['x-forwarded-for']), `gw-scanner: ${h['x-forwarded-for']}`);
});

// ===================== 토큰 확인과 인가 =====================

test('I-T36 팬 키로 서명한 aud ops 토큰은 gw-ops에서 401이고 관리 키·스태프 키의 다른 대상 토큰도 401이다', async () => {
  const sub = nextSub();
  const cases = [
    ['gw-ops', token(c, 'fan', { sub, sid: `s-${sub}`, aud: 'ops', scope: c.probes['gw-ops'].scope ?? '' }), '팬 키 + aud ops'],
    ['gw-ops', token(c, 'admin', { sub, sid: `s-${sub}`, aud: 'partner', scope: c.probes['gw-ops'].scope ?? '' }), '관리 키 + aud partner'],
    ['gw-partner', token(c, 'admin', { sub, sid: `s-${sub}`, aud: 'ops', scope: c.probes['gw-partner'].scope ?? '' }), '관리 키 + aud ops'],
    ['gw-fan', token(c, 'admin', { sub, sid: `s-${sub}`, aud: 'fan', scope: c.probes['gw-fan'].scope ?? '' }), '관리 키 + aud fan'],
    ['gw-fan', token(c, 'staff', { sub, sid: `s-${sub}`, aud: 'fan', scope: c.probes['gw-fan'].scope ?? '' }), '스태프 키 + aud fan'],
    ['gw-scanner', token(c, 'fan', { sub, sid: `s-${sub}`, aud: 'scanner', scope: c.probes['gw-scanner'].scope ?? '' }), '팬 키 + aud scanner'],
    ['gw-queue', token(c, 'fan', { sub, sid: `s-${sub}`, aud: 'ops', scope: 'ticket:buy' }), '팬 키 + aud ops(gw-queue)'],
  ];
  for (const [gw, tv, m] of cases) {
    const r = await probe(c, gw, { tokenValue: tv, event: EVENT, headers: edge(c, nextIp()) });
    assert.equal(r.status, 401, `${m} → ${gw}: ${r.status}`);
  }
});

test('I-T36 입장 토큰을 액세스 쿠키·Bearer 자리에 넣으면 gw-fan·gw-queue에서 401이다', async () => {
  const sub = nextSub();
  const admission = token(c, 'admission', { sub, aud: 'purchase', eid: EVENT, scope: 'ticket:buy' }, { typ: 'admission+jwt' });
  // 같은 팬 키로 서명해도 typ이 다르면 401(키는 맞고 typ·aud만 다름)
  const fanSignedAdmission = token(c, 'fan', { sub, sid: `s-${sub}`, aud: 'fan', scope: 'ticket:buy' }, { typ: 'admission+jwt' });
  for (const gw of ['gw-fan', 'gw-queue']) {
    for (const [tv, m] of [
      [admission, '입장 키'],
      [fanSignedAdmission, '팬 키 + typ admission+jwt'],
    ]) {
      const bearer = await probe(c, gw, { tokenValue: tv, event: EVENT, headers: edge(c, nextIp()) });
      assert.equal(bearer.status, 401, `${gw} Bearer ${m}: ${bearer.status}`);
      const cookie = await probe(c, gw, { event: EVENT, headers: edge(c, nextIp(), { cookie: `__Secure-peaket_at=${tv}` }) });
      assert.equal(cookie.status, 401, `${gw} 쿠키 ${m}: ${cookie.status}`);
    }
  }
});

test('I-T36 재인증 토큰(typ reauth+jwt)과 iss가 다른 토큰은 gw-fan에서 401이고 맞는 액세스 토큰은 통과한다', async () => {
  const sub = nextSub();
  const scope = c.probes['gw-fan'].scope ?? '';
  const reauth = token(c, 'fan', { sub, sid: `s-${sub}`, aud: 'fan', scope, act: 'FAN_SENSITIVE' }, { typ: 'reauth+jwt' });
  const otherIss = token(c, 'fan', { sub, sid: `s-${sub}`, aud: 'fan', scope, iss: 'https://identity.evil.example' });
  for (const [tv, m] of [
    [reauth, 'reauth+jwt'],
    [otherIss, '다른 iss'],
  ]) {
    const r = await probe(c, 'gw-fan', { tokenValue: tv, headers: edge(c, nextIp()) });
    assert.equal(r.status, 401, `${m}: ${r.status}`);
  }
  const ok = await probe(c, 'gw-fan', { tokenValue: accessToken(c, 'gw-fan', sub), headers: edge(c, nextIp()) });
  assert.ok(ok.status < 400, `맞는 토큰: ${ok.status}`);
  // 쿠키 자리의 맞는 토큰도 통과한다
  const viaCookie = await probe(c, 'gw-fan', { headers: edge(c, nextIp(), { cookie: `__Secure-peaket_at=${accessToken(c, 'gw-fan', sub)}` }) });
  assert.ok(viaCookie.status < 400, `쿠키 자리: ${viaCookie.status}`);
});

test('HOT-400 authz-matrix §5.1 대기열 진입·입장 확정은 X-User-Scope에 ticket:buy가 없으면 403, 토큰이 없으면 401이다', async () => {
  const sub = nextSub();
  const without = token(c, 'fan', { sub, sid: `s-${sub}`, aud: 'fan', scope: 'profile', pid: `p-${sub}` });
  const withBuy = token(c, 'fan', { sub, sid: `s-${sub}`, aud: 'fan', scope: 'profile ticket:buy', pid: `p-${sub}` });
  for (const path of [`/v1/queues/${EVENT}/entries`, `/v1/queues/${EVENT}/admission`]) {
    const base = { method: 'POST', path, body: '{}' };
    const hdr = (tv) => edge(c, nextIp(), { origin: c.origins.www, 'content-type': 'text/plain;charset=UTF-8', ...(tv ? { cookie: `__Secure-peaket_at=${tv}` } : {}) });
    assert.equal((await send(c, 'queue', { ...base, headers: hdr(without) })).status, 403, `${path}: ticket:buy 없음`);
    assert.equal((await send(c, 'queue', { ...base, headers: hdr(undefined) })).status, 401, `${path}: 토큰 없음`);
    const ok = await send(c, 'queue', { ...base, headers: hdr(withBuy) });
    assert.ok(ok.status < 400, `${path}: ticket:buy 있음 ${ok.status}`);
    assert.ok(echoed(ok)['x-user-scope'].split(' ').includes('ticket:buy'));
  }
});

// ===================== 응답 머리 =====================

test('[ASVS v5.0.0-3.4.1] 다섯 게이트웨이 응답에 HSTS max-age=31536000; includeSubDomains가 붙고 백엔드 값은 정책 값으로 덮인다', async () => {
  for (const gw of GATEWAYS) {
    const tv = accessToken(c, gw, nextSub());
    const plain = await probe(c, gw, { tokenValue: tv, event: EVENT, headers: edge(c, nextIp()) });
    assert.equal(plain.headers['strict-transport-security'], HSTS, `${gw}`);
    const own = await probe(c, gw, { tokenValue: tv, event: EVENT, headers: edge(c, nextIp(), { 'x-e2e-response-headers': JSON.stringify({ 'strict-transport-security': 'max-age=60' }) }) });
    assert.equal(own.headers['strict-transport-security'], HSTS, `${gw}: 백엔드 값을 덮지 않는다`);
    // 게이트웨이가 직접 내는 오류에도 붙는다
    const denied = await probe(c, gw, { tokenValue: 'not-a-jwt', event: EVENT, headers: edge(c, nextIp()) });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers['strict-transport-security'], HSTS, `${gw} 401`);
  }
});

test('[ASVS v5.0.0-3.4.4] 다섯 게이트웨이 응답(백엔드 응답과 게이트웨이 401)에 X-Content-Type-Options nosniff가 붙는다', async () => {
  for (const gw of GATEWAYS) {
    const ok = await probe(c, gw, { tokenValue: accessToken(c, gw, nextSub()), event: EVENT, headers: edge(c, nextIp()) });
    assert.equal(ok.headers['x-content-type-options'], 'nosniff', gw);
    const denied = await probe(c, gw, { tokenValue: 'not-a-jwt', event: EVENT, headers: edge(c, nextIp()) });
    assert.equal(denied.headers['x-content-type-options'], 'nosniff', `${gw} 401`);
  }
});

test("[ASVS v5.0.0-3.4.3] [ASVS v5.0.0-3.4.6] API 응답에 앱 CSP가 없을 때만 기본 CSP default-src 'none'; frame-ancestors 'none'이 붙고 앱 서버 경로의 CSP는 그대로다", async () => {
  const appCsp = "default-src 'self'; script-src 'nonce-e2e'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  for (const gw of GATEWAYS) {
    const tv = accessToken(c, gw, nextSub());
    const none = await probe(c, gw, { tokenValue: tv, event: EVENT, headers: edge(c, nextIp()) });
    assert.equal(none.headers['content-security-policy'], API_CSP, `${gw}: 기본 CSP`);
    const own = await probe(c, gw, { tokenValue: tv, event: EVENT, headers: edge(c, nextIp(), { 'x-e2e-response-headers': JSON.stringify({ 'content-security-policy': appCsp }) }) });
    assert.equal(own.headers['content-security-policy'], appCsp, `${gw}: 앱 CSP를 덮었다`);
  }
  for (const [gw, host] of [['gw-fan', 'www'], ['gw-partner', 'partner']]) {
    const r = await send(c, host, { path: c.appPaths[gw], headers: edge(c, nextIp(), { 'x-e2e-response-headers': JSON.stringify({ 'content-security-policy': appCsp, 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin' }) }) });
    assert.equal(r.headers['content-security-policy'], appCsp, `${gw} 앱 서버 경로 CSP`);
    assert.equal(r.headers['referrer-policy'], 'no-referrer', `${gw} Referrer-Policy`);
    assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin', `${gw} COOP`);
  }
});

// ===================== 교차 출처·출처 확인 =====================

const vary = (h) => String(h.vary ?? '').toLowerCase().split(/\s*,\s*/);

test('[ASVS v5.0.0-3.4.2] 다섯 게이트웨이에서 허용 밖 Origin(다른 화면·남의 사이트·null)의 응답에는 Access-Control-Allow-Origin이 없고, 화면 출처에는 그 값 하나다', async () => {
  for (const gw of GATEWAYS) {
    const tv = accessToken(c, gw, nextSub());
    const mine = await probe(c, gw, { tokenValue: tv, event: EVENT, headers: edge(c, nextIp(), { origin: c.origins[SCREEN_OF[gw]] }) });
    assert.equal(mine.headers['access-control-allow-origin'], c.origins[SCREEN_OF[gw]], `${gw}: 화면 출처`);
    if (gw !== 'gw-scanner') assert.ok(vary(mine.headers).includes('origin'), `${gw}: Vary: Origin`);
    for (const bad of outsideOrigins(gw).filter((o) => o !== '')) {
      const r = await probe(c, gw, { tokenValue: tv, event: EVENT, headers: edge(c, nextIp(), { origin: bad }) });
      assert.equal(r.headers['access-control-allow-origin'], undefined, `${gw} ${bad}: ${r.headers['access-control-allow-origin']}`);
    }
    // 사전 요청도 목록 밖 출처에는 허용을 주지 않는다
    const p = c.probes[gw];
    const pre = await send(c, p.host, { method: 'OPTIONS', path: p.path.replaceAll('{event}', EVENT), headers: edge(c, nextIp(), { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }) });
    assert.equal(pre.headers['access-control-allow-origin'], undefined, `${gw} 사전 요청`);
  }
});

const entry = (origin, extra = {}) => {
  const sub = nextSub();
  const tv = token(c, 'fan', { sub, sid: `s-${sub}`, aud: 'fan', scope: 'ticket:buy', pid: `p-${sub}` });
  return send(c, 'queue', {
    method: 'POST',
    path: `/v1/queues/${EVENT}/entries`,
    body: JSON.stringify({ requestId: `r-${sub}`, deviceId: 'dev-e2e', preverifyToken: 'v1.k.e2e.mac' }),
    headers: edge(c, nextIp(), { 'content-type': 'text/plain;charset=UTF-8', cookie: `__Secure-peaket_at=${tv}`, ...(origin === undefined ? {} : { origin }), ...extra }),
  });
};

test('Q-T41 ④ 허용 목록 밖 Origin(다른 화면 셋·남의 사이트·null·빈 값)의 대기열 진입은 403이고 백엔드에 닿지 않는다', async () => {
  for (const bad of outsideOrigins('gw-queue')) {
    const r = await entry(bad);
    assert.equal(r.status, 403, `Origin '${bad}': ${r.status}`);
    assert.throws(() => echoed(r), `Origin '${bad}': 백엔드에 닿았다`);
  }
  const ok = await entry(c.origins.www);
  assert.ok(ok.status < 400, `www 출처: ${ok.status}`);
  assert.equal(echoed(ok)['content-type'], 'text/plain;charset=UTF-8', '게이트웨이는 text/plain을 막거나 바꾸지 않는다');
});

test('Q-T41 ⑤ Origin 없이 Sec-Fetch-Site: cross-site인 대기열 진입·입장 확정은 403이다', async () => {
  const r = await entry(undefined, { 'sec-fetch-site': 'cross-site' });
  assert.equal(r.status, 403, `진입: ${r.status}`);
  const sub = nextSub();
  const tv = token(c, 'fan', { sub, sid: `s-${sub}`, aud: 'fan', scope: 'ticket:buy', pid: `p-${sub}` });
  const a = await send(c, 'queue', { method: 'POST', path: `/v1/queues/${EVENT}/admission`, body: '{}', headers: edge(c, nextIp(), { 'content-type': 'text/plain;charset=UTF-8', cookie: `__Secure-peaket_at=${tv}`, 'sec-fetch-site': 'cross-site' }) });
  assert.equal(a.status, 403, `입장 확정: ${a.status}`);
});

test('Q-T41 ② application/json 진입의 사전 요청 응답은 www 출처·Allow-Credentials·Access-Control-Max-Age: 7200이다', async () => {
  const r = await send(c, 'queue', { method: 'OPTIONS', path: `/v1/queues/${EVENT}/entries`, headers: edge(c, nextIp(), { origin: c.origins.www, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }) });
  assert.ok(r.status === 200 || r.status === 204, `사전 요청: ${r.status}`);
  assert.equal(r.headers['access-control-allow-origin'], c.origins.www);
  assert.equal(r.headers['access-control-allow-credentials'], 'true');
  assert.equal(r.headers['access-control-max-age'], '7200');
  assert.match(String(r.headers['access-control-allow-methods'] ?? ''), /\bPOST\b/);
});

test('Q-T41 ⑦ queue-files 파일 응답은 www 출처와 Expose-Headers Retry-After만 내고 Access-Control-Allow-Credentials가 없다', async () => {
  const r = await send(c, 'queue-files', { path: `/v1/queues/${EVENT}/segment-states/0.json?e2e-status=503&e2e-header=retry-after:3`, headers: edge(c, nextIp(), { origin: c.origins.www }) });
  assert.equal(r.headers['access-control-allow-origin'], c.origins.www);
  assert.equal(r.headers['access-control-allow-credentials'], undefined);
  assert.deepEqual(String(r.headers['access-control-expose-headers'] ?? '').toLowerCase().split(/\s*,\s*/), ['retry-after']);
  assert.equal(r.headers['retry-after'], '3');
});

test('HOT-400 HOT-020 gw-queue 진입은 __Host-peaket_arr 쿠키와, 원본 확인이 맞을 때만 x-peaket-arrival을 queue-svc까지 넘긴다', async () => {
  const arr = `__Host-peaket_arr=v1.k.${RUN}.mac`;
  const sub = nextSub();
  const tv = token(c, 'fan', { sub, sid: `s-${sub}`, aud: 'fan', scope: 'ticket:buy', pid: `p-${sub}` });
  const body = JSON.stringify({ requestId: `r-${sub}` });
  const base = { 'content-type': 'text/plain;charset=UTF-8', origin: c.origins.www, cookie: `__Secure-peaket_at=${tv}; ${arr}`, 'x-peaket-arrival': `a-${RUN}` };
  const ok = echoed(await send(c, 'queue', { method: 'POST', path: `/v1/queues/${EVENT}/entries`, body, headers: edge(c, nextIp(), base) }));
  assert.ok((ok.cookie ?? '').includes(arr), `쿠키가 넘지 않았다: ${ok.cookie}`);
  assert.equal(ok['x-peaket-arrival'], `a-${RUN}`);
  const noVerify = echoed(await send(c, 'queue', { method: 'POST', path: `/v1/queues/${EVENT}/entries`, body, headers: { 'x-forwarded-for': nextIp(), ...base } }));
  assert.ok((noVerify.cookie ?? '').includes(arr), '원본 확인이 없어도 쿠키는 넘는다');
  assert.equal(noVerify['x-peaket-arrival'], undefined, '원본 확인 없이 x-peaket-arrival이 넘었다');
});

test('HOT-400 PRF-030·BOT-047 gw-fan 토큰 갱신 응답의 Set-Cookie와 401 본문이 그대로 오고, 갱신 쓰기는 허용 밖 Origin이면 403이다', async () => {
  const cookies = ['__Secure-peaket_at=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict', '__Secure-peaket_rt=; Max-Age=0; Path=/v1/identity/access-tokens; Secure; HttpOnly; SameSite=Strict'];
  const problem = JSON.stringify({ type: 'https://errors.peaket.example/refresh-token-invalid', title: '다시 로그인해 주세요', status: 401, ended: 'LOGOUT' });
  const r = await send(c, 'api', {
    method: 'POST',
    path: '/v1/identity/access-tokens',
    headers: edge(c, nextIp(), { origin: c.origins.www, cookie: '__Secure-peaket_rt=rt-e2e', 'x-e2e-status': '401', 'x-e2e-body': problem, 'x-e2e-response-headers': JSON.stringify({ 'set-cookie': cookies, 'content-type': 'application/problem+json', 'www-authenticate': 'Cookie realm="peaket"' }) }),
  });
  assert.equal(r.status, 401);
  assert.equal(r.text, problem);
  assert.deepEqual(r.headers['set-cookie'], cookies);
  assert.equal(r.headers['www-authenticate'], 'Cookie realm="peaket"');
  const issued = ['__Secure-peaket_at=at-e2e; Path=/; Secure; HttpOnly; SameSite=Strict', '__Secure-peaket_rt=rt-e2e2; Path=/v1/identity/access-tokens; Secure; HttpOnly; SameSite=Strict'];
  const ok = await send(c, 'api', { method: 'POST', path: '/v1/identity/access-tokens', headers: edge(c, nextIp(), { origin: c.origins.www, cookie: '__Secure-peaket_rt=rt-e2e', 'x-e2e-status': '204', 'x-e2e-response-headers': JSON.stringify({ 'set-cookie': issued }) }) });
  assert.equal(ok.status, 204);
  assert.deepEqual(ok.headers['set-cookie'], issued);
  for (const bad of outsideOrigins('gw-fan')) {
    const x = await send(c, 'api', { method: 'POST', path: '/v1/identity/access-tokens', headers: edge(c, nextIp(), { origin: bad, cookie: '__Secure-peaket_rt=rt-e2e' }) });
    assert.equal(x.status, 403, `Origin '${bad}': ${x.status}`);
  }
});

// ===================== 검색 IP 한도 =====================

test('SR-T13 ② gw-fan /v1/search*는 한 IP(IPv4·IPv6 각각)가 초당 50건(모아 두기 50건)을 넘으면 429와 Retry-After이고 다른 IP는 막지 않는다', async () => {
  // 로컬 한도는 프록시 파드마다 센다(docs/api/guidelines.md §6). 로컬 덧씌우기의 gw-fan 프록시 복제 수를 곱한다
  const replicas = Number(c.replicas?.['gw-fan'] ?? 1);
  for (const [ip, other] of [
    ['198.51.100.77', '198.51.100.78'],
    ['2001:db8:77::1', '2001:db8:78::1'],
  ]) {
    const t0 = Date.now();
    const results = await pool(300, 50, (i) => send(c, 'api', { path: i % 2 ? `/v1/search/suggestions?q=e2e${i}` : `/v1/search?q=e2e${i}`, headers: edge(c, ip) }));
    const seconds = (Date.now() - t0) / 1000;
    const passed = results.filter((r) => r.status !== 429).length;
    const limited = results.filter((r) => r.status === 429);
    assert.ok(limited.length > 0, `${ip}: 300건(${seconds.toFixed(1)}초)에 429가 없다`);
    for (const r of limited) assert.match(String(r.headers['retry-after'] ?? ''), /^\d+$/, `${ip}: 429의 Retry-After`);
    // 처음 모아 둔 50건 + 지난 시간만큼 채운 초당 50건(올림)을 파드마다 넘겨 통과하지 않는다
    assert.ok(passed <= 50 * (1 + Math.ceil(seconds)) * replicas, `${ip}: 통과 ${passed}건 > 50 × (1 + ${Math.ceil(seconds)}) × ${replicas}`);
    assert.ok(passed >= 50, `${ip}: 초당 50건보다 적게 통과했다(${passed})`);
    const o = await send(c, 'api', { path: '/v1/search?q=e2e-other', headers: edge(c, other) });
    assert.notEqual(o.status, 429, `${other}: 다른 IP까지 막았다(IP마다 따로 세지 않는다)`);
  }
});
