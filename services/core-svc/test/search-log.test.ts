// 검색어 가리기와 0건 검색어 목록 시험(BAT-165 웨이브 7 T-16·T-18, SR-T17).
// 정본: docs/features/search.md §11(285·286줄: 이메일 꼴 → [이메일], 0으로 시작하는 9~11자리 숫자(사이 하이픈·점·공백 허용) → [전화],
// 그 밖의 이어진 숫자 5자리 이상 → [숫자], 0건 목록은 그 주에 서로 다른 줄로 5번 [가정] 이상 나온 검색어, 상위 50개), :307 SR-T17.
// '한 주'는 KST 월요일 0시부터 7일이다(계획 '정본에 없던 세부', 추천 적용 2026-11-16). 값은 정본에서 적고 코드 상수를 가져오지 않는다.
import { describe, expect, test } from 'vitest';
import { maskSearchQuery, zeroResultQueries } from '../src/modules/catalog/index.js';

describe('검색어 가리기', () => {
  test('SR-T17 검색어 가리기는 전화·이메일·5자리 이상 숫자를 가리고 연도·회차 숫자는 남긴다', () => {
    // 정본 예시 넷(search.md:307)
    expect(maskSearchQuery('010-1234-5678')).toBe('[전화]');
    expect(maskSearchQuery('01012345678')).toBe('[전화]');
    expect(maskSearchQuery('a@b.kr')).toBe('[이메일]');
    expect(maskSearchQuery('1234567')).toBe('[숫자]');
    // 남는 둘
    expect(maskSearchQuery('2026 루멘')).toBe('2026 루멘');
    expect(maskSearchQuery('루멘 2회')).toBe('루멘 2회');
    // 전화번호 자릿수 경계: 9·10·11자리는 전화, 8·12자리는 전화가 아니고 5자리 이상 숫자다
    expect(maskSearchQuery('021234567')).toBe('[전화]');
    expect(maskSearchQuery('0212345678')).toBe('[전화]');
    expect(maskSearchQuery('01234567')).toBe('[숫자]');
    expect(maskSearchQuery('010123456789')).toBe('[숫자]');
    // 0으로 시작하지 않는 11자리는 전화가 아니다
    expect(maskSearchQuery('11012345678')).toBe('[숫자]');
    // 사이의 하이픈·점·공백
    expect(maskSearchQuery('02-123-4567')).toBe('[전화]');
    expect(maskSearchQuery('010.1234.5678')).toBe('[전화]');
    expect(maskSearchQuery('010 1234 5678')).toBe('[전화]');
    // 숫자 4자리는 남고 5자리는 가린다
    expect(maskSearchQuery('루멘 1234')).toBe('루멘 1234');
    expect(maskSearchQuery('루멘 12345')).toBe('루멘 [숫자]');
    // 글 사이에 섞여도 그 부분만 바꾼다
    expect(maskSearchQuery('010-1234-5678 루멘')).toBe('[전화] 루멘');
    expect(maskSearchQuery('루멘 a@b.kr 문의')).toBe('루멘 [이메일] 문의');
    expect(maskSearchQuery('루멘 fan.club@peaket.example')).toBe('루멘 [이메일]');
    // 가릴 것이 없으면 그대로다(빈 값 포함)
    expect(maskSearchQuery('루멘 콘서트')).toBe('루멘 콘서트');
    expect(maskSearchQuery('')).toBe('');
  });
});

describe('검색어 가리기(넓힌 규칙)', () => {
  test('SR-T17 검색어 가리기는 국제 꼴 전화·여러 글자 구분자·괄호·네 자리씩 띄운 카드 번호·띄운 이메일도 가린다(W7L2-S4)', () => {
    // 정본: docs/features/search.md §11 가리기 문장(ADR-0271 결정 19: 이메일 @ 앞뒤 공백, 전화 +82 뒤 8~10자리, 숫자 사이 구분자 0~3글자,
    // 구분자로 이어진 숫자 합 5자리 이상이면 [숫자], 떨어진 4자리 이하는 남김)
    expect(maskSearchQuery('+82 10-1234-5678')).toBe('[전화]');
    expect(maskSearchQuery('010 - 1234 - 5678')).toBe('[전화]');
    expect(maskSearchQuery('(010)1234-5678')).toBe('[전화]');
    expect(maskSearchQuery('1234 5678 9012 3456')).toBe('[숫자]');
    expect(maskSearchQuery('hong @ example.com')).toBe('[이메일]');
    // 경계: 구분자 3글자는 이어진 것으로 보고 가린다, 4글자는 떨어진 두 묶음(4자리씩)이라 남긴다
    expect(maskSearchQuery('010   1234')).toBe('[숫자]');
    expect(maskSearchQuery('010    1234')).toBe('010    1234');
    // 남는 것(대조군)
    for (const keep of ['2026 루멘', '루멘 2회', '2026 루멘 2회']) expect(maskSearchQuery(keep)).toBe(keep);
  });
});

describe('0건 검색어 목록', () => {
  // 2026-11-16(월) 0시 KST = 2026-11-15T15:00:00Z
  const WEEK_START = '2026-11-15T15:00:00.000Z';
  const start = Date.parse(WEEK_START);
  const WEEK_MS = 7 * 86_400_000;
  const at = (ms: number) => new Date(ms).toISOString();
  const inside = (i: number) => at(start + 3_600_000 + i * 60_000);
  const lines = (query: string, n: number, results = 0) => Array.from({ length: n }, (_, i) => ({ query, results, at: inside(i) }));

  test('SR-T17 한 주에 4번 나온 0건 검색어는 목록에 없고 5번이면 있으며 상위 50개만 보인다', () => {
    const input = [
      ...lines('네번', 4),
      ...lines('다섯번', 5),
      // 결과가 있는 줄은 세지 않는다: 0건 4 + 결과 있음 1
      ...lines('결과섞임', 4),
      { query: '결과섞임', results: 3, at: inside(9) },
      // 주의 시작 경계: 시작 − 1ms는 지난 주, 시작은 이번 주
      ...lines('시작전', 4),
      { query: '시작전', results: 0, at: at(start - 1) },
      ...lines('시작', 4),
      { query: '시작', results: 0, at: at(start) },
      // 주의 끝 경계: 끝 − 1ms는 이번 주, 끝(다음 월요일 0시)은 다음 주
      ...lines('끝전', 4),
      { query: '끝전', results: 0, at: at(start + WEEK_MS - 1) },
      ...lines('끝', 4),
      { query: '끝', results: 0, at: at(start + WEEK_MS) },
    ];
    const out = zeroResultQueries(input, { weekStart: WEEK_START });
    // 셋 다 5번이라 차례는 따지지 않는다
    expect(out).toEqual(
      expect.arrayContaining([
        { query: '다섯번', count: 5 },
        { query: '시작', count: 5 },
        { query: '끝전', count: 5 },
      ]),
    );
    expect(out).toHaveLength(3);
    for (const q of ['네번', '결과섞임', '시작전', '끝']) expect(out.map((x) => x.query)).not.toContain(q);

    // 상위 50개: 서로 다른 0건 검색어 60개(횟수 5~64번, 서로 다르게)에서 횟수가 많은 50개만, 많은 차례로
    const many = Array.from({ length: 60 }, (_, i) => lines(`검색어${i}`, 5 + i)).flat();
    const top = zeroResultQueries(many, { weekStart: WEEK_START });
    expect(top).toHaveLength(50);
    expect(top.map((x) => x.count)).toEqual(Array.from({ length: 50 }, (_, i) => 64 - i));
    expect(top[0]).toEqual({ query: '검색어59', count: 64 });
    expect(top[49]).toEqual({ query: '검색어10', count: 15 });
    expect(top.map((x) => x.query)).not.toContain('검색어9');

    // 빈 입력은 빈 목록이다
    expect(zeroResultQueries([], { weekStart: WEEK_START })).toEqual([]);
  });
});

// W9-fix3 F6(BAT-165 R-663 W7L2-S11, 시험 담당 w9f3-test 2026-11-17): 구분자에 빗금(/)·역빗금(\)·밑줄(_)·쉼표(,)·가운뎃점(·, U+00B7)을 더한다.
// 정본: docs/features/search.md §11 '검색어 가리기'(추천 적용 2026-11-17, W9-fix3). 하이픈·점·공백·괄호와 1~3글자 상한은 그대로다
describe('검색어 가리기(구분자 더함, W9-fix3)', () => {
  test('W9F3 F6 SR-T17 빗금·밑줄·쉼표·역빗금·가운뎃점으로 이은 번호도 가린다 [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-14.2.4]', () => {
    // 전화: 새 구분자 다섯 각각, 그리고 공백과 섞인 빗금
    for (const phone of ['010/1234/5678', '010_1234_5678', '010,1234,5678', '010\\1234\\5678', '010·1234·5678', '010 / 1234 / 5678']) {
      expect(maskSearchQuery(phone), phone).toBe('[전화]');
    }
    // 국제 꼴도 같은 구분자로 잇는다
    expect(maskSearchQuery('+82/10/1234/5678')).toBe('[전화]');
    // 전화가 아닌 이어진 숫자 5자리 이상: 카드 번호, 날짜(정본 예시), 쉼표 자리 나눔
    expect(maskSearchQuery('1234/5678/9012/3456')).toBe('[숫자]');
    expect(maskSearchQuery('2026/11/17')).toBe('[숫자]');
    expect(maskSearchQuery('1,000,000')).toBe('[숫자]');
    // 글 사이에 섞여도 그 부분만 바꾼다
    expect(maskSearchQuery('루멘 010/1234/5678 문의')).toBe('루멘 [전화] 문의');
    // 남는 것: 4자리 이하로 떨어진 숫자, 글자로 떨어진 연도, 구분자 4글자(잇지 않는다)
    for (const keep of ['루멘 2/3회', '2026_루멘', '010////1234', '010____1234', '010,,,,1234']) expect(maskSearchQuery(keep), keep).toBe(keep);
    // 경계: 구분자 3글자는 잇는다
    expect(maskSearchQuery('010///1234')).toBe('[숫자]');
  });
});
