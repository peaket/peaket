// 토큰 검사 명령줄(docs/frontend.md §5.17 FE-T44·FE-T45, BUILD_ORDER BAS-170).
//   node scripts/check-tokens.mjs    tokens.json 형식 검사와 d2 §5 대비표 계산. 문제가 있으면 종료 코드 1
// 같은 검사를 시험(test/tokens-canon.test.mjs)도 돈다. 이 명령은 문제 목록을 사람이 읽기 좋게 찍는다.
import { loadCanon } from './token-canon.mjs';
import { lintTokens, checkSeedSelectors, parseContrastTable, checkContrast, LIGHT_SELECTORS, DARK_SELECTORS } from './token-rules.mjs';

const canon = await loadCanon();
const table = parseContrastTable(canon.d2);
const sections = [
  ['형식 검사(FE-T45 ①~⑥)', lintTokens(canon.tokens, canon.seed)],
  ['색 모드 선택자(FE-T45 ⑦)', checkSeedSelectors(canon.seed.colorModes, { light: LIGHT_SELECTORS, dark: DARK_SELECTORS })],
  ['대비표(FE-T44)', [...table.problems, ...checkContrast(canon.tokens, table.rows)]],
];
let total = 0;
for (const [title, problems] of sections) {
  total += problems.length;
  console.log(`${problems.length === 0 ? '통과' : `문제 ${problems.length}`}: ${title}`);
  for (const p of problems) console.log(`  - ${p}`);
}
console.log(`@seed-design/css ${canon.seed.version}, SEED 변수 ${canon.seed.vars.size}개, 대비표 짝 ${table.rows.length}개`);
if (total > 0) process.exit(1);
