// 서비스 OpenAPI 문서 뽑기(D-T38, docs/devops.md §3.1, openspec 변경 add-service-template 결정 6).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { contractSchema, emitOpenApi } from '../src/index.js';
import { DemoModule } from './fixture.js';

test('DT38_문서뽑기는_경로틀과_계약Zod응답스키마를_파일로쓴다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-openapi-'));
  try {
    const out = join(dir, 'openapi.json');
    await emitOpenApi({ module: DemoModule, out, title: 'demo-svc' });
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    expect(doc.openapi).toMatch(/^3\./);
    const op = doc.paths['/v1/demo/items/{itemId}']?.get;
    expect(op, '경로 틀이 계약 표기다').toBeDefined();
    expect(op.parameters).toEqual([expect.objectContaining({ name: 'itemId', in: 'path', required: true })]);
    const schema = op.responses['200'].content['application/json'].schema;
    expect(schema.properties).toMatchObject({ id: { type: 'string' }, count: { type: 'integer' } });
    expect(schema.required).toEqual(['id', 'count', 'note']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DT38_기본은입력기준이라_기본값있는칸이계약처럼선택칸으로남는다', () => {
  // 계약에서 만든 Zod의 입력 기준이 계약의 모양이다(응답의 기본값 칸도 계약에서는 선택 칸이다)
  const body = z.object({ seat: z.string(), allowSplit: z.boolean().default(false) });
  expect(contractSchema(body).required).toEqual(['seat']);
  expect(contractSchema(body, { io: 'output' }).required).toEqual(['seat', 'allowSplit']); // 출력 기준은 기본값이 채워진 뒤의 모양
});

test('DT38_계약Zod를_OpenAPI스키마로바꾼다', () => {
  const s = contractSchema(z.object({ a: z.string(), b: z.number().nullable().optional() }));
  expect(s).not.toHaveProperty('$schema');
  expect(s).toMatchObject({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] });
});
