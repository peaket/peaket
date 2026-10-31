// 서비스 안 구조의 층 의존 방향 린트 시험(docs/architecture.md §3.1, 기술 검토 낮음-008,
// openspec 변경 add-service-structure-and-request-checks 결정 1). 실행: pnpm --filter @peaket/config test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { serviceLayerConfigs } from './service-layers.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: true, overrideConfig: serviceLayerConfigs(['services/*/src/modules']) });
const M = 'services/demo-svc/src/modules/note';

/** 그 파일 자리에서 import 한 줄을 린트해 오류 수를 돌려준다 */
async function errorsOf(file, specifier) {
  const [r] = await eslint.lintText(`import { x } from '${specifier}';\nexport const y = x;\n`, { filePath: `${ROOT}${M}/${file}` });
  return r.messages.filter((m) => m.severity === 2).map((m) => m.ruleId);
}

const cases = [
  // [파일 자리, 가져오는 것, 막히는가]
  ['domain/note.ts', './note-repository', false],
  ['domain/note.ts', '../application/get-note', true],
  ['domain/note.ts', '../inbound/note.controller', true],
  ['domain/note.ts', '../adapters/db/schema', true],
  ['domain/note.ts', '@nestjs/common', true],
  ['domain/note.ts', 'drizzle-orm', true],
  ['domain/note.ts', 'drizzle-orm/pg-core', true],
  ['domain/note.ts', 'fastify', true],
  ['domain/note.ts', 'pg', true],
  ['domain/note.ts', '@peaket/platform', true],
  ['domain/note.ts', '@peaket/contracts/openapi/seats', true],
  ['application/get-note.ts', '../domain/note', false],
  ['application/get-note.ts', '@nestjs/common', false],
  ['application/get-note.ts', '@peaket/platform', false],
  ['application/get-note.ts', '../adapters/memory-note-repository', true],
  ['application/get-note.ts', '../inbound/note.controller', true],
  ['application/get-note.ts', 'drizzle-orm', true],
  ['application/get-note.ts', 'fastify', true],
  ['application/get-note.ts', '@peaket/contracts/openapi/seats', true],
  ['inbound/note.controller.ts', '../application/get-note', false],
  ['inbound/note.controller.ts', '../domain/note', false],
  ['inbound/note.controller.ts', '@peaket/contracts/openapi/seats', false],
  ['inbound/note.controller.ts', '../adapters/db/schema', true],
  ['adapters/db/drizzle-note-repository.ts', '../../domain/note-repository', false],
  ['adapters/db/drizzle-note-repository.ts', 'drizzle-orm', false],
  ['adapters/db/drizzle-note-repository.ts', '../../inbound/note.controller', true],
  ['adapters/db/drizzle-note-repository.ts', '../../application/get-note', true],
  ['note.module.ts', './adapters/db/drizzle-note-repository', false],
  ['application/get-note.ts', '../../order/domain/order', true],
  ['application/get-note.ts', '../../order', false],
  // 코드 리뷰 2026-11-01: 돌아가는 경로의 다른 컨텍스트와 모듈 조립 파일을 놓쳤다
  ['domain/note.ts', '../../../modules/order/domain/order', true],
  ['domain/note.ts', '../note.module', true],
  ['application/get-note.ts', '../note.module.js', true],
  ['adapters/db/drizzle-note-repository.ts', '../../note.module', true],
];

for (const [file, specifier, blocked] of cases) {
  test(`낮음008_${file}에서_${specifier}를가져오면_${blocked ? '막힌다' : '통과한다'}`, async () => {
    const errors = await errorsOf(file, specifier);
    assert.deepEqual(errors.length > 0, blocked, `${file} → ${specifier}: ${errors.join(',')}`);
    if (blocked) assert.ok(errors.every((id) => id === 'no-restricted-imports'));
  });
}

test('낮음008_형만가져오는import와_다시내보내기도_막는다', async () => {
  const [a] = await eslint.lintText("import type { Pool } from 'pg';\nexport type P = Pool;\n", { filePath: `${ROOT}${M}/domain/x.ts` });
  const [b] = await eslint.lintText("export * from '../adapters/db/schema';\n", { filePath: `${ROOT}${M}/domain/x.ts` });
  assert.equal(a.errorCount, 1);
  assert.equal(b.errorCount, 1);
});

test('낮음008_서비스템플릿의뼈대는_층규칙오류가없다', async () => {
  const lint = new ESLint({ cwd: ROOT, overrideConfigFile: true, overrideConfig: serviceLayerConfigs(['packages/platform/template/src/modules']) });
  const results = await lint.lintFiles(['packages/platform/template/src']);
  assert.ok(results.length >= 8, `린트한 파일 수: ${results.length}`);
  const errors = results.flatMap((r) => r.messages.map((m) => `${r.filePath}:${m.line} ${m.message}`));
  assert.deepEqual(errors, []);
});
