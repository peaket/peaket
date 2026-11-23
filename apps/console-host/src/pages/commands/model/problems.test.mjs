// 명령 요청의 문제 응답(403·409·422·5xx) → 우리 글(F-03-4 T4·T9·T12 공통, 시험 먼저 ADR 0372번).
// 정본: docs/api/openapi.yaml createOpsCommand·approvals·reversions 응답 설명(403 reauth-required·command-role-forbidden·command-requester-cannot-approve,
// 409 command-not-pending, 422 command-out-of-range(detail에 걸린 한계 이름), 503 reauth-unavailable),
// docs/design/d5-screen-blueprint.md §9.2(공통 403 '이 작업을 할 권한이 없습니다', 공통 500 '일시적인 오류입니다. 잠시 후 다시 시도해 주세요',
// 403 reauth-required '다시 로그인한 확인이 만료되었거나 이미 쓰였습니다'), §7.3('이미 처리됐으면 409'), docs/frontend.md §4.1 '오류 모양'(서버 title·detail 원문은 보이지 않는다),
// 계획 docs/review/plans/F-03-4.md §4 problems.ts·1-4.
// 구현 전 트리에는 model/problems.ts가 없어 가져오기부터 실패한다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);

const load = () => import('./problems.ts');
const TITLE = '서버 원문 제목 <b>내부</b>';
const DETAIL = 'sql: relation command_actor violates unique';

test('F-03-4 T4 C-T5 ③-1 403 reauth-required·503 reauth-unavailable은 다시 인증할 글이고 서버 원문은 싣지 않는다', async () => {
  const { commandProblemMessage } = await load();
  const required = commandProblemMessage({ status: 403, type: 'reauth-required', title: TITLE, detail: DETAIL });
  assert.match(required, /다시 로그인한 확인이 만료되었거나 이미 쓰였습니다/);
  const unavailable = commandProblemMessage({ status: 503, type: 'reauth-unavailable', title: TITLE });
  assert.match(unavailable, /^지금은 다시 로그인한 확인을 하지 못했습니다/);
  for (const m of [required, unavailable]) {
    assert.equal(m.includes(TITLE), false);
    assert.equal(m.includes(DETAIL), false);
  }
});

test('F-03-4 T4 C-T5 ③-2 422 command-out-of-range는 걸린 한계 이름(detail)만 덧붙이고, 그 밖의 문제는 detail·title을 보이지 않는다', async () => {
  const { commandProblemMessage } = await load();
  const range = commandProblemMessage({ status: 422, type: 'command-out-of-range', title: TITLE, detail: 'admissionTargetMax' });
  assert.match(range, /안전 한계/);
  assert.match(range, /admissionTargetMax/);
  assert.equal(range.includes(TITLE), false);
  for (const p of [
    { status: 422, type: 'invalid-command' },
    { status: 409, type: 'command-not-pending' },
    { status: 409, type: 'event-cancelled' },
    { status: 403, type: 'command-role-forbidden' },
    { status: 403, type: 'command-requester-cannot-approve' },
    { status: 502, type: 'command-dispatch-failed' },
    { status: 500, type: 'about:blank' },
  ]) {
    const m = commandProblemMessage({ ...p, title: TITLE, detail: DETAIL });
    assert.ok(m.length > 0, p.type);
    assert.equal(m.includes(TITLE), false, p.type);
    assert.equal(m.includes(DETAIL), false, p.type);
  }
});

test('F-03-4 T9 C-T4 ②-1 요청자 본인 403은 "요청자 본인은 승인할 수 없습니다", 409 command-not-pending은 이미 처리된 승인 글이다', async () => {
  const { commandProblemMessage } = await load();
  assert.equal(commandProblemMessage({ status: 403, type: 'command-requester-cannot-approve' }), '요청자 본인은 승인할 수 없습니다');
  assert.match(commandProblemMessage({ status: 409, type: 'command-not-pending' }), /이미 처리/);
});

test('F-03-4 T8 C-T46 ③-3 역할 밖 403은 d5 공통 403 글로, 500은 d5 공통 500 글로 보인다', async () => {
  const { commandProblemMessage } = await load();
  assert.match(commandProblemMessage({ status: 403, type: 'command-role-forbidden' }), /^이 작업을 할 권한이 없습니다/);
  assert.equal(commandProblemMessage({ status: 500, type: 'about:blank', title: TITLE }), '일시적인 오류입니다. 잠시 후 다시 시도해 주세요');
});
