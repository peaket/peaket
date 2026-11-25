// F-05-10 판정 소리·진동·화면 낭독 시험(계획 docs/review/plans/F-05-10.md §3·§5).
// 정본: docs/features/offline-gate.md O-T14(색·아이콘·텍스트·비프음·햅틱 진동을 동시에, 화면 낭독기로 판정 결과를 읽는다),
// docs/design/d5 §8.3 판정 문구. 소리 종류·진동 패턴 값은 계획이 정하지 않았으므로 '서로 다르고 비어 있지 않다'를 본다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

type Feedback = { tone: string; icon: string; sound: string; vibrationMs: readonly number[]; announcement: string };
type FeedbackModule = {
  feedbackOf(outcome: unknown): Feedback;
  emitFeedback(
    feedback: Feedback,
    port: {
      play?(sound: string): void | Promise<void>;
      vibrate?(pattern: readonly number[]): void;
      announce?(text: string): void;
    },
  ): Promise<void>;
};

const MODULE = '../src/judge/feedback.ts';
const loaded = (await import(MODULE).catch(() => ({}))) as Partial<FeedbackModule>;
function fb(): FeedbackModule {
  for (const name of ['feedbackOf', 'emitFeedback'] as const) {
    assert.equal(typeof loaded[name], 'function', `${MODULE}의 ${name}가 없다`);
  }
  return loaded as FeedbackModule;
}

const PASS = {
  result: 'PASS',
  direction: 'IN',
  ticketId: '0190f3a1-7c2e-7a00-8b2a-000000000001',
  keyId: 'ldN7EyqkmYs',
  qrTimestampMs: 1_000,
  seatLabel: 'R구역 12열 8번',
};
const REJECT = { result: 'REJECT', reason: 'WRONG_ZONE', direction: 'IN', ticketGateZone: '서문' };
const CHECK = {
  result: 'CHECK',
  reason: 'NO_EXIT_RECORD',
  direction: 'IN',
  ticketId: '0190f3a1-7c2e-7a00-8b2a-000000000001',
  keyId: 'ldN7EyqkmYs',
  qrTimestampMs: 1_000,
  seatLabel: 'R구역 12열 8번',
};
const RETRY = { result: 'RETRY' };

test('O-T14 통과·거부·확인 필요·다시 찍기는 서로 다른 소리와 진동으로 알린다', () => {
  const f = fb();
  const pass = f.feedbackOf(PASS);
  const reject = f.feedbackOf(REJECT);
  const check = f.feedbackOf(CHECK);
  const retry = f.feedbackOf(RETRY);

  assert.deepEqual([pass.tone, reject.tone, check.tone, retry.tone], ['pass', 'reject', 'check', 'retry']);
  assert.equal(new Set([pass.sound, reject.sound, check.sound, retry.sound]).size, 4, '소리 넷이 서로 다르다');
  for (const [name, x] of Object.entries({ pass, reject, check, retry })) {
    assert.ok(x.icon.length > 0, `${name} 아이콘이 있다`);
    assert.ok(x.vibrationMs.length > 0, `${name} 진동 패턴이 있다`);
    assert.equal(x.vibrationMs.every((n) => Number.isFinite(n) && n >= 0), true, `${name} 진동 값은 0 이상 수다`);
  }
  const patterns = new Set([pass, reject, check, retry].map((x) => JSON.stringify(x.vibrationMs)));
  assert.equal(patterns.size, 4, '진동 패턴 넷이 서로 다르다');
  assert.notEqual(pass.icon, reject.icon);
});

test('O-T14 판정 결과를 색·아이콘·글자와 함께 화면 낭독기 문장으로 알린다', () => {
  const f = fb();
  const pass = f.feedbackOf(PASS);
  const reject = f.feedbackOf(REJECT);
  const check = f.feedbackOf(CHECK);
  const retry = f.feedbackOf(RETRY);

  assert.match(pass.announcement, /통과/);
  assert.match(pass.announcement, /R구역 12열 8번/);
  assert.match(reject.announcement, /거부/);
  assert.match(reject.announcement, /서문/);
  assert.match(check.announcement, /확인 필요/);
  assert.match(check.announcement, /퇴장 기록 없음/);
  assert.match(retry.announcement, /다시 찍어 주세요/);
  // 한 문장으로 읽고 사유·좌석을 빠뜨리지 않는다
  for (const x of [pass, reject, check, retry]) {
    assert.equal(x.announcement.trim().endsWith('.'), true, `낭독 문장이 마침표로 끝난다: ${x.announcement}`);
  }
});

test('O-T14 소리·진동이 막힌 브라우저에서도 글자·아이콘·낭독은 그대로다', async () => {
  const f = fb();
  const feedback = f.feedbackOf(PASS);
  const announced: string[] = [];
  await f.emitFeedback(feedback, {
    play: () => {
      throw new Error('AudioContext가 막혔다');
    },
    vibrate: () => {
      throw new Error('진동이 막혔다');
    },
    announce: (text) => void announced.push(text),
  });
  assert.deepEqual(announced, [feedback.announcement], '소리·진동 실패와 상관없이 낭독은 한 번 한다');
  assert.equal(feedback.icon.length > 0, true);

  // 포트가 아예 없는 브라우저(소리·진동 API 없음)도 던지지 않는다
  await f.emitFeedback(feedback, {});
  // 낭독까지 막혀도 판정 결과를 바꾸지 않는다
  await f.emitFeedback(feedback, {
    announce: () => {
      throw new Error('낭독기가 없다');
    },
  });
});
