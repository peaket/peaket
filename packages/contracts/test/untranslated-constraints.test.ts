// orval 8.45가 Zod로 옮기지 않는 JSON Schema 제약(design.md 결정 10). 옮길 수 있는 셋(uniqueItems·maxProperties·
// propertyNames.maxLength)은 생성 스키마에 검사 규칙(refine)으로 넣고, 못 옮기는 것은 위치를 이 목록에 적어 둔다.
// 계약에 새 위치가 생기면 이 시험이 실패한다. 그 제약은 생성 스키마가 걸러 주지 않으므로 그 값을 받는 쪽이 따로 본다.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { ApprovalDecisionBody, MerchOrderItemInput, MerchOrderItems } from '@peaket/contracts/openapi/model';
import { untranslatedKeywords } from '../scripts/schema-extensions.mjs';

const read = (name: string) => parse(readFileSync(new URL(`../../../docs/api/${name}.yaml`, import.meta.url), 'utf8'));
const item = { productId: '0190f3a1-7c2e-7a00-8000-000000000001', quantity: 1 };

describe('옮겨 넣은 제약', () => {
  test('중간085_중복금지uniqueItems_같은항목이두번이면_거른다', () => {
    expect(MerchOrderItems.safeParse([item]).success).toBe(true);
    expect(MerchOrderItems.safeParse([item, { ...item }]).success).toBe(false);
    expect(ApprovalDecisionBody.safeParse({ excludeAccountIds: ['a', 'b'] }).success).toBe(true);
    expect(ApprovalDecisionBody.safeParse({ excludeAccountIds: ['a', 'a'] }).success).toBe(false);
    // JSON Schema는 키 순서만 다른 객체를 같은 값으로 본다
    expect(MerchOrderItems.safeParse([{ ...item, options: { a: '1', b: '2' } }, { ...item, options: { b: '2', a: '1' } }]).success).toBe(false);
  });

  test('중간085_칸수상한maxProperties와_칸이름길이propertyNames를_거른다', () => {
    const opts = (n: number, keyLen = 2) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i).padStart(keyLen, 'k'), 'v']));
    expect(MerchOrderItemInput.safeParse({ ...item, options: opts(10) }).success).toBe(true);
    expect(MerchOrderItemInput.safeParse({ ...item, options: opts(11) }).success).toBe(false);
    expect(MerchOrderItemInput.safeParse({ ...item, options: opts(1, 30) }).success).toBe(true);
    expect(MerchOrderItemInput.safeParse({ ...item, options: opts(1, 31) }).success).toBe(false);
  });
});

describe('못 옮기는 제약의 위치', () => {
  test('중간085_계약에서생성기가못옮기는제약은_적어둔위치뿐이다', () => {
    // 파트너 웹훅 본문(우리가 보내는 값)의 조건부 필수. 웹훅을 만드는 notify 쪽이 보낼 때 맞춘다
    const known = [
      'openapi:components.schemas.PartnerWebhookEvent.properties.data.oneOf[5].if',
      'openapi:components.schemas.PartnerWebhookEvent.properties.data.oneOf[5].then',
      'openapi:components.schemas.PartnerWebhookEvent.properties.data.oneOf[5].else',
    ];
    expect([...untranslatedKeywords(read('openapi'), 'openapi'), ...untranslatedKeywords(read('asyncapi'), 'asyncapi')]).toEqual(known);
  });

  test('중간085_type이없거나맞지않거나format이있으면_확장이붙지않으므로_못옮긴것으로센다', () => {
    const doc = { s: {
      A: { maxProperties: 2, additionalProperties: { type: 'string' } },
      B: { allOf: [{ type: 'array', items: { type: 'string' } }, { uniqueItems: true }] },
      C: { type: 'string', format: 'x', propertyNames: { maxLength: 3 } },
      D: { type: 'array', uniqueItems: true },
      E: { type: 'object', maxProperties: 1, propertyNames: { maxLength: 3 } },
    } };
    expect(untranslatedKeywords(doc, 'x')).toEqual(['x:s.A.maxProperties', 'x:s.B.allOf[1].uniqueItems', 'x:s.C.propertyNames']);
  });

  test('중간085_옮긴제약도_못옮기는제약도_예시값안은보지않는다', () => {
    const doc = { components: { schemas: { A: { type: 'array', uniqueItems: true, example: [{ if: 1 }] }, B: { type: 'object', properties: { if: { type: 'string' } } }, C: { if: { required: ['x'] }, then: {} } } } };
    expect(untranslatedKeywords(doc, 'x')).toEqual(['x:components.schemas.C.if', 'x:components.schemas.C.then']);
  });
});
