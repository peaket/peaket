// node --test에서 connection.ts를 원본 그대로 읽는 가져오기 갈고리(시험 전용, F-03-1). connection.test.mjs가 module.register로 건다.
// - 경로 별칭 @/ → apps/console-host/src/(tsconfig paths)
// - 확장자 없는 상대 가져오기(./live-stream, ../index)는 .ts로 푼다(번들러 꼴 원본)
// - 저장소 안 원본 .ts(node_modules 밖)는 타입 바꾸기(transform)로 읽는다: 콘솔·api-client 원본이 생성자 인자 속성(private readonly)을 써 Node 기본 타입 지우기(strip)로는 읽히지 않는다
// 이름이 *.test.mjs로 끝나지 않아 node --test가 시험 파일로 돌리지 않는다.
import { existsSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const SRC = new URL('../../../', import.meta.url);
/** 저장소 뿌리(작업 공간 패키지 원본 .ts도 같은 까닭으로 바꿔 읽는다, 예 @peaket/api-client) */
const ROOT = new URL('../../../../../../', import.meta.url);

export async function resolve(spec, ctx, next) {
  if (spec.startsWith('@/')) {
    for (const ext of ['.ts', '.tsx', '/index.ts']) {
      const u = new URL(spec.slice(2) + ext, SRC);
      if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
    }
  }
  if (spec.startsWith('.') && ctx.parentURL?.startsWith('file:') && !/\.[a-z]+$/i.test(spec)) {
    const base = new URL(spec, ctx.parentURL);
    for (const ext of ['.ts', '/index.ts']) {
      const u = new URL(base.href.replace(/\/$/, '') + ext);
      if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
    }
  }
  return next(spec, ctx);
}

export async function load(url, ctx, next) {
  if (url.startsWith(ROOT.href) && url.endsWith('.ts') && !url.includes('/node_modules/')) {
    const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url });
    return { format: 'module', source, shortCircuit: true };
  }
  return next(url, ctx);
}
