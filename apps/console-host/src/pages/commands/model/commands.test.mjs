// SCR-030 운영 명령 화면 모델 시험(BAT-465 GAT-300·GAT-310).
// 앱에 시험 도구가 아직 없어 Node 내장 시험 실행기로 돌린다(`pnpm --filter @peaket/console-host test`). 타입 지우기로 .ts를 그대로 읽는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canApprove,
  filterCommands,
  formatKstDateTime,
  isRetryable,
  mapCommandList,
  stateLabel,
  stateTone,
  typeLabel,
} from './commands.ts';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const OPENAPI = readFileSync(join(ROOT, 'docs/api/openapi.yaml'), 'utf8');

const row = (over = {}) => ({
  commandId: 'cmd-1',
  type: 'SCALE_CHANGE',
  state: 'SUCCEEDED',
  reason: '규모 올리기',
  requestedBy: { adminAccountId: 'acc-1', displayName: null, role: 'operator' },
  createdAt: '2026-11-14T01:00:00.000Z',
  updatedAt: '2026-11-14T01:00:00.000Z',
  approvals: [],
  attempts: 1,
  canApprove: false,
  ...over,
});

test('목록 응답은 명령 ID가 없는 항목을 버리고 화면 행으로 바꾼다', () => {
  const page = mapCommandList({
    items: [
      { commandId: 'a', type: 'SCALE_CHANGE', state: 'SUCCEEDED', reason: '올리기', attempts: 1, canApprove: false },
      { type: 'LOG_LEVEL', reason: 'ID 없음' },
    ],
    nextCursor: null,
  });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].commandId, 'a');
  assert.equal(page.items[0].attempts, 1);
  assert.equal(page.nextCursor, null);
});

test('상태 이름과 색은 SUCCEEDED·FAILED·PENDING_APPROVAL을 구분한다', () => {
  assert.equal(stateLabel('SUCCEEDED'), '성공');
  assert.equal(stateLabel('FAILED'), '실패');
  assert.equal(stateLabel('PENDING_APPROVAL'), '승인 대기');
  assert.equal(stateTone('SUCCEEDED'), 'success');
  assert.equal(stateTone('FAILED'), 'danger');
  assert.equal(stateTone('PENDING_APPROVAL'), 'warning');
});

test('유형 이름은 GAT-300·GAT-310 명령을 한국어로 보인다', () => {
  assert.equal(typeLabel('EVENT_CANCEL'), '회차 취소·일괄 환불');
  assert.equal(typeLabel('SCALE_CHANGE'), '회차 규모 올리기');
  assert.equal(typeLabel('KILL_SWITCH'), '판매 일시정지');
});

test('상태·유형·검색어로 거르고 실패만 재시도한다', () => {
  const items = [
    row({ commandId: 'a', state: 'SUCCEEDED', type: 'SCALE_CHANGE', reason: '규모 올리기' }),
    row({ commandId: 'b', state: 'FAILED', type: 'EVENT_CANCEL', reason: '회차 취소' }),
    row({ commandId: 'c', state: 'PENDING_APPROVAL', type: 'EVENT_CANCEL', reason: '취소 재확인' }),
  ];
  assert.deepEqual(filterCommands(items, { state: 'FAILED' }).map((x) => x.commandId), ['b']);
  assert.deepEqual(filterCommands(items, { type: 'EVENT_CANCEL' }).map((x) => x.commandId), ['b', 'c']);
  assert.deepEqual(filterCommands(items, { query: '규모' }).map((x) => x.commandId), ['a']);
  assert.equal(isRetryable(items[0]), false);
  assert.equal(isRetryable(items[1]), true);
});

test('승인 가능 여부는 서버가 준 canApprove만 따른다', () => {
  assert.equal(canApprove({ canApprove: true }), true);
  assert.equal(canApprove({ canApprove: false }), false);
});

test('시각은 KST로 보이고 잘못된 값은 —다', () => {
  assert.equal(formatKstDateTime('2026-11-14T01:00:00.000Z'), '11/14(토) 10:00 KST');
  assert.equal(formatKstDateTime('아님'), '—');
  assert.equal(formatKstDateTime(undefined), '—');
});

test('실제 경로는 연결 화면을 쓰고 디자인 보드는 ?state= 미리보기에만 남긴다', () => {
  const page = readFileSync(join(ROOT, 'apps/console-host/src/pages/commands/ui/Page.tsx'), 'utf8');
  assert.match(page, /__PREVIEW__ && sp\.get\('state'\) \? <BoardPage \/> : <ConnectedPage \/>/);
  assert.match(page, /function BoardPage/);
});

test('계약에 SUCCEEDED·SCALE_CHANGE·재시도·감사 체크포인트 경로가 있다', () => {
  assert.match(OPENAPI, /SUCCEEDED/);
  assert.match(OPENAPI, /SCALE_CHANGE/);
  assert.match(OPENAPI, /\/v1\/ops\/commands\/\{commandId\}\/retries/);
  assert.match(OPENAPI, /\/v1\/ops\/audit-checkpoints/);
});
