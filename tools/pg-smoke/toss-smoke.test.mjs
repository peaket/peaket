// 토스 스모크 스크립트의 시험(P-T16, docs/features/payment.md §2.1 '계약 시험과 실제 결제사 호출의 몫', BUILD_ORDER HOT-145).
// 실제 토스 서버를 부르지 않는다. 키 없음은 건너뜀 경로로, 응답 모양 대조는 고정 파일과 가짜 fetch로 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkReply, run, SMOKE_CASES } from './toss-smoke.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/toss-responses.json', import.meta.url), 'utf8'));
const TEST_KEY = `test_sk_${'a'.repeat(24)}`;

const replyOf = (name) => ({ status: fixtures[name].status, json: fixtures[name].body });
const notFoundCase = SMOKE_CASES.find((c) => c.name === 'not-found');
const testCodeCase = SMOKE_CASES.find((c) => c.name === 'test-code');

function fakeFetch(replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = replies.shift();
    if (!r) throw new Error('답을 더 정하지 않았다');
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(fixtures[r].body), { status: fixtures[r].status });
  };
  return { fn, calls };
}

function capture() {
  const lines = [];
  return { lines, log: (l) => lines.push(l), text: () => lines.join('\n') };
}

test('P-T16 고정 파일 머리에 실제 호출 기록이 아니라고 적혀 있다 [ASVS v5.0.0-13.3.1]', () => {
  assert.match(fixtures._provenance, /실제 호출 기록이 아니다/);
});

test('P-T16 공식 모양의 없는 결제 응답은 문제 없음', () => {
  assert.deepEqual(checkReply(notFoundCase, replyOf('notFound')), []);
});

test('P-T16 공식 모양의 시험 코드 응답은 문제 없음', () => {
  assert.deepEqual(checkReply(testCodeCase, replyOf('testCodeRejected')), []);
});

test('P-T16 코드가 다르면 문제다', () => {
  assert.equal(checkReply(testCodeCase, replyOf('wrongCode')).length, 1);
});

test('P-T16 message가 없으면 문제다', () => {
  assert.equal(checkReply(notFoundCase, replyOf('noMessage')).length, 1);
});

test('P-T16 상태가 다르면 문제다', () => {
  assert.ok(checkReply(notFoundCase, replyOf('serverError')).length >= 1);
});

test('P-T16 JSON이 아니면 문제다', () => {
  assert.ok(checkReply(notFoundCase, { status: 404, json: undefined }).length >= 1);
});

test('P-T16 키가 없으면 건너뜀을 출력하고 성공하며 아무도 부르지 않는다 [ASVS v5.0.0-13.3.1]', async () => {
  const { fn, calls } = fakeFetch([]);
  const out = capture();
  assert.equal(await run({ env: {}, fetch: fn, log: out.log }), 0);
  assert.equal(calls.length, 0);
  assert.match(out.text(), /건너뜀/);
});

test('P-T16 리뷰 고침 L5: 저장소 변수가 켜져 있는데 키가 없으면 실패로 끝내고 아무도 부르지 않는다 [ASVS v5.0.0-13.3.1]', async () => {
  const { fn, calls } = fakeFetch([]);
  const out = capture();
  assert.equal(await run({ env: { PEAKET_PG_SMOKE_ENABLED: 'true' }, fetch: fn, log: out.log }), 1);
  assert.equal(calls.length, 0);
  assert.match(out.text(), /실패/);
  assert.doesNotMatch(out.text(), /건너뜀/);
});

test('P-T16 리뷰 고침 L5: 변수가 true가 아니면 키가 없어도 건너뛴다', async () => {
  for (const PEAKET_PG_SMOKE_ENABLED of ['false', '', undefined]) {
    const { fn, calls } = fakeFetch([]);
    const out = capture();
    assert.equal(await run({ env: { PEAKET_PG_SMOKE_ENABLED }, fetch: fn, log: out.log }), 0);
    assert.equal(calls.length, 0);
    assert.match(out.text(), /건너뜀/);
  }
});

test('P-T16 리뷰 고침 L5: 워크플로가 저장소 변수를 환경 값으로 스크립트에 넘긴다', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/pg-smoke.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^\s+PEAKET_PG_SMOKE_ENABLED: \$\{\{ vars\.PEAKET_PG_SMOKE_ENABLED \}\}\s*$/m);
});

test('P-T16 리뷰 고침 L6: 고정 파일 머리에 응답 칸 일부만 적었다고 적혀 있다 [ASVS v5.0.0-13.3.1]', () => {
  assert.match(fixtures._provenance, /응답 칸 일부만/);
});

test('P-T16 키가 test_로 시작하지 않으면 부르지 않고 실패하며 키를 출력하지 않는다 [ASVS v5.0.0-13.3.1]', async () => {
  const secret = `live_sk_${'b'.repeat(24)}`;
  const { fn, calls } = fakeFetch([]);
  const out = capture();
  assert.equal(await run({ env: { TOSS_DOCS_TEST_SECRET_KEY: secret }, fetch: fn, log: out.log }), 1);
  assert.equal(calls.length, 0);
  assert.ok(!out.text().includes(secret));
});

test('P-T16 두 호출이 공식 모양이면 성공한다(Basic 인증, 시험 코드 머리, 리디렉션을 따르지 않음) [ASVS v5.0.0-16.2.5]', async () => {
  const { fn, calls } = fakeFetch(['notFound', 'testCodeRejected']);
  const out = capture();
  assert.equal(await run({ env: { TOSS_DOCS_TEST_SECRET_KEY: TEST_KEY }, fetch: fn, log: out.log }), 0);
  assert.equal(calls.length, 2);
  const expected = `Basic ${Buffer.from(`${TEST_KEY}:`).toString('base64')}`;
  for (const c of calls) {
    assert.equal(new Headers(c.init.headers).get('authorization'), expected);
    assert.equal(c.init.redirect, 'manual');
    assert.ok(new URL(c.url).origin === 'https://api.tosspayments.com');
    assert.ok(!c.url.includes(TEST_KEY));
  }
  assert.equal(new Headers(calls[1].init.headers).get('TossPayments-Test-Code'), 'INVALID_REJECT_CARD');
  assert.ok(!out.text().includes(TEST_KEY));
});

test('P-T16 응답 모양이 다르면 실패로 끝나고 키를 출력하지 않는다', async () => {
  const { fn } = fakeFetch(['notFound', 'wrongCode']);
  const out = capture();
  assert.equal(await run({ env: { TOSS_DOCS_TEST_SECRET_KEY: TEST_KEY }, fetch: fn, log: out.log }), 1);
  assert.ok(!out.text().includes(TEST_KEY));
});

test('P-T16 호출 오류의 글에 키가 들어 있어도 출력에 키를 싣지 않는다 [ASVS v5.0.0-13.3.1] [ASVS v5.0.0-16.2.5]', async () => {
  const { fn } = fakeFetch([new TypeError(`요청 실패: authorization=${TEST_KEY}`)]);
  const out = capture();
  assert.equal(await run({ env: { TOSS_DOCS_TEST_SECRET_KEY: TEST_KEY }, fetch: fn, log: out.log }), 1);
  assert.ok(!out.text().includes(TEST_KEY));
});

test('P-T16 연결이 실패하면 실패로 끝난다', async () => {
  const { fn } = fakeFetch([new TypeError('끊김')]);
  const out = capture();
  assert.equal(await run({ env: { TOSS_DOCS_TEST_SECRET_KEY: TEST_KEY }, fetch: fn, log: out.log }), 1);
});
