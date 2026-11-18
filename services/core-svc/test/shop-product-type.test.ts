// 상품 유형 스키마 판 묶음(@peaket/validation/product-types) 단위 시험(V-T46 ①, ADR-0300 결정 1).
// 단언 값은 정본에서: 공통 칸 perAccountLimit 1~99 정수 또는 null, options 0~10개(옵션마다 이름 1~30자, 고를 값 1~50개, 값 1~50자, 이름·값 겹침 없음),
// PARKING 판 1은 vehicleNotice(선택, 1~200자), MERCH 판 1은 공통 칸만, 모르는 칸은 거절. 코드 상수(PRODUCT_OPTIONS_MAX 등)는 가져오지 않는다.
import { checkProductAttributes, latestProductSchemaVersion, optionsMatch, productAttributeSchema } from '@peaket/validation/product-types';
import { describe, expect, test } from 'vitest';

const ok = (type: string, attributes: unknown, version = 1) => checkProductAttributes(type, version, attributes).ok;
const chars = (n: number) => '가'.repeat(n);
const options = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `옵션${i + 1}`, values: ['값'] }));

describe('상품 유형 스키마(V-T46)', () => {
  test('V-T46 ① MERCH·PARKING 판 1은 맞는 속성을 받고 빈 속성도 받는다', () => {
    expect(ok('MERCH', {})).toBe(true);
    expect(ok('PARKING', {})).toBe(true);
    expect(ok('MERCH', { perAccountLimit: 2, options: [{ name: '사이즈', values: ['S', 'M', 'L'] }] })).toBe(true);
    expect(ok('PARKING', { perAccountLimit: 1, vehicleNotice: '경차 전용', options: [] })).toBe(true);
  });

  test('V-T46 ① 모르는 칸은 거절하고 MERCH에는 vehicleNotice가 없다', () => {
    expect(ok('MERCH', { color: '인디고' })).toBe(false);
    expect(ok('PARKING', { color: '인디고' })).toBe(false);
    expect(ok('MERCH', { vehicleNotice: '안내' })).toBe(false);
    expect(ok('MERCH', { options: [{ name: '색상', values: ['빨강'], extra: true }] })).toBe(false);
  });

  test('V-T46 ① 옵션 수는 0개와 10개를 받고 11개를 거절한다', () => {
    expect(ok('MERCH', { options: options(0) })).toBe(true);
    expect(ok('MERCH', { options: options(10) })).toBe(true);
    expect(ok('MERCH', { options: options(11) })).toBe(false);
  });

  test('V-T46 ① 옵션 이름은 1자·30자를 받고 0자·31자를 거절한다', () => {
    for (const [n, want] of [
      [1, true],
      [30, true],
      [0, false],
      [31, false],
    ] as const)
      expect(ok('MERCH', { options: [{ name: chars(n), values: ['값'] }] }), `이름 ${n}자`).toBe(want);
  });

  test('V-T46 ① 고를 값은 1개·50개를 받고 0개·51개를 거절한다', () => {
    const values = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);
    for (const [n, want] of [
      [1, true],
      [50, true],
      [0, false],
      [51, false],
    ] as const)
      expect(ok('MERCH', { options: [{ name: '색상', values: values(n) }] }), `값 ${n}개`).toBe(want);
  });

  test('V-T46 ① 값 글자는 1자·50자를 받고 0자·51자를 거절한다', () => {
    for (const [n, want] of [
      [1, true],
      [50, true],
      [0, false],
      [51, false],
    ] as const)
      expect(ok('MERCH', { options: [{ name: '색상', values: [chars(n)] }] }), `값 ${n}자`).toBe(want);
  });

  test('V-T46 ① 옵션 이름이 겹치거나 한 옵션의 값이 겹치면 거절한다', () => {
    expect(ok('MERCH', { options: [{ name: '색상', values: ['빨강'] }, { name: '색상', values: ['파랑'] }] })).toBe(false);
    expect(ok('MERCH', { options: [{ name: '색상', values: ['빨강', '빨강'] }] })).toBe(false);
    // 다른 옵션에 같은 값은 겹침이 아니다
    expect(ok('MERCH', { options: [{ name: '앞', values: ['A'] }, { name: '뒤', values: ['A'] }] })).toBe(true);
  });

  test('V-T46 ① perAccountLimit은 1·99와 null을 받고 0·100·정수 아님·글자를 거절한다', () => {
    for (const v of [1, 99, null]) expect(ok('MERCH', { perAccountLimit: v }), String(v)).toBe(true);
    for (const v of [0, 100, -1, 1.5, '2']) expect(ok('MERCH', { perAccountLimit: v }), String(v)).toBe(false);
    for (const v of [0, 100]) expect(ok('PARKING', { perAccountLimit: v }), `PARKING ${v}`).toBe(false);
  });

  test('V-T46 ① PARKING vehicleNotice는 1자·200자를 받고 0자·201자를 거절한다', () => {
    for (const [n, want] of [
      [1, true],
      [200, true],
      [0, false],
      [201, false],
    ] as const)
      expect(ok('PARKING', { vehicleNotice: chars(n) }), `${n}자`).toBe(want);
  });

  test('V-T46 ① 모르는 유형·모르는 판(판 10 같은 두 자리 포함)은 스키마가 없고 검사는 실패로 답한다(던지지 않는다)', () => {
    expect(productAttributeSchema('VIP', 1)).toBeUndefined();
    expect(productAttributeSchema('MERCH', 10)).toBeUndefined();
    expect(productAttributeSchema('MERCH', 0)).toBeUndefined();
    expect(productAttributeSchema('MERCH', 1.5)).toBeUndefined();
    expect(productAttributeSchema('toString', 1)).toBeUndefined();
    expect(productAttributeSchema('MERCH', 1)).toBeDefined();
    expect(checkProductAttributes('VIP', 1, {})).toMatchObject({ ok: false, reason: 'unknown-schema' });
    expect(checkProductAttributes('MERCH', 10, {})).toMatchObject({ ok: false, reason: 'unknown-schema' });
    expect(latestProductSchemaVersion('MERCH')).toBe(1);
    expect(latestProductSchemaVersion('PARKING')).toBe(1);
    expect(latestProductSchemaVersion('VIP')).toBeUndefined();
  });

  test('V-T46 ① 틀린 속성의 실패 답은 틀린 칸의 경로만 싣고 속성 값은 싣지 않는다', () => {
    const r = checkProductAttributes('MERCH', 1, { perAccountLimit: 100, secretValue: '비밀값-123' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('비밀값-123');
  });

  test('V-T46 ① 주문 옵션은 상품의 모든 옵션을 고를 값 안에서 골라야 맞는다(ADR-0300 결정 4)', () => {
    const opts = [
      { name: '색상', values: ['빨강', '파랑'] },
      { name: '사이즈', values: ['S'] },
    ];
    expect(optionsMatch(opts, { 색상: '빨강', 사이즈: 'S' })).toBe(true);
    expect(optionsMatch(opts, { 색상: '초록', 사이즈: 'S' })).toBe(false);
    expect(optionsMatch(opts, { 색상: '빨강' })).toBe(false);
    expect(optionsMatch(opts, { 색상: '빨강', 사이즈: 'S', 각인: '가' })).toBe(false);
    expect(optionsMatch([], undefined)).toBe(true);
    expect(optionsMatch([], {})).toBe(true);
    expect(optionsMatch([], { 색상: '빨강' })).toBe(false);
  });
});
