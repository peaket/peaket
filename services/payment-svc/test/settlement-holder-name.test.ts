// 예금주 이름 비교 규칙 시험(J-T8, settlement §3 '예금주 이름 비교 규칙' 1~4, ADR-0370 결정 2, F-07-7 계획 §5.1(다)).
// 표기 예시는 정본 J-T8 원문 그대로이고, 계획 §6 J-T8 줄의 NFKC 전각·가운뎃점·'유한회사'·'Inc.'를 더한다.
// 법인 표기 목록은 설정 파일 하나(holder-name-rules.json)이고, 그 내용을 정본 §3 2의 목록과 견준다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { holderMatches, normalizeHolderName } from '../src/modules/settlement/domain/holder-name.js';

const RULES = fileURLToPath(new URL('../src/modules/settlement/domain/holder-name-rules.json', import.meta.url));

describe('J-T8 예금주 이름 비교 [ASVS v5.0.0-2.2.3]', () => {
  const seller = { legalName: '주식회사 피켓엔터', representative: '김대표' };

  test.each(['㈜피켓엔터', '피켓 엔터(주)', '(주)피켓엔터'])('J-T8 ① 판매자 상호 "주식회사 피켓엔터"와 예금주 "%s"는 같다고 본다', (holder) => {
    expect(holderMatches(holder, seller)).toBe(true);
    expect(normalizeHolderName(holder)).toBe(normalizeHolderName(seller.legalName));
  });

  test('J-T8 ② 영문 "PEAKET Co., Ltd."와 "peaket"은 같다고 본다(법인 표기·쉼표·점·공백·대소문자)', () => {
    expect(normalizeHolderName('PEAKET Co., Ltd.')).toBe('peaket');
    expect(normalizeHolderName('peaket')).toBe('peaket');
    expect(holderMatches('peaket', { legalName: 'PEAKET Co., Ltd.', representative: '김대표' })).toBe(true);
  });

  test.each([
    ['피켓엔터테인먼트', '피켓엔터'],
    ['PEAKET ENT', '피켓엔터'],
  ])('J-T8 ③ 예금주 "%s"와 상호 "%s"는 다르다고 본다(음역하지 않는다)', (holder, legalName) => {
    expect(holderMatches(holder, { legalName, representative: '김대표' })).toBe(false);
    expect(normalizeHolderName(holder)).not.toBe(normalizeHolderName(legalName));
  });

  test('J-T8 ④ NFKC: 전각 "ＰＥＡＫＥＴ"은 "peaket", 묶음 글자 ㈜는 (주)로 풀려 지워진다', () => {
    expect(normalizeHolderName('ＰＥＡＫＥＴ')).toBe('peaket');
    expect(normalizeHolderName('㈜피켓엔터')).toBe('피켓엔터');
    expect(normalizeHolderName('（주）피켓엔터')).toBe('피켓엔터');
  });

  test('J-T8 ⑤ 문장부호(괄호·점·쉼표·하이픈·가운뎃점)와 공백을 지운다', () => {
    for (const holder of ['피켓·엔터', '피켓-엔터', '피켓.엔터', '피켓,엔터', '[피켓]엔터', '피켓 　엔터', '피켓・엔터']) {
      expect([holder, normalizeHolderName(holder)]).toEqual([holder, '피켓엔터']);
    }
  });

  test('J-T8 ⑥ 법인 표기 목록(유한회사·(유)·합자회사·사단법인·재단법인·Inc.·Corp.·LLC)도 지운다', () => {
    const cases: [string, string][] = [
      ['피켓엔터 유한회사', '피켓엔터'],
      ['(유)피켓엔터', '피켓엔터'],
      ['합자회사 피켓엔터', '피켓엔터'],
      ['사단법인 피켓엔터', '피켓엔터'],
      ['재단법인 피켓엔터', '피켓엔터'],
      ['Peaket Inc.', 'peaket'],
      ['Peaket Corp.', 'peaket'],
      ['Peaket LLC', 'peaket'],
    ];
    for (const [holder, want] of cases) expect([holder, normalizeHolderName(holder)]).toEqual([holder, want]);
  });

  test('J-T8 ⑦ 대표자 이름과 같아도 받고, 상호·대표자 어느 쪽과도 다르면 받지 않는다', () => {
    expect(holderMatches('김 대표', seller)).toBe(true);
    expect(holderMatches('김대표님', seller)).toBe(false);
    expect(holderMatches('다른회사', seller)).toBe(false);
    // 빈 이름은 정규화하면 빈 글이 되어 무엇과도 같지 않다(빈 상호와 빈 예금주가 같다고 보지 않는다)
    expect(holderMatches('(주)', { legalName: '주식회사', representative: '김대표' })).toBe(false);
  });

  test('J-T8 ⑧ 법인 표기 목록은 설정 파일 하나에 정본 §3 2의 목록 그대로 있다', () => {
    const rules = JSON.parse(readFileSync(RULES, 'utf8')) as { corporateMarks: unknown };
    expect(Array.isArray(rules.corporateMarks)).toBe(true);
    const marks = rules.corporateMarks as string[];
    expect([...marks].sort()).toEqual(['(유)', '(주)', 'Co.', 'Corp.', 'Inc.', 'LLC', 'Ltd.', '사단법인', '유한회사', '재단법인', '주식회사', '합자회사'].sort());
  });
});
