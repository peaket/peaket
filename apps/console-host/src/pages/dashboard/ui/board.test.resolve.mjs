// node --test에서 대시보드 보드(.tsx)를 서버 그리기로 읽는 가져오기 갈고리(시험 전용, F-03-1 RV-04). live-sources.test.mjs가 module.register로 건다.
// - 저장소 안 .ts·.tsx(node_modules 밖)는 esbuild(콘솔 빌드의 esbuild-loader가 쓰는 같은 판)로 JSX·타입을 바꿔 읽는다
// - .css 가져오기는 빈 모듈로, 경로 별칭 @/ → apps/console-host/src/, 확장자 없는 상대 가져오기는 .ts·.tsx로 푼다
// 이름이 *.test.mjs로 끝나지 않아 node --test가 시험 파일로 돌리지 않는다.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = new URL('../../../', import.meta.url);
const ROOT = new URL('../../../../../../', import.meta.url);
const esbuild = createRequire(createRequire(fileURLToPath(new URL('../../../../package.json', import.meta.url))).resolve('esbuild-loader'))('esbuild');

const firstExisting = (base) => {
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const u = new URL(base.replace(/\/$/, '') + ext);
    if (ext === '' && !/\.[a-z]+$/i.test(u.pathname)) continue;
    if (existsSync(fileURLToPath(u))) return u.href;
  }
  return undefined;
};

export async function resolve(spec, ctx, next) {
  if (spec.endsWith('.css')) return { shortCircuit: true, url: 'data:text/javascript,export default {}' };
  if (spec.startsWith('@/')) {
    const hit = firstExisting(new URL(spec.slice(2), SRC).href);
    if (hit) return next(hit, ctx);
  }
  if (spec.startsWith('.') && ctx.parentURL?.startsWith('file:') && !/\.(m?js|json)$/i.test(spec)) {
    const hit = firstExisting(new URL(spec, ctx.parentURL).href);
    if (hit) return next(hit, ctx);
  }
  const r = await next(spec, ctx);
  // 작업 공간 패키지(@peaket/*)가 원본 .tsx를 가리키면 그대로 둔다(load가 바꾼다)
  return r;
}

export async function load(url, ctx, next) {
  if (url.startsWith(ROOT.href) && /\.(tsx?|mts)$/.test(url) && !url.includes('/node_modules/')) {
    const path = fileURLToPath(url);
    const { code } = await esbuild.transform(readFileSync(path, 'utf8'), { loader: path.endsWith('x') ? 'tsx' : 'ts', format: 'esm', jsx: 'automatic', target: 'es2022', sourcefile: path });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return next(url, ctx);
}

export const rootUrl = pathToFileURL(fileURLToPath(ROOT)).href;
