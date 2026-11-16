// SCR-058 안내 화면의 열 주소를 바깥 경계(resolveTarget)에서 보는 시험(BAT-170 검증 뒤 시험 V170-39, 열린 이동 막기 ASVS 3.7.2).
// 정본: docs/design/d5-screen-blueprint.md §5.32 '열 주소'(두 꼴은 그대로, 두 꼴 밖이거나 다른 출처면 첫 화면, 받은 주소는 화면 글·복사 값·
// Android 바로 열기 주소 어디에도 싣지 않는다). 시험 담당(l2w7-BAT170-test)이 썼다.
// target.ts는 '@/' 별칭과 .tsx를 거쳐 고정 자료를 읽으므로, 이 파일의 프로세스에만 별칭을 푸는 불러오기 고리를 건다(별칭 → src/, .tsx는 esbuild로 바꿈).
// target.test.mjs의 소스 시험(openTargetPath를 부르는가)은 글자만 보아, 두 꼴 밖에서 받은 next를 열 주소에 싣는 틀린 구현을 놓쳤다.
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const SRC = new URL('../../../', import.meta.url).href;
const ESBUILD = pathToFileURL(createRequire(import.meta.url).resolve('esbuild')).href;
const hooks = `
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const SRC = ${JSON.stringify(SRC)};
let esbuild;
const file = (u) => {
  for (const s of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    try { if (statSync(fileURLToPath(u + s)).isFile()) return u + s; } catch {}
  }
  return null;
};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('@/')) { const f = file(SRC + spec.slice(2)); if (f) return { url: f, shortCircuit: true }; }
  if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith(SRC)) { const f = file(new URL(spec, ctx.parentURL).href); if (f) return { url: f, shortCircuit: true }; }
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (url.startsWith(SRC) && url.endsWith('.tsx')) {
    esbuild ??= (await import(${JSON.stringify(ESBUILD)})).default;
    const r = await esbuild.transform(readFileSync(fileURLToPath(url), 'utf8'), { loader: 'tsx', format: 'esm', jsx: 'automatic' });
    return { format: 'module', source: r.code, shortCircuit: true };
  }
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
  return next(url, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
const { resolveTarget } = await import(new URL('./target.ts', import.meta.url).href);

/** 화면에 실리는 칸(열 주소·닫기 주소·머리 글) */
const fields = (t) => [t.href, t.closeHref, t.title, t.subtitle, t.closeLabel];

test('[ASVS v5.0.0-3.7.2] SCR-058 V170-39 두 꼴 밖이거나 다른 출처 next면 열 주소·닫기 주소는 첫 화면이고 받은 주소를 싣지 않는다', () => {
  for (const next of [
    'https://evil.example/queue/x',
    '//evil.example/queue/x',
    '/\\evil.example/queue/x',
    'javascript:alert(1)',
    '/my/settings',
    '/queue/evt-1?next=https://evil.example',
    '/queue/evt-1#evil.example',
    '/events/evt-1',
    '',
    undefined,
  ]) {
    const t = resolveTarget(next);
    assert.equal(t.href, '/', `${String(next)}: 열 주소`);
    assert.equal(t.closeHref, '/', `${String(next)}: 닫기 주소`);
    for (const v of fields(t)) assert.equal(String(v).includes('evil.example') || String(v).includes('javascript:'), false, `${String(next)}: 받은 주소가 실렸다 ${v}`);
  }
});

test('SCR-058 V170-39 두 꼴의 같은 출처 경로는 고정 자료에 없어도 그 주소를 열고, 닫기 주소도 같은 출처 경로다', () => {
  const queue = resolveTarget('/queue/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e06');
  assert.equal(queue.kind, 'queue');
  assert.equal(new URL(queue.href, 'https://www.peaket.example').pathname, '/queue/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e06');
  assert.equal(queue.closeHref, '/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e06');
  assert.equal(fields(queue).some((v) => String(v).includes('evt-lumen-1025')), false, '데모 공연으로 바뀌었다');
  const ticket = resolveTarget('/my/tickets/tkt-bat170-not-in-fixture');
  assert.equal(ticket.kind, 'ticket');
  assert.equal(ticket.href, '/my/tickets/tkt-bat170-not-in-fixture');
  assert.equal(ticket.closeHref, '/my/tickets/tkt-bat170-not-in-fixture');
  for (const t of [queue, ticket]) assert.match(t.closeHref, /^\/(?!\/)/, '닫기 주소가 같은 출처 경로가 아니다');
});
