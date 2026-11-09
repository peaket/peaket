// Next.js 앱(Turbopack)이 SEED recipe의 층 판을 고르게 하는 별칭 표(docs/design/d2 §1 'CSS 층 순서', FE-T36, BUILD_ORDER BAS-170).
// Turbopack은 조건부 별칭에서 browser 조건만 받아 SEED 패키지의 내보내기 조건 seed-layered를 고르지 못한다.
// 그래서 recipe 모듈마다 '@seed-design/css/recipes/<부품>' → 그 층 판 모듈 파일(<부품>.layered.mjs, 앱 폴더 기준 상대 경로)을
// next.config.ts의 turbopack.resolveAlias에 준다. 대상을 패키지 이름('@seed-design/css/recipes/<부품>.layered')으로 주면
// Turbopack은 그것을 앱 폴더에서 풀다가(앱은 @seed-design/css를 직접 잇지 않는다) 못 찾고, 오류 없이 원래 요청(층 없는 판)을
// 쓴다(FE-T36 PoC 2026-11-04). 그래서 @peaket/ds가 잇는 판의 파일 경로를 준다.
// 부품 목록은 붙인 @seed-design/css 판의 recipes 폴더에서 읽는다(판이 바뀌어도 표를 손으로 고치지 않는다).
// Vite 앱은 resolve.conditions, webpack 앱은 resolve.conditionNames에 seed-layered를 넣는다(이 표를 쓰지 않는다).
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';

const LAYERED = '.layered.mjs';

/**
 * @param {string} appDir next.config.ts가 있는 앱 폴더(import.meta.dirname)
 * @returns {Record<string, string>} recipe 모듈 이름 → 층 판 모듈 파일(앱 폴더 기준 상대 경로)
 */
export function seedLayeredAlias(appDir) {
  const require = createRequire(import.meta.url);
  const recipes = join(dirname(require.resolve('@seed-design/css/package.json')), 'recipes');
  const names = readdirSync(recipes)
    .filter((f) => f.endsWith(LAYERED))
    .map((f) => f.slice(0, -LAYERED.length))
    .sort();
  if (names.length === 0) throw new Error(`SEED recipe 층 판(*${LAYERED})이 ${recipes}에 없다`);
  const target = (n) => `./${relative(appDir, join(recipes, `${n}${LAYERED}`)).split(sep).join('/')}`;
  return Object.fromEntries(names.map((n) => [`@seed-design/css/recipes/${n}`, target(n)]));
}
