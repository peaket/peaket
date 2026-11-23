// 2차 마스킹 정규식 원천(V-T49 ③, docs/observability.md §7 '2차 마스킹 정규식 원천'·'오류 수집 가림 꼴', docs/verification.md V-T49,
// docs/security/asvs/delivery.md 16.2.5, 계획 docs/review/plans/F-01-3.md §5·§6).
// 정본: 글 속 개인정보 꼴의 정규식은 packages/platform/src/pii-patterns.json 한 곳에만 둔다. 게이트웨이 수집기(RE2)와 오류 수집 가림(pii-text.ts,
// 자바스크립트)이 모두 이 파일을 읽으므로, 꼴은 두 엔진이 똑같이 읽는 문법(앞뒤 살피기·뒤 참조 없음)으로만 쓴다. 표시는 1차와 같은 하나.
// 시험 값은 코드 상수(error-reporting-app.ts의 값 포함)와 다르게 골랐다. 실제 수집기(RE2)가 이 원천을 받아 같은 결과를 내는지는
// test-int/collector-masking.int.test.ts가 본다.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { PII_TEXT_PATTERNS } from '../src/index.js';
import { maskPiiText } from '../src/pii-text.js';

const SOURCE = new URL('../src/pii-patterns.json', import.meta.url);
const OBSERVABILITY = new URL('../../../docs/observability.md', import.meta.url);

interface PatternSource {
  mask: string;
  patterns: { name: string; pattern: string; replacement: string }[];
}
const readSource = (): PatternSource => JSON.parse(readFileSync(SOURCE, 'utf8')) as PatternSource;

/** observability.md §7 '2차 마스킹 정규식 원천' 행이 정한 표시(문서에서 읽는다) */
function maskFromDoc(): string {
  const row = readFileSync(OBSERVABILITY, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('| 2차 마스킹 정규식 원천('));
  const m = row ? /표시는 1차와 같은 `([^`]+)`/.exec(row) : null;
  if (!m) throw new Error('observability.md §7 "2차 마스킹 정규식 원천" 행에서 표시를 찾지 못했다');
  return m[1];
}

/** 계획 §5가 정한 꼴 이름 다섯(observability.md §7: 이메일·카드 번호·국제 표기 전화·국내 휴대폰·예금주 조회 경로의 계좌번호) */
const NAMES = ['email', 'card', 'phone-e164', 'phone-kr', 'bank-account-path'];

describe('V-T49 ③ 정규식 원천', () => {
  test('V-T49 ③-1 [ASVS v5.0.0-16.2.5] 원천의 표시는 정본 표시이고 꼴은 정해 둔 다섯이다', () => {
    const src = readSource();
    const mask = maskFromDoc();
    expect(mask).toBe('[REDACTED]');
    expect(src.mask).toBe(mask);
    expect([...src.patterns.map((p) => p.name)].sort()).toEqual([...NAMES].sort());
    for (const p of src.patterns) {
      expect(typeof p.pattern, p.name).toBe('string');
      expect(p.pattern.length, p.name).toBeGreaterThan(0);
      // 바꿀 글은 표시를 담는다(꼴에 걸린 자리는 표시로 바뀐다)
      expect(p.replacement, p.name).toContain(mask);
    }
  });

  test('V-T49 ③-2 [ASVS v5.0.0-16.2.5] 원천 꼴은 RE2와 자바스크립트가 함께 받는 문법이다(앞뒤 살피기·뒤 참조·원자 묶음 없음)', () => {
    const src = readSource();
    for (const p of src.patterns) {
      // RE2가 받지 않는 문법: 앞뒤 살피기 (?= (?! (?<= (?<!, 이름 붙은 묶음 (?<이름>(옛 RE2), 원자 묶음 (?>, 뒤 참조 \1·\k<이름>, 독점 수량자
      expect(p.pattern, p.name).not.toMatch(/\(\?[=!<>]/);
      expect(p.pattern, p.name).not.toMatch(/\\[1-9]|\\k</);
      expect(p.pattern, p.name).not.toMatch(/[*+?}]\+/);
      // 자바스크립트로도 전역 꼴로 만들어진다
      expect(() => new RegExp(p.pattern, 'g'), p.name).not.toThrow();
      // 잡은 묶음은 $1처럼 쓰고 바로 뒤에 글자·숫자·밑줄을 붙이지 않는다(RE2/OTTL은 $1x를 이름 '1x'로 읽는다). ${1}은 자바스크립트가 모른다
      expect(p.replacement, p.name).not.toMatch(/\$\d+[A-Za-z0-9_]/);
      expect(p.replacement, p.name).not.toMatch(/\$\{/);
    }
  });

  test('V-T49 ③-3 내보낸 PII_TEXT_PATTERNS는 원천 파일 그대로다(maskPiiText가 쓰는 꼴의 원천이 한 곳이다)', () => {
    const src = readSource();
    expect(PII_TEXT_PATTERNS).toEqual(src.patterns);
  });
});

describe('V-T49 ③ maskPiiText(원천을 읽은 가림)', () => {
  test.each([
    ['이메일 둘이 쉼표로 붙음', '연락 fan.one@example.co.kr,fan.two@mail.example.org 끝', '연락 [REDACTED],[REDACTED] 끝'],
    ['따옴표 안 이메일 둘이 붙음', 'to="kim_s@corp.example.com""lee+vip@example.net"', 'to="[REDACTED]""[REDACTED]"'],
    ['국내 휴대폰 둘이 빗금으로 붙음(붙여 씀)', '번호 01011112222/01033334444 끝', '번호 [REDACTED]/[REDACTED] 끝'],
    ['국내 휴대폰 둘이 쉼표로 붙음(하이픈)', '010-5555-6666,019-777-8888', '[REDACTED],[REDACTED]'],
    ['카드 둘이 쉼표로 붙음(붙여 씀)', 'cards=4012888888881881,5105105105105100;', 'cards=[REDACTED],[REDACTED];'],
    ['카드 둘이 빈칸 하나로 붙음(하이픈)', '4000-0566-5566-5556 3530-1113-3330-0000', '[REDACTED] [REDACTED]'],
    ['카드 빈칸 구분', '카드 6011 0009 9013 9424 승인', '카드 [REDACTED] 승인'],
    ['국제 표기 전화 둘이 쉼표로 붙음', '+821098765432,+14155550199', '[REDACTED],[REDACTED]'],
    ['예금주 조회 경로의 계좌번호 마디만', '/platform/bank-accounts/KOOKMIN/12345678901234/holder', '/platform/bank-accounts/KOOKMIN/[REDACTED]/holder'],
    ['글 속 예금주 조회 경로', 'POST https://api.portone.io/platform/bank-accounts/SHINHAN/110987654321/holder 502', 'POST https://api.portone.io/platform/bank-accounts/SHINHAN/[REDACTED]/holder 502'],
  ])('V-T49 ③-4 [ASVS v5.0.0-16.2.5] %s → 모두 가린다', (_what, input, want) => {
    expect(maskPiiText(input)).toBe(want);
  });

  test.each([
    ['주문 ID', 'order ord_0123456789 failed'],
    ['13자리 시각 값', 'at=1795412345678 retry=2'],
    ['예금주 조회가 아닌 경로의 숫자 마디', '/v1/orders/12345678901234/receipt'],
    ['UUID', '0b7e7c52-1111-4c2a-9e55-1d2a3b4c5d6e'],
  ])('V-T49 ③-5 %s는 그대로 둔다(지나친 가림 없음)', (_what, input) => {
    expect(maskPiiText(input)).toBe(input);
  });

  test('V-T49 ③-6 글이 아닌 값은 그대로 돌려준다', () => {
    const obj = { email: 'a@b.kr' };
    expect(maskPiiText(obj)).toBe(obj);
    expect(maskPiiText(4012888888881881)).toBe(4012888888881881);
    expect(maskPiiText(undefined)).toBeUndefined();
  });
});
