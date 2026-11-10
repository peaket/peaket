// SCR-009 추가 검증 흐름 시험(d5 §5.9 상태 표·'제출 차례와 되살리기', docs/frontend.md §4.2.1 8·9번, ADR-0259 결정 1~4).
// 공용 틀(verify-flow.test.harness.mjs)의 가짜 시계·타이머·위젯·가짜 queue-svc로 돌린다. 화면은 토큰을 받으면 바로 제출해 보고(재통과 전이면 REVERIFY_REQUIRED),
// 시험의 reverify()가 ③ 본인확인을 마친다(ADR-0259 결정 12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN_MAX_AGE_MS, apiError, fakeServer, harness, memory, NOW, queueRecord, RECEIVED } from './verify-flow.test.harness.mjs';

/** 사람 확인 토큰 제출의 토큰 차례(공용 틀의 가짜 서버는 재통과 전 제출에 REVERIFY_REQUIRED로 답한다) */
const tokens = (h) => h.server.challenges().map((x) => x.body.challengeToken);

test('[ASVS v5.0.0-3.2.2] 서버가 준 사유 범주는 표에 있는 코드만 글로 바꾸고, 모르는 값·HTML 조각은 화면 값에 싣지 않는다', async () => {
  const h = harness();
  await h.flush();
  assert.equal(h.last().phase, 'verifying');
  assert.equal(h.last().reason, '짧은 시간 많은 요청');
  for (const bad of ['<img src=x onerror=alert(1)>', 'toString', '__proto__', '', 7, null]) {
    const x = harness({ server: fakeServer({ reason: bad }) });
    await x.flush();
    assert.equal(x.last().reason, null, String(bad));
    x.f.dispose();
  }
  h.f.dispose();
});

test('[ASVS v5.0.0-3.7.2] 통과 뒤 이동은 고정 경로이고 주소의 next 같은 바깥 값을 쓰지 않는다(차례 전·차례 지남·로그인·회차 ID 조각)', async () => {
  const saved = globalThis.location;
  globalThis.location = { href: 'http://localhost:3000/queue/e1/verify?next=https://evil.example/&returnTo=//evil.example', search: '?next=https://evil.example/&returnTo=//evil.example', origin: 'http://localhost:3000', pathname: '/queue/e1/verify' };
  try {
    // 차례 전: 원래 순번의 대기실
    const a = harness();
    await a.flush();
    await a.reverify();
    await a.run(1000);
    assert.equal(a.last().phase, 'passed');
    assert.equal(a.last().turn, 'before');
    assert.deepEqual(a.navs, ['/queue/e1']);
    // 차례 지남: 입장 확정 ADMITTED → 좌석 화면
    const b = harness({ server: fakeServer({ admitReply: { status: 200, body: { status: 'ADMITTED', admissionToken: 'adm.t', purchaseSessionExpiresAt: '2026-11-10T04:00:00.000Z' } } }) });
    b.server.next.push({ status: 200, body: { result: 'PASSED', queueNumber: 1234, graceUntil: '2026-11-10T03:15:00.000Z' } });
    await b.flush();
    await b.reverify();
    await b.run(1000);
    assert.equal(b.last().turn, 'after');
    assert.deepEqual(b.navs, ['/booking/e1/seats']);
    // 로그인: 돌아올 곳은 이 화면의 고정 경로
    const cs = fakeServer();
    cs.readNext.push({ throw: apiError(401, 'http-401') });
    const c = harness({ server: cs });
    await c.flush();
    assert.deepEqual(c.navs, ['/login?next=%2Fqueue%2Fe1%2Fverify']);
    // 회차 ID는 경로 조각으로만 들어간다(다른 호스트로 가는 '//'가 생기지 않는다)
    const d = harness({ eventId: '//evil.example', local: memory() });
    await d.flush();
    await d.reverify();
    await d.run(1000);
    assert.deepEqual(d.navs, ['/queue/%2F%2Fevil.example']);
    for (const u of [...a.navs, ...b.navs, ...c.navs, ...d.navs]) {
      assert.match(u, /^\/(?!\/)/, u);
      assert.doesNotMatch(u, /evil\.example\//, u);
    }
    for (const x of [a, b, c, d]) x.f.dispose();
  } finally {
    globalThis.location = saved;
  }
});

test("이의를 보낸 뒤 새로고침하면 '접수됨'이 상태 읽기로 되살아나고 양식이 다시 열리지 않는다(다시 보내지 않는다)", async () => {
  const h = harness();
  await h.flush();
  assert.equal(h.last().appeal, 'open');
  assert.equal(h.f.sendAppeal('오픈 직전에 새로고침을 여러 번 눌렀습니다'), 'sent');
  await h.flush();
  assert.equal(h.last().appeal, 'received');
  assert.equal(h.last().appealReceivedAt, RECEIVED);
  assert.equal(h.last().appealText, '오픈 직전에 새로고침을 여러 번 눌렀습니다');
  assert.equal(h.server.appeals().length, 1);
  h.reload();
  await h.flush();
  assert.equal(h.last().phase, 'verifying');
  assert.equal(h.last().appeal, 'received', '새로고침 뒤에도 접수됨');
  assert.equal(h.last().appealReceivedAt, RECEIVED);
  assert.equal(h.last().appealText, '오픈 직전에 새로고침을 여러 번 눌렀습니다', '보낸 글은 상태 읽기의 appeal.text로 되살린다');
  assert.equal(h.f.sendAppeal('다른 글'), 'busy');
  await h.flush();
  assert.equal(h.server.appeals().length, 1, '양식이 다시 열려 두 번째 이의를 보내지 않는다');
  h.f.dispose();
});

test('위젯 토큰을 받은 지 정한 시간(기본 240초 [가정])이 넘었으면 보내기 전에 위젯을 다시 돌린다(경계 양쪽, 시험 값은 상수와 다르게 90초)', async () => {
  assert.equal(TOKEN_MAX_AGE_MS, 240_000);
  // 경계 안: 받은 지 정확히 90초면 그 토큰으로 보낸다
  const a = harness({ tokenMaxAgeMs: 90_000, pollMs: 600_000 });
  await a.flush();
  assert.deepEqual(a.checks, [NOW]);
  await a.run(90_000);
  await a.reverify();
  await a.flush();
  assert.equal(a.checks.length, 1, '위젯을 다시 돌리지 않는다');
  assert.deepEqual(tokens(a), ['hc-1', 'hc-1'], '첫 줄은 토큰을 받자마자 보낸 제출(재통과 전 REVERIFY_REQUIRED)');
  // 경계 밖: 90초 1밀리초면 위젯을 다시 돌려 새 토큰으로 보낸다(낡은 토큰은 보내지 않는다)
  const b = harness({ tokenMaxAgeMs: 90_000, pollMs: 600_000 });
  await b.flush();
  await b.run(90_001);
  await b.reverify();
  await b.flush();
  assert.equal(b.checks.length, 2);
  assert.deepEqual(tokens(b), ['hc-1', 'hc-2']);
  // 기본값(240초)도 같은 규칙
  const c = harness({ pollMs: 600_000 });
  await c.flush();
  await c.run(240_001);
  await c.reverify();
  await c.flush();
  assert.deepEqual(tokens(c), ['hc-1', 'hc-2']);
  for (const x of [a, b, c]) x.f.dispose();
});

test('제출은 {challengeToken, deviceId}만, 이의는 {appeal}만 보낸다(둘을 함께 보내지 않는다)', async () => {
  const h = harness({ pollMs: 600_000 });
  await h.flush();
  assert.equal(h.last().challenge, 'ready');
  h.f.sendAppeal('');
  await h.flush();
  assert.deepEqual(h.server.appeals()[0].body, { appeal: '' });
  await h.reverify();
  for (const x of h.server.challenges()) assert.deepEqual(x.body, { challengeToken: 'hc-1', deviceId: 'AAAAAAAAAAAAAAAAAAAAAA' });
  assert.equal(h.server.challenges().length, 2);
  h.f.dispose();
});

test('서버가 REVERIFY_REQUIRED로 답하면 본인확인 단계로 돌아가고(토큰은 그대로), 다시 마치면 같은 토큰으로 한 번 더 보낸다. 이 탭에서 마쳤는데도 그렇게 답하면 안내를 보인다', async () => {
  const h = harness({ pollMs: 600_000 });
  h.server.next.push({ status: 200, body: { result: 'REVERIFY_REQUIRED' } });
  await h.flush();
  assert.equal(h.last().submit, 'reverify');
  assert.equal(h.last().reverifyAgain, undefined, '처음 제출의 REVERIFY_REQUIRED는 ③으로만 보낸다');
  await h.reverify();
  assert.equal(h.last().reverified, false);
  assert.equal(h.last().submit, 'reverify');
  assert.equal(h.last().reverifyAgain, true);
  assert.equal(h.last().phase, 'verifying');
  await h.run(30_000);
  assert.equal(tokens(h).length, 2, '본인확인을 다시 마칠 때까지 보내지 않는다');
  await h.reverify();
  assert.deepEqual(tokens(h), ['hc-1', 'hc-1', 'hc-1']);
  assert.equal(h.checks.length, 1, '서버가 토큰을 쓰지 않았으므로 위젯을 다시 돌리지 않는다');
  await h.run(1000);
  assert.equal(h.last().phase, 'passed');
  h.f.dispose();
});

test('PERSON_MISMATCH면 본인확인 단계로 돌아가 다른 분 안내를 보이고, CHALLENGE_FAILED면 위젯 실패 뒤 [다시 시도]로 새 토큰을 받아 보낸다', async () => {
  const h = harness({ pollMs: 600_000 });
  h.server.next.push({ status: 200, body: { result: 'PERSON_MISMATCH' } }, { status: 200, body: { result: 'CHALLENGE_FAILED' } });
  await h.flush();
  await h.reverify();
  await h.flush();
  assert.equal(h.last().submit, 'mismatch');
  assert.equal(h.last().reverified, false);
  await h.reverify();
  await h.flush();
  assert.equal(h.last().challenge, 'failed');
  assert.equal(h.last().reverified, true, '본인확인은 다시 하지 않는다');
  assert.equal(tokens(h).length, 3);
  await h.run(30_000);
  assert.equal(tokens(h).length, 3, '[다시 시도] 전에는 보내지 않는다');
  h.f.retryChallenge();
  await h.flush();
  assert.deepEqual(tokens(h), ['hc-1', 'hc-1', 'hc-1', 'hc-2']);
  h.f.dispose();
});

test("410 queue-ticket-removed에 removeReason BLOCKED면 '기각'이고 묻기를 멈춘다. 확장 칸이 없으면 대기실로, 판매 종료도 대기실로 간다", async () => {
  const a = harness({ pollMs: 5000 });
  a.server.next.push({ throw: apiError(410, 'queue-ticket-removed', null, { removeReason: 'BLOCKED' }) });
  await a.flush();
  await a.reverify();
  await a.flush();
  assert.equal(a.last().phase, 'rejected');
  assert.deepEqual(a.navs, []);
  const reads = a.server.reads;
  await a.run(60_000);
  assert.equal(a.server.reads, reads, '기각 뒤에는 상태를 다시 묻지 않는다');
  for (const [type, ext] of [['queue-ticket-removed', {}], ['sale-ended', {}]]) {
    const b = harness();
    b.server.next.push({ throw: apiError(410, type, null, ext) });
    await b.flush();
    await b.reverify();
    await b.flush();
    assert.notEqual(b.last().phase, 'rejected', type);
    assert.deepEqual(b.navs, ['/queue/e1'], type);
    b.f.dispose();
  }
  // 상태 읽기가 BLOCKED여도 기각
  const c = harness({ server: fakeServer({ state: 'BLOCKED', reason: 'NETWORK' }) });
  await c.flush();
  assert.equal(c.last().phase, 'rejected');
  assert.equal(c.last().reason, '접속 환경');
  a.f.dispose();
  c.f.dispose();
});

test('503은 Retry-After를 지켜(그 전에는 보내지 않는다) 하한 위 지터 뒤 새 토큰으로 자동으로 다시 보내고, 429는 너무 많이 시도 안내 뒤 Retry-After가 지나야 같은 토큰으로 보낸다', async () => {
  const a = harness({ pollMs: 600_000 });
  a.server.next.push({ throw: apiError(503, 'dependency-unavailable', '7') });
  await a.flush();
  await a.reverify();
  await a.flush();
  assert.equal(a.last().submit, 'retry');
  assert.equal(a.last().retryAt, NOW + 7700, 'Retry-After 7초 × (1 + 0.5 × 0.2)');
  await a.run(7_699);
  assert.equal(tokens(a).length, 2, '하한 전에는 보내지 않는다');
  await a.run(1);
  assert.deepEqual(tokens(a), ['hc-1', 'hc-1', 'hc-2'], '503 뒤에는 위젯을 다시 돌린 새 토큰');
  await a.run(1000);
  assert.equal(a.last().phase, 'passed');
  const b = harness({ pollMs: 600_000 });
  b.server.next.push({ throw: apiError(429, 'verification-submit-limited', '30') });
  await b.flush();
  await b.reverify();
  await b.flush();
  assert.equal(b.last().submit, 'limited');
  await b.run(32_999);
  assert.equal(tokens(b).length, 2);
  await b.run(1);
  // 429는 trust-svc를 부르기 전이라 토큰을 쓰지 않았다: 30초 넘게 기다렸어도 토큰이 정한 시간 안이면 그대로 보낸다
  assert.deepEqual(tokens(b), ['hc-1', 'hc-1', 'hc-1']);
  // 연결 실패(상태 없음)는 하한 없는 지터로 다시
  const c = harness({ pollMs: 600_000 });
  c.server.next.push({ throw: new TypeError('fetch failed') });
  await c.flush();
  await c.reverify();
  await c.flush();
  assert.equal(c.last().submit, 'retry');
  await c.run(2000);
  assert.deepEqual(tokens(c), ['hc-1', 'hc-1', 'hc-2']);
  for (const x of [a, b, c]) x.f.dispose();
});

test('통과(차례 전)는 대기실 저장값(대기표)을 지우거나 바꾸지 않고 대기실로 간다: 대기실이 같은 대기표·순번으로 이어 간다', async () => {
  const h = harness({ pollMs: 600_000 });
  const before = h.local.getItem('peaket.queue.e1');
  await h.flush();
  await h.reverify();
  await h.flush();
  assert.equal(h.last().phase, 'passed');
  assert.equal(h.last().turn, 'before');
  assert.deepEqual(h.navs, [], '안내를 잠깐 보인 뒤 옮긴다');
  await h.run(1000);
  assert.deepEqual(h.navs, ['/queue/e1']);
  assert.equal(h.local.getItem('peaket.queue.e1'), before);
  assert.equal(h.server.admits.length, 0, '차례 전에는 입장 확정을 부르지 않는다(원래 순번의 차례에 대기실이 부른다)');
  h.f.dispose();
});

test('통과(차례 지남) 뒤 입장 확정이 ADMITTED면 입장 값을 탭 저장소에 두고 대기 값을 지운 뒤 좌석으로, 곧 입장(SOON)이면 차례 시각을 통과 시각으로 옮겨 대기실로 간다(옛 차례 시각에 묶이지 않는다)', async () => {
  const grace = '2026-11-10T03:15:00.000Z';
  const passAt = Date.parse(grace) - 15 * 60_000;
  const admitted = { status: 200, body: { status: 'ADMITTED', admissionToken: 'adm.t', seatmapLayoutPath: '/v1/events/e1/seatmap-layouts/2.json', purchaseSessionExpiresAt: '2026-11-10T04:00:00.000Z', serverEcdhPublicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k' } } };
  const a = harness({ server: fakeServer({ admitReply: admitted }), session: memory({ 'peaket.queue.e1.firstAhead': '30' }), pollMs: 600_000 });
  a.server.next.push({ status: 200, body: { result: 'PASSED', queueNumber: 1234, graceUntil: grace } });
  await a.flush();
  await a.reverify();
  await a.flush();
  assert.deepEqual(a.server.admits, [{ queueTicket: 'qt-1' }]);
  const adm = JSON.parse(a.session.getItem('peaket.admission.e1'));
  assert.equal(adm.admissionToken, 'adm.t');
  assert.equal(adm.seatmapLayoutPath, '/v1/events/e1/seatmap-layouts/2.json');
  assert.equal(adm.purchaseSessionExpiresAt, '2026-11-10T04:00:00.000Z');
  assert.deepEqual(adm.serverEcdhPublicKey, admitted.body.serverEcdhPublicKey);
  assert.equal(typeof adm.receivedAt, 'number');
  assert.equal(a.local.getItem('peaket.queue.e1'), null, '입장했으면 이 회차의 대기 값을 지운다(대기실과 같다, ADR-0207 결정 8)');
  assert.equal(a.session.getItem('peaket.queue.e1.firstAhead'), null);
  await a.run(1000);
  assert.deepEqual(a.navs, ['/booking/e1/seats']);
  // 곧 입장: 대기표는 그대로, 차례 시각만 통과 시각으로(유예 15분은 통과 시각부터, queue-admission §7)
  const oldTurn = passAt - 20 * 60_000;
  const b = harness({ server: fakeServer({ admitReply: { status: 200, body: { status: 'SOON', retryAfterSeconds: 2 } } }), local: memory({ 'peaket.queue.e1': queueRecord({ turnAtMs: oldTurn, firstEta: { sec: 600, atMs: NOW - 900_000 } }) }), pollMs: 600_000 });
  b.server.next.push({ status: 200, body: { result: 'PASSED', queueNumber: 1234, graceUntil: grace } });
  await b.flush();
  await b.reverify();
  await b.run(1000);
  assert.deepEqual(b.server.admits, [{ queueTicket: 'qt-1', firstEtaSec: 600, firstEtaAtMs: NOW - 900_000 }]);
  const rec = JSON.parse(b.local.getItem('peaket.queue.e1'));
  assert.equal(rec.ticket.queueTicket, 'qt-1');
  assert.equal(rec.ticket.seq, 1234);
  assert.equal(rec.turnAtMs, passAt);
  assert.equal(b.session.getItem('peaket.admission.e1'), null);
  assert.deepEqual(b.navs, ['/queue/e1']);
  // 저장한 대기표가 없으면 입장 확정을 부르지 않고 대기실로(대기실이 회차 일정으로 다시 고른다)
  const c = harness({ local: memory(), pollMs: 600_000 });
  c.server.next.push({ status: 200, body: { result: 'PASSED', queueNumber: 1234, graceUntil: grace } });
  await c.flush();
  await c.reverify();
  await c.run(1000);
  assert.equal(c.server.admits.length, 0);
  assert.deepEqual(c.navs, ['/queue/e1']);
  for (const x of [a, b, c]) x.f.dispose();
});

test('상태 읽기(GET)를 몇 초 [가정] 간격으로 다시 묻고(숨긴 동안은 묻지 않는다), 인정(PASSED·passedVia APPEAL)이 오면 결과를 보이고 묻기를 멈춘다', async () => {
  const h = harness({ pollMs: 3000, server: fakeServer({ admitReply: { status: 200, body: { status: 'NOT_YET', retryAfterMs: 9000 } } }) });
  await h.flush();
  assert.equal(h.server.reads, 1);
  await h.run(3299);
  assert.equal(h.server.reads, 1, '간격 × (1 + 0.5 × 0.2) 전에는 묻지 않는다');
  await h.run(1);
  assert.equal(h.server.reads, 2);
  h.setVisible(false);
  await h.run(20_000);
  assert.equal(h.server.reads, 2, '숨긴 동안은 묻지 않는다');
  h.f.sendAppeal('설명을 부탁합니다');
  await h.flush();
  Object.assign(h.server, { state: 'PASSED', passedVia: 'APPEAL', graceUntil: null });
  h.setVisible(true);
  await h.flush();
  assert.equal(h.server.reads, 3, '다시 보이면 바로 묻는다');
  assert.equal(h.last().phase, 'accepted');
  // 차례가 지났는지는 상태 읽기의 graceUntil로 가른다: 없으면 차례 전이라 입장 확정을 부르지 않는다
  assert.deepEqual(h.server.admits, []);
  assert.equal(h.last().turn, 'before');
  await h.run(60_000);
  assert.equal(h.server.reads, 3, '결과 뒤에는 묻지 않는다');
  assert.deepEqual(h.navs, ['/queue/e1']);
  // 인정이고 차례가 지났으면(graceUntil 있음 → 입장 확정 ADMITTED) '바로 입장합니다'
  const b = harness({ server: fakeServer({ state: 'PASSED', passedVia: 'APPEAL', graceUntil: '2026-11-10T03:15:00.000Z', appeal: { appealId: '11111111-1111-4111-8111-111111111111', receivedAt: RECEIVED }, admitReply: { status: 200, body: { status: 'ADMITTED', admissionToken: 'adm.t' } } }) });
  await b.flush();
  assert.equal(b.last().phase, 'accepted');
  assert.equal(b.last().turn, 'after');
  await b.run(1000);
  assert.deepEqual(b.navs, ['/booking/e1/seats']);
  h.f.dispose();
  b.f.dispose();
});

test('상태 읽기 404·403은 공연 상세로, 첫 읽기가 일시 실패면 다시 시도를 보이고 늘려 가며 다시 묻는다', async () => {
  for (const e of [apiError(404, 'queue-entry-not-found'), apiError(404, 'queue-not-found'), apiError(403, 'identity-verification-required')]) {
    const server = fakeServer();
    server.readNext.push({ throw: e });
    const h = harness({ server });
    await h.flush();
    assert.equal(h.last().phase, 'leaving', e.type);
    assert.deepEqual(h.navs, ['/events/e1'], e.type);
    h.f.dispose();
  }
  const server = fakeServer();
  server.readNext.push({ throw: apiError(503, 'dependency-unavailable', '2') });
  const h = harness({ server });
  await h.flush();
  assert.equal(h.last().phase, 'load-failed');
  await h.run(2199);
  assert.equal(h.server.reads, 1);
  await h.run(1);
  assert.equal(h.server.reads, 2);
  assert.equal(h.last().phase, 'verifying');
  h.f.dispose();
});

test('이의 글은 NFC 정규화 뒤 grapheme 1,000자까지 보내고 1,001자는 보내지 않는다(합친 글자 경계), 503이면 Retry-After 뒤 같은 글로 다시 보낸다', async () => {
  const h = harness({ pollMs: 600_000 });
  await h.flush();
  // 'e' + 결합 악센트(U+0301)는 한 글자다. NFC로 합쳐도 한 글자
  const thousand = 'é'.repeat(1000);
  assert.equal(h.f.sendAppeal(`${thousand}가`), 'too-long');
  assert.equal(h.server.appeals().length, 0);
  // 국기 그림 글자(지역 표시 글자 둘)도 한 글자. ZWJ(U+200D)로 이은 그림 글자는 둘 수 없는 글자라 쓰지 않는다(서버 400)
  const family = '\u{1F1F0}\u{1F1F7}';
  h.server.next.push({ appeal: true, throw: apiError(503, 'dependency-unavailable', '3') });
  assert.equal(h.f.sendAppeal(`${'가'.repeat(999)}${family}`), 'sent');
  await h.flush();
  assert.equal(h.last().appeal, 'retry');
  await h.run(3299);
  assert.equal(h.server.appeals().length, 1);
  await h.run(1);
  assert.equal(h.server.appeals().length, 2);
  assert.equal(h.server.appeals()[1].body.appeal, h.server.appeals()[0].body.appeal);
  assert.equal(h.last().appeal, 'received');
  // 정확히 1,000자(NFC 뒤)는 보낸다
  const x = harness({ pollMs: 600_000 });
  await x.flush();
  assert.equal(x.f.sendAppeal(thousand), 'sent');
  await x.flush();
  assert.equal(x.server.appeals()[0].body.appeal, thousand.normalize('NFC'));
  h.f.dispose();
  x.f.dispose();
});
