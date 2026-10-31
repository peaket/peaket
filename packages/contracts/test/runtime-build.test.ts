// 서버가 이 패키지를 실행 중에 읽는 빌드 방식(openspec 변경 add-service-structure-and-request-checks 결정 4·10, BUILD_ORDER FND-070).
// - 생성 스키마의 검사 규칙(.refine)은 z.toJSONSchema()가 빼므로 같은 JSON Schema 낱말을 메타데이터로 단다(경로 스키마·D-T38이 본다)
// - 모음 파일의 다시 내보내기에 .js를 붙여 Node가 읽게 하고, tsc로 만든 dist/를 Node가 읽는다
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { ApprovalDecisionBody, MerchOrderItems } from '@peaket/contracts/openapi/model';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GEN = join(ROOT, 'src', 'gen');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('검사 규칙의 JSON Schema 메타데이터', () => {
  test('FND070_검사규칙은_toJSONSchema결과에도_남는다', () => {
    const items = z.toJSONSchema(MerchOrderItems, { io: 'input', target: 'draft-07' }) as Record<string, any>;
    expect(items.uniqueItems).toBe(true);
    const options = items.items.properties.options;
    expect(options.maxProperties).toBe(10);
    expect(options.propertyNames).toEqual({ maxLength: 30 });
    const body = z.toJSONSchema(ApprovalDecisionBody, { io: 'input', target: 'draft-07' }) as Record<string, any>;
    expect(body.properties.excludeAccountIds.uniqueItems).toBe(true);
  });

  test('FND070_생성물의_검사규칙마다_메타데이터가_붙어있다', () => {
    let refines = 0;
    let annotated = 0;
    for (const f of files(GEN)) {
      const text = readFileSync(f, 'utf8');
      refines += text.split('.refine(').length - 1;
      annotated += (text.match(/\)\.meta\(\{ ?"?(uniqueItems|maxProperties|propertyNames)"?:/g) ?? []).length;
    }
    expect(refines).toBeGreaterThan(0);
    expect(annotated).toBe(refines);
  });
});

describe('Node로 읽기', () => {
  test('FND070_모음파일의_상대다시내보내기는_js확장자다', () => {
    for (const index of [join(GEN, 'openapi', 'model', 'index.ts'), join(GEN, 'asyncapi', 'model', 'index.ts')]) {
      const lines = readFileSync(index, 'utf8').split('\n').filter((l) => l.startsWith('export * from'));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l).toMatch(/^export \* from '\.\/[^']+\.js';$/);
    }
  });

  test('FND070_빌드한패키지를_번들러없이Node만으로읽는다', () => {
    // typescript 7의 exports에는 bin이 없어 package.json 자리에서 찾는다
    const tsc = join(createRequire(import.meta.url).resolve('typescript/package.json'), '..', 'bin', 'tsc');
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'pipe' });
    const script = [
      "const m = await import('@peaket/contracts/openapi/model');",
      "const q = await import('@peaket/contracts/openapi/queue');",
      "const e = await import('@peaket/contracts/asyncapi');",
      "const item = { productId: '0190f3a1-7c2e-7a00-8000-000000000001', quantity: 1 };",
      'console.log(JSON.stringify({',
      '  dup: m.MerchOrderItems.safeParse([item, { ...item }]).success,',
      '  one: m.MerchOrderItems.safeParse([item]).success,',
      "  entry: q.PostV1QueuesEventIdEntriesBody.safeParse({ preverifyToken: 't' }).success,",
      "  event: typeof e.SessionTerminated.safeParse,",
      "  from: import.meta.resolve('@peaket/contracts/openapi/queue').includes('/dist/'),",
      '}));',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual({ dup: false, one: true, entry: true, event: 'function', from: true });
  }, 120_000);
});
