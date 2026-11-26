// SCR-047 재개 화면 배선(F-07-15 I-06). 일시정지·재개 호출, 사유 필수, commander만, 재개 조건 표시를 본다.
// 기준 트리에는 새 호출·버튼·배지가 없어 실패한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const page = read('./ConnectedPage.tsx');
const model = read('../model/live.ts');

test('SCR047_일시정지와_재개를_생성_호출로_부른다', () => {
  assert.match(page, /createOpsEventCancellationPause/);
  assert.match(page, /createOpsEventCancellationResumption/);
  assert.match(page, /reason: .*trim\(\)/);
  assert.match(page, /pg: .*pg/);
});

test('SCR047_commander만_일시정지_재개를_누를_수_있다', () => {
  assert.match(page, /role === 'commander'/);
  assert.match(page, /disabled=\{.*commander/);
  assert.match(page, /title=.*commander/);
});

test('SCR047_재개_조건_배지를_결제사_몫마다_보인다', () => {
  assert.match(page, /resumeBadgeOf\(/);
  assert.match(page, /재개 조건/);
  assert.match(model, /resumeConditionOf/);
  assert.match(model, /ELIGIBLE/);
  assert.match(model, /NO_SAMPLE/);
  assert.match(model, /CIRCUIT_UNAVAILABLE/);
});

test('SCR047_조건이_나빠도_재개를_막지_않고_경고만_보인다', () => {
  assert.doesNotMatch(page, /disabled=\{.*state !== 'ELIGIBLE'/);
  assert.match(page, /tone === 'warn'|tone === 'muted'/);
});

test('SCR047_사유가_비면_보내지_않고_오류를_보인다', () => {
  assert.match(page, /사유를 적어 주세요/);
  assert.match(page, /if \(!.*reason.*trim\(\)\)/);
});
