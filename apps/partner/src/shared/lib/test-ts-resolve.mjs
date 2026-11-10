// node --test에서 작업 공간 패키지 원본을 읽는 가져오기 갈고리(시험 전용, apps/web의 같은 이름 파일 꼴). 시험이 module.register로 건다.
// - '@peaket/seatmap/grid'·'/layout'·'/engine'은 패키지 원본 파일로 푼다(좌석맵 에디터는 뿌리 대신 하위 경로를 쓴다, ADR-0264 결정 42).
// - 확장자 없는 상대 가져오기(./layout)는 .ts로 푼다(패키지 원본이 번들러 꼴로 쓴다).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEATMAP = Object.fromEntries(['grid', 'layout', 'engine'].map((n) => [`@peaket/seatmap/${n}`, new URL(`../../../../../packages/seatmap/src/${n}.ts`, import.meta.url).href]));
const SRC = new URL('../../', import.meta.url);

export async function resolve(spec, ctx, next) {
  if (Object.hasOwn(SEATMAP, spec)) return { shortCircuit: true, url: SEATMAP[spec] };
  // next는 exports 칸이 없어 하위 경로에 확장자를 붙인다
  if (spec === 'next/server') return next('next/server.js', ctx);
  // 경로 별칭 @/ → src/(tsconfig paths)
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
