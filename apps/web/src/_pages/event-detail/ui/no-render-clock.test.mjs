// 공연 상세 화면 코드는 시계·난수를 직접 부르지 않는다(브라우저 시계는 효과 안에서 browserClock()으로 읽는다, docs/frontend.md §3.3).
// 그리는 중에 읽으면 Cache Components의 미리 그리기가 중단돼 ISR 항목이 저장되지 않는다(요청마다 뒤에서 다시 그리다 실패한다, tools/web-checks/budgets/isr.spec.mjs).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('공연 상세 화면 코드는 Date.now()·new Date()·Math.random()을 직접 부르지 않는다', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const files = readdirSync(dir).filter((n) => n.endsWith('.tsx'));
  assert.ok(files.length > 0);
  for (const n of files) assert.equal(/\bDate\.now\(\)|\bnew Date\(\)|\bMath\.random\(\)/.exec(stripComments(readFileSync(join(dir, n), 'utf8')))?.[0], undefined, n);
});
