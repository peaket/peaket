// node --test에서 확장자 없는 상대 import(./a, ../b/index)를 .ts로 푸는 등록 훅(시험 전용). 실행 파일이 아니라 시험이 module.register로 건다.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STUB = new URL('./test-api-client-stub.mjs', import.meta.url).href;

export async function resolve(spec, ctx, next) {
  if (spec === '@peaket/api-client' || spec === '@peaket/api-client/purchase') return { shortCircuit: true, url: STUB };
  if (spec.startsWith('.') && ctx.parentURL?.startsWith('file:') && !/\.[a-z]+$/i.test(spec)) {
    const base = new URL(spec, ctx.parentURL);
    for (const ext of ['.ts', '/index.ts']) {
      const u = new URL(base.href.replace(/\/$/, '') + ext);
      if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
    }
  }
  return next(spec, ctx);
}
