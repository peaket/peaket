// SCR-009 흐름: 묶음 리뷰(BAT-200 관점 넷) 화면 몫의 재현 시험. 503 뒤 새 토큰과 자동 다시 보내기 상한, 상태 읽기의 passedVia·graceUntil·appeal.text,
// 새로고침 뒤 바로 제출, 상태 읽기 409(docs/design/d5 §5.9 '챌린지 실패'·'제출 차례와 되살리기', docs/frontend.md §4.2.1 8·9번, ADR-0259 결정 12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_RETRY_MAX, apiError, fakeServer, harness, memory, NOW, queueRecord, RECEIVED } from './verify-flow.test.harness.mjs';

const tokens = (h) => h.server.challenges().map((x) => x.body.challengeToken);

test('제출 503 뒤에는 받았던 사람 확인 토큰을 버리고 위젯을 다시 돌린 새 토큰으로만 Retry-After 뒤에 다시 보낸다(연결 끊김도 같다)', async () => {
  const h = harness({ pollMs: 600_000 });
  h.server.next.push({ throw: apiError(503, 'dependency-unavailable', '7') });
  await h.flush();
  await h.reverify();
  assert.equal(h.last().submit, 'retry');
  assert.equal(h.last().retryAt, NOW + 7700);
  await h.run(7699);
  assert.deepEqual(tokens(h), ['hc-1', 'hc-1'], '하한 전에는 보내지 않는다(첫 줄은 재통과 전 바로 제출)');
  await h.run(1);
  assert.deepEqual(tokens(h), ['hc-1', 'hc-1', 'hc-2'], '503 뒤에는 쓴 토큰을 다시 보내지 않는다');
  assert.equal(h.checks.length, 2, '위젯을 다시 돌렸다');
  assert.equal(h.last().phase, 'passed');
  // 연결 끊김(상태 없음)도 서버가 토큰을 썼는지 모르므로 같다
  const c = harness({ pollMs: 600_000 });
  c.server.next.push({ throw: new TypeError('fetch failed') });
  await c.flush();
  await c.reverify();
  await c.run(2000);
  assert.deepEqual(tokens(c), ['hc-1', 'hc-1', 'hc-2']);
  // 429는 서버가 trust-svc를 부르기 전이라 토큰을 쓰지 않았다: 같은 토큰(그대로)
  const l = harness({ pollMs: 600_000 });
  l.server.next.push({ throw: apiError(429, 'verification-submit-limited', '3') });
  await l.flush();
  await l.reverify();
  await l.run(3300);
  assert.deepEqual(tokens(l), ['hc-1', 'hc-1', 'hc-1']);
  for (const x of [h, c, l]) x.f.dispose();
});

test("자동 다시 보내기는 정한 횟수(기본 3번 [가정], 시험 값 2번)까지이고 그 뒤에는 '다시 시도' 버튼 상태로 멈춘다", async () => {
  assert.equal(AUTO_RETRY_MAX, 3);
  const h = harness({ pollMs: 600_000, autoRetries: 2 });
  for (let i = 0; i < 3; i++) h.server.next.push({ throw: apiError(503, 'dependency-unavailable', '1') });
  await h.flush();
  await h.reverify();
  await h.run(60_000);
  assert.deepEqual(tokens(h), ['hc-1', 'hc-1', 'hc-2', 'hc-3'], '처음 하나 + 자동 2번');
  assert.equal(h.last().submit, 'stalled');
  assert.equal(h.last().retryAt, undefined);
  await h.run(600_000);
  assert.equal(tokens(h).length, 4, '버튼을 누르기 전에는 보내지 않는다');
  h.f.retrySubmit();
  await h.flush();
  assert.deepEqual(tokens(h).slice(4), ['hc-4'], '[다시 시도]도 새 토큰');
  assert.equal(h.last().phase, 'passed');
  // 기본값: 503 넷이면 자동 3번 뒤 멈춘다
  const d = harness({ pollMs: 600_000 });
  for (let i = 0; i < 4; i++) d.server.next.push({ throw: apiError(503, 'dependency-unavailable', '1') });
  await d.flush();
  await d.reverify();
  await d.run(60_000);
  assert.deepEqual(tokens(d), ['hc-1', 'hc-1', 'hc-2', 'hc-3', 'hc-4']);
  assert.equal(d.last().submit, 'stalled');
  for (const x of [h, d]) x.f.dispose();
});

test("상태 읽기의 passedVia로 문구를 고른다: APPEAL이면 '인정', CHALLENGE면 이의를 냈어도 '통과'", async () => {
  const appeal = { appealId: '11111111-1111-4111-8111-111111111111', receivedAt: RECEIVED, text: '설명' };
  const a = harness({ server: fakeServer({ state: 'PASSED', passedVia: 'APPEAL', appeal }) });
  await a.flush();
  assert.equal(a.last().phase, 'accepted');
  const b = harness({ server: fakeServer({ state: 'PASSED', passedVia: 'CHALLENGE', appeal }) });
  await b.flush();
  assert.equal(b.last().phase, 'passed', '이의를 냈어도 제출로 통과했으면 오탐 인정이 아니다');
  for (const x of [a, b]) x.f.dispose();
});

test('상태 읽기의 graceUntil이 있으면 차례가 지난 것이라 입장 확정으로 가고(곧 입장이면 대기실 turnAtMs를 통과 쪽으로 옮긴다), 없으면 입장 확정을 부르지 않고 대기실로 간다', async () => {
  const grace = '2026-11-10T03:15:00.000Z';
  const passAt = Date.parse(grace) - 15 * 60_000;
  const a = harness({
    server: fakeServer({ state: 'PASSED', passedVia: 'CHALLENGE', graceUntil: grace, admitReply: { status: 200, body: { status: 'SOON', retryAfterSeconds: 2 } } }),
    local: memory({ 'peaket.queue.e1': queueRecord({ turnAtMs: passAt - 600_000 }) }),
  });
  await a.flush();
  assert.equal(a.last().turn, 'after');
  assert.equal(a.server.admits.length, 1);
  assert.equal(JSON.parse(a.local.getItem('peaket.queue.e1')).turnAtMs, passAt);
  await a.run(1000);
  assert.deepEqual(a.navs, ['/queue/e1']);
  const b = harness({ server: fakeServer({ state: 'PASSED', passedVia: 'APPEAL', graceUntil: null, appeal: { appealId: '11111111-1111-4111-8111-111111111111', receivedAt: RECEIVED } }) });
  await b.flush();
  assert.equal(b.last().turn, 'before');
  assert.equal(b.server.admits.length, 0, '차례 전이면 입장 확정을 부르지 않는다(원래 순번의 차례에 대기실이 부른다)');
  await b.run(1000);
  assert.deepEqual(b.navs, ['/queue/e1']);
  for (const x of [a, b]) x.f.dispose();
});

test('새로고침 뒤에는 이 탭의 본인확인 기억 없이 사람 확인 토큰을 받으면 바로 제출해 보고, REVERIFY_REQUIRED면 ③ 본인확인으로 간다', async () => {
  // 재통과가 서버에 이미 있다(새로고침 전에 마침): 기억이 없어도 바로 통과
  const a = harness({ server: fakeServer({ reverified: true }), pollMs: 600_000 });
  await a.flush();
  assert.deepEqual(tokens(a), ['hc-1']);
  assert.equal(a.last().phase, 'passed');
  // 재통과가 없다: 서버가 REVERIFY_REQUIRED(토큰은 쓰지 않았다) → ③, 마치면 같은 토큰으로
  const b = harness({ pollMs: 600_000 });
  await b.flush();
  assert.deepEqual(tokens(b), ['hc-1']);
  assert.equal(b.last().submit, 'reverify');
  assert.equal(b.last().reverified, false);
  await b.run(30_000);
  assert.equal(tokens(b).length, 1, '본인확인을 마칠 때까지 다시 보내지 않는다');
  await b.reverify();
  assert.deepEqual(tokens(b), ['hc-1', 'hc-1']);
  assert.equal(b.last().phase, 'passed');
  for (const x of [a, b]) x.f.dispose();
});

test('보낸 이의 글은 상태 읽기의 appeal.text로 되살린다(글 그대로, 화면은 글 노드로 그린다)', async () => {
  const text = '<b>오픈 직전</b>에 새로고침을 여러 번 눌렀습니다';
  const h = harness({ server: fakeServer({ appeal: { appealId: '11111111-1111-4111-8111-111111111111', receivedAt: RECEIVED, text } }), pollMs: 600_000 });
  await h.flush();
  assert.equal(h.last().appeal, 'received');
  assert.equal(h.last().appealText, text);
  // 빈 글(설명 요구)도 그대로
  const e = harness({ server: fakeServer({ appeal: { appealId: '11111111-1111-4111-8111-111111111111', receivedAt: RECEIVED, text: '' } }), pollMs: 600_000 });
  await e.flush();
  assert.equal(e.last().appealText, '');
  for (const x of [h, e]) x.f.dispose();
});

test('상태 읽기 409 not-verifying(대기 참여는 있지만 추가 검증 중이 아님)이면 대기실로, 404면 공연 상세로 간다', async () => {
  for (const [e, to] of [[apiError(409, 'not-verifying'), '/queue/e1'], [apiError(404, 'queue-entry-not-found'), '/events/e1']]) {
    const server = fakeServer();
    server.readNext.push({ throw: e });
    const h = harness({ server });
    await h.flush();
    assert.deepEqual(h.navs, [to], e.type);
    assert.equal(h.server.challenges().length, 0, '위젯·제출을 하지 않는다');
    h.f.dispose();
  }
});

test('이의 글에 NUL·양방향 제어·0폭 글자(이모지를 잇는 U+200D 포함)가 있으면 보내지 않고 알린다(서버 400과 같은 규칙, bot-defense §12 접수)', async () => {
  const h = harness({ pollMs: 600_000 });
  await h.flush();
  for (const bad of ['a\u0000b', 'a\u202Ab', 'a\u202Eb', 'a\u2066b', 'a\u2069b', 'a\u200Bb', 'a\u200Cb', '\u{1F468}\u200D\u{1F469}', 'a\uFEFFb']) {
    assert.equal(h.f.sendAppeal(bad), 'bad-chars', JSON.stringify(bad));
  }
  await h.flush();
  assert.equal(h.server.appeals().length, 0);
  // 경계 밖 글자(U+2029 문단 나눔, U+202F 좁은 공백, 국기 그림 글자)는 보낸다
  assert.equal(h.f.sendAppeal('a\u202Fb \u{1F1F0}\u{1F1F7}'), 'sent');
  await h.flush();
  assert.equal(h.server.appeals().length, 1);
  h.f.dispose();
});

test("제출이 PASSED로 답했는데 이 참여에 이의를 냈으면 상태 읽기의 passedVia로 문구를 고른다(CS 인정과 제출이 겹친 경우 '인정')", async () => {
  const appeal = { appealId: '11111111-1111-4111-8111-111111111111', receivedAt: RECEIVED, text: '설명' };
  // 첫 읽기는 추가 검증 중(이의 접수됨). 그사이 CS가 인정해 서버는 이미 PASSED(APPEAL)라 제출에 200 PASSED를 다시 준다(passedVia 없음)
  const server = fakeServer({ state: 'PASSED', passedVia: 'APPEAL', appeal });
  server.readNext.push({ state: 'VERIFYING', verificationReason: 'RAPID_REQUESTS', passedVia: null, graceUntil: null, appeal });
  const h = harness({ server, pollMs: 600_000 });
  await h.flush();
  assert.equal(h.server.challenges().length, 1);
  assert.equal(h.last().phase, 'accepted');
  assert.equal(h.server.reads, 2, '문구를 고르려고 한 번 더 읽는다');
  // 이의가 없으면 다시 읽지 않고 '통과'
  const p = harness({ server: fakeServer({ reverified: true }), pollMs: 600_000 });
  await p.flush();
  assert.equal(p.last().phase, 'passed');
  assert.equal(p.server.reads, 1);
  for (const x of [h, p]) x.f.dispose();
});
