// SCR-053 휴대폰 배치(BUILD_ORDER GAT-200): 휴대폰은 보기·즉시 폐기만 하고 기기 배치·등록·이름 변경은 큰 화면에서 한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const board = readFileSync(join(import.meta.dirname, '..', 'src', 'pages', 'scanner-devices', 'ui', 'board-m.tsx'), 'utf8');

test('O-T31 SCR-053 휴대폰 배치는 기기 배치를 바꾸지 않고 큰 화면으로 안내한다', () => {
  assert.match(board, /휴대폰에서는 볼 수만 있습니다/);
  assert.match(board, /기기 등록은 태블릿이나 데스크톱에서 합니다/);
  assert.doesNotMatch(board, /배치 변경|구역 선택|게이트 구역/);
});

test('O-T27 SCR-053 휴대폰 배치에서도 분실·도난 기기를 즉시 폐기할 수 있다', () => {
  assert.match(board, /즉시 폐기하기/);
  assert.match(board, /즉시 폐기합니다/);
  assert.match(board, /폐기하고 세션을 끝냅니다/);
  assert.match(board, /폐기하면 이 기기의 다음 요청부터 막히고/);
});
