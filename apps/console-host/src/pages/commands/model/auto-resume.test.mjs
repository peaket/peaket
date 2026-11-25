// 자동 조절 복귀 확인 시험(F-03-7 T6, C-T31 ③, 시험 먼저).
// 정본: docs/features/control-tower.md §6의 6(입력 없음이 풀린 뒤 확인해야 자동 증액), C-T31 ③.
// 서버 확인 경로가 없어 대화상자는 띄우되 전송을 막는다(계획 '하지 않는다').
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
const load = () => import('./auto-resume.ts');

test('F-03-7 T6 C-T31 ③-1 입력 없음이 풀려 정상·일시정지로 돌아오면 복귀 확인이 열리고, 그 밖에는 열리지 않는다', async () => {
  const { autoResumePrompt } = await load();
  assert.equal(autoResumePrompt('no-input', 'ok'), 'open');
  assert.equal(autoResumePrompt('no-input', 'paused'), 'open');
  assert.equal(autoResumePrompt('no-input', 'no-input'), 'none');
  assert.equal(autoResumePrompt('no-input', 'unknown'), 'none');
  assert.equal(autoResumePrompt('ok', 'no-input'), 'none');
  assert.equal(autoResumePrompt('paused', 'no-input'), 'none');
  assert.equal(autoResumePrompt('unknown', 'ok'), 'none');
});

test('F-03-7 T6 C-T31 ③-2 확인 전송 경로가 없다는 것을 화면이 알 수 있게 내놓고, 확인하지 않은 상태를 성공으로 그리지 않는다', async () => {
  const { AUTO_RESUME_UNAVAILABLE, autoResumeView } = await load();
  assert.match(AUTO_RESUME_UNAVAILABLE, /경로/);
  const view = autoResumeView('open');
  assert.equal(view.kind, 'open');
  assert.equal(view.confirmable, false);
  assert.match(view.why, /경로/);
  assert.equal(autoResumeView('none').kind, 'none');
});
