// 정본 파일로 도는 토큰 검사(docs/frontend.md §5.17 FE-T44·FE-T45, BUILD_ORDER BAS-170).
// tokens.json·d2 §5 대비표·붙인 @seed-design/css 판을 그대로 읽는다. 규칙 하나하나의 시험은 token-rules.test.mjs에 있다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCanon } from '../scripts/token-canon.mjs';
import { lintTokens, checkSeedSelectors, parseContrastTable, checkContrast, LIGHT_SELECTORS, DARK_SELECTORS } from '../scripts/token-rules.mjs';

const canon = await loadCanon();

test('FE-T45 정본 tokens.json은 붙인 SEED 판에서 형식 검사 위반이 없다', () => {
  assert.deepEqual(lintTokens(canon.tokens, canon.seed), []);
});

test('FE-T45 토큰 빌드의 색 모드 선택자는 붙인 SEED base의 선택자를 모두 담는다', () => {
  assert.deepEqual(checkSeedSelectors(canon.seed.colorModes, { light: LIGHT_SELECTORS, dark: DARK_SELECTORS }), []);
});

test('FE-T44 d2 §5 대비표의 짝이 모두 기준을 넘고 측정치가 tokens.json 계산값과 같다', () => {
  const { rows, problems } = parseContrastTable(canon.d2);
  assert.deepEqual(problems, []);
  // 표가 통째로 사라져 검사할 짝이 없는 것도 실패로 본다(2026-11-04 기준 37행)
  assert.ok(rows.length >= 37, `대비표 행이 ${rows.length}개뿐이다`);
  assert.deepEqual(checkContrast(canon.tokens, rows), []);
});
