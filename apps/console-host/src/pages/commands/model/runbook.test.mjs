// 런북 CLI 한 줄 시험(F-03-7 T20, C-T7 ③, 시험 먼저).
// 정본: docs/features/control-tower.md §5(명령 형식)·§4 T10(ack 시간 초과 뒤 런북 CLI 안내).
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
const load = () => import('./runbook.ts');
const C1 = '6f1c1b5e-1d2a-4f3b-9c4d-5e6f7a8b9c0d';
const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';

test('F-03-7 T20 C-T7 ③ FAILED 명령은 정본 형식의 런북 CLI 한 줄(명령 ID·회차·사유·출력 파일)을 보여 준다', async () => {
  const { runbookLineOf } = await load();
  const line = runbookLineOf({ commandId: C1, type: 'KILL_SWITCH', eventId: E, reason: '결제사 "승인" 지연\n재시도' });
  assert.ok(line.startsWith('peaket-runbook draft KILL_SWITCH --event '), line);
  assert.ok(line.includes(`--event ${E}`));
  assert.ok(line.includes(`--command-id ${C1}`));
  assert.ok(line.includes(`--out ${C1}.json`));
  assert.ok(line.includes('--reason "결제사 \\"승인\\" 지연 재시도"'), '사유는 한 줄로 막고 따옴표를 이스케이프한다');
  assert.equal(line.includes('\n'), false);
  assert.equal(line.includes('token'), false, '토큰·비밀값은 넣지 않는다');
  assert.equal(runbookLineOf({ type: 'KILL_SWITCH', reason: '사유' }), null, '명령 ID가 없으면 만들지 않는다');
  assert.equal(runbookLineOf({ commandId: C1, reason: '사유' }), null, '유형이 없으면 만들지 않는다');
  assert.ok(!runbookLineOf({ commandId: C1, type: 'ADMISSION_TARGET', reason: '사유' }).includes('--event'), '회차가 없으면 --event를 넣지 않는다');
});
