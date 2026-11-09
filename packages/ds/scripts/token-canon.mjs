// 토큰 검사가 읽는 정본 파일(docs/frontend.md §5.17 FE-T44·FE-T45, BUILD_ORDER BAS-170).
// tokens.json, d2(§5 대비표), 붙인 @seed-design/css 판의 base 층 판 CSS와 중단점을 읽어 돌려준다.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedColorModeSelectors, seedVarsFromCss } from './token-rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../../..');
export const tokensPath = resolve(repoRoot, 'docs/design/tokens.json');
export const d2Path = resolve(repoRoot, 'docs/design/d2-design-system.md');

/** @peaket/ds가 잇는 @seed-design/css 폴더(판은 packages/ds/package.json과 잠금 파일이 정한다) */
export function seedCssDir() {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('@seed-design/css/package.json'));
}

export async function loadCanon() {
  const dir = seedCssDir();
  const baseCss = readFileSync(join(dir, 'base.layered.css'), 'utf8');
  const { breakpoints } = await import('@seed-design/css/breakpoints');
  return {
    tokens: JSON.parse(readFileSync(tokensPath, 'utf8')),
    d2: readFileSync(d2Path, 'utf8'),
    seed: {
      version: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version,
      vars: seedVarsFromCss(baseCss),
      breakpoints,
      colorModes: seedColorModeSelectors(baseCss),
    },
  };
}
