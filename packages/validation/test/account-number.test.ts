// F-06-5 계좌번호 꼴 찾기·가림 공용 부품 시험(시험 담당 lane2-freeze-F-06-5-opencode).
// 정본: docs/security/data-classification.md '고객 문의', docs/security/asvs/support.md 법률 행(개인정보의 안전성 확보조치 기준 §7②6호), d5 §5.30.
// 구현 전에는 @peaket/validation/account-number가 없어 각 시험이 그 자리에서 실패한다.
import { describe, expect, test } from 'vitest';

async function mod(): Promise<{ findAccountNumbers(t: string): { index: number; text: string }[]; maskAccountNumbers(t: string): string }> {
  const spec = '../src/account-number/index.js';
  try {
    return (await import(/* @vite-ignore */ spec)) as never;
  } catch (err) {
    if (err instanceof Error && /Cannot find module|Failed to load url|ERR_MODULE_NOT_FOUND|Does the file exist/i.test(err.message)) throw new Error('packages/validation/src/account-number/index.ts가 없다(계획 §3)');
    throw err;
  }
}

describe('계좌번호 꼴 찾기', () => {
  test('하이픈·공백을 뺀 10~14자리 숫자열을 찾고 위치를 준다', async () => {
    const m = await mod();
    for (const text of ['110-123-456789', '110 123 456789', '1101234567890', '12345678901234']) {
      const found = m.findAccountNumbers(`환불은 ${text} 계좌로 받고 싶습니다.`);
      expect(found, text).toHaveLength(1);
      expect(found[0]!.text).toBe(text);
      expect(`환불은 ${text} 계좌로 받고 싶습니다.`.slice(found[0]!.index, found[0]!.index + text.length)).toBe(text);
    }
  });

  test('9자리·15자리, 휴대폰 번호, 20으로 시작하는 13자리 예매번호, ord- 주문번호는 찾지 않는다', async () => {
    const m = await mod();
    for (const text of ['123456789', '123456789012345', '010-9876-5432', '01098765432', '2026101400123', 'ord-20261018-0010', 'ord-1101234567890']) {
      expect(m.findAccountNumbers(text), text).toHaveLength(0);
    }
  });

  test('한 글에 여럿이면 모두 찾고 겹치지 않게 센다', async () => {
    const m = await mod();
    const found = m.findAccountNumbers('첫 계좌 110-123-456789, 둘째 220-333-444555, 셋째 1234567890');
    expect(found.map((x) => x.text)).toEqual(['110-123-456789', '220-333-444555', '1234567890']);
  });
});

describe('계좌번호 가림', () => {
  test('찾은 숫자열만 (계좌번호 지움)으로 바꾸고 나머지 글은 그대로 둔다', async () => {
    const m = await mod();
    const text = '환불은 110-123-456789 계좌로 받고 싶습니다. 연락처는 010-9876-5432입니다.';
    expect(m.maskAccountNumbers(text)).toBe('환불은 (계좌번호 지움) 계좌로 받고 싶습니다. 연락처는 010-9876-5432입니다.');
  });

  test('여러 개를 모두 바꾸고 찾는 것이 없으면 원문 그대로다', async () => {
    const m = await mod();
    expect(m.maskAccountNumbers('110-123-456789 와 220 333 444555')).toBe('(계좌번호 지움) 와 (계좌번호 지움)');
    expect(m.maskAccountNumbers('계좌번호가 없는 문의 본문입니다.')).toBe('계좌번호가 없는 문의 본문입니다.');
  });

  test('빈 글과 아주 긴 글에서도 터지지 않는다', async () => {
    const m = await mod();
    expect(m.maskAccountNumbers('')).toBe('');
    const long = `${'가'.repeat(3000)} 110-123-456789 ${'나'.repeat(3000)}`;
    expect(m.maskAccountNumbers(long)).toContain('(계좌번호 지움)');
    expect(m.maskAccountNumbers(long)).not.toContain('110-123-456789');
  });
});
