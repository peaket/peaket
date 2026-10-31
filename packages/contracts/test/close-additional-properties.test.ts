// additionalProperties: false를 같은 뜻의 { not: {} }로 바꾸는 변환(design.md 결정 9).
// orval 8.45는 false를 무시해 정의 밖 칸을 조용히 버리는 Zod를 만들고, { not: {} }는 거절하는 Zod(catchall never)로 만든다.
// 권한 표는 요청 스키마의 정의 밖 칸을 400으로 거절하라고 한다(docs/security/authz-matrix.md, ASVS 8.2.3·15.3.3).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { closeAdditionalProperties } from '../scripts/close-additional-properties.mjs';

describe('additionalProperties: false 바꾸기', () => {
  test('ASVS8_2_3_어느깊이의false든_not빈스키마로바꾼다', () => {
    const doc = {
      components: { schemas: { A: { type: 'object', additionalProperties: false, properties: { n: { type: 'object', additionalProperties: false } } } } },
      paths: { '/v1/a': { post: { requestBody: { content: { 'application/json': { schema: { type: 'array', items: { type: 'object', additionalProperties: false } } } } } } } },
    };
    expect(closeAdditionalProperties(doc)).toEqual({
      components: { schemas: { A: { type: 'object', additionalProperties: { not: {} }, properties: { n: { type: 'object', additionalProperties: { not: {} } } } } } },
      paths: { '/v1/a': { post: { requestBody: { content: { 'application/json': { schema: { type: 'array', items: { type: 'object', additionalProperties: { not: {} } } } } } } } } },
    });
  });

  test('ASVS8_2_3_true와스키마값과_그런이름의칸은_그대로둔다', () => {
    const doc = {
      a: { additionalProperties: true },
      b: { additionalProperties: { type: 'string' } },
      c: { type: 'object', properties: { additionalProperties: { type: 'boolean' } } },
      d: { type: 'object' },
    };
    expect(closeAdditionalProperties(doc)).toEqual(doc);
  });

  test('ASVS8_2_3_원본을바꾸지않는다', () => {
    const doc = { a: { additionalProperties: false } };
    closeAdditionalProperties(doc);
    expect(doc).toEqual({ a: { additionalProperties: false } });
  });

  test('ASVS8_2_3_실제계약의false가_하나도남지않는다', () => {
    const text = readFileSync(new URL('../../../docs/api/openapi.yaml', import.meta.url), 'utf8');
    const before = (text.match(/additionalProperties: false/g) ?? []).length;
    const out = JSON.stringify(closeAdditionalProperties(parse(text)));
    expect(before).toBeGreaterThan(0);
    expect(out).not.toContain('"additionalProperties":false');
    expect((out.match(/"additionalProperties":\{"not":\{\}\}/g) ?? []).length).toBe(before);
  });
});
