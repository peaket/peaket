// 검색어 정규화와 일치 등급(SR-T1·SR-T2·SR-T3, docs/features/search.md §3·§4.1, ADR-0242)
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { GRADE, matchGrade, nameKeys, normalize, queryKeys, searchNames } from '../src/index.js';

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8')) as { normalize: Array<[string, string]> };
const grade = (q: string, name: string) => matchGrade(queryKeys(q), nameKeys(name));

describe('SR-T1 정규화', () => {
  test.each(vectors.normalize)('%s', (input, want) => {
    expect(normalize(input)).toBe(want);
  });

  test('두 번 정규화해도 같다', () => {
    for (const [input] of vectors.normalize) expect(normalize(normalize(input))).toBe(normalize(input));
  });
});

describe('SR-T2 조합 중 글자', () => {
  test.each(['루', '룸', '루메', '루멘'])('%s는 루멘 앞부분이다', (q) => {
    expect(grade(q, '루멘')).toBeLessThanOrEqual(GRADE.PREFIX);
    expect(grade(q, '루멘')).toBeGreaterThanOrEqual(GRADE.EXACT);
  });
});

describe('SR-T3 초성', () => {
  test.each(['ㄹㅁ', 'ㄱㅅ', 'ㄳ'])('%s는 초성만이다', (q) => {
    expect(queryKeys(q).chosung).not.toBeNull();
  });

  test.each(['ㄹㅏ', 'ㅏ', '루ㅁ', 'lumen'])('%s는 초성만이 아니다', (q) => {
    expect(queryKeys(q).chosung).toBeNull();
  });

  test('초성이 겹받침·겹모음이 든 이름과 맞고, 낱자 하나가 이름 앞부분과 맞는다', () => {
    expect(grade('ㄱ', '값')).toBe(GRADE.PREFIX);
    expect(grade('ㄱ', '과')).toBe(GRADE.PREFIX);
    // 리뷰 재현: 낱자로는 맞지 않아 초성 비교로만 맞는 입력
    expect(grade('ㄱㅈ', '값진')).toBe(GRADE.PREFIX);
    expect(grade('ㄱㄱ', '과거')).toBe(GRADE.PREFIX);
    expect(grade('ㄹㅁ', '루멘')).toBe(GRADE.PREFIX);
    expect(grade('ㄹ', '루멘')).toBe(GRADE.PREFIX);
  });
});

describe('일치 등급(§4.1)', () => {
  test('정확히 같음 > 이름 앞부분 > 낱말 앞부분 > 중간', () => {
    expect(grade('루멘 콘서트', '루멘 콘서트')).toBe(GRADE.EXACT);
    expect(grade('루멘콘서트', '루멘 콘서트')).toBe(GRADE.EXACT);
    expect(grade('루멘', '루멘 콘서트')).toBe(GRADE.PREFIX);
    expect(grade('콘서트', '루멘 콘서트')).toBe(GRADE.WORD);
    expect(grade('ㅋㅅ', '루멘 콘서트')).toBe(GRADE.WORD);
    expect(grade('멘콘', '루멘콘서트')).toBe(GRADE.MIDDLE);
    expect(grade('없음', '루멘 콘서트')).toBe(GRADE.NONE);
  });

  test('중간 일치는 입력이 두 음절 이상일 때만 본다', () => {
    expect(grade('멘', '루멘')).toBe(GRADE.NONE);
    expect(grade('루멘', '빛나는루멘')).toBe(GRADE.MIDDLE);
  });

  test('로마자는 대소문자를 가리지 않는다', () => {
    expect(grade('lumen', 'LUMEN Concert')).toBe(GRADE.PREFIX);
    expect(grade('CONCERT', 'LUMEN Concert')).toBe(GRADE.WORD);
  });

  test('리뷰 재현: 낱자·초성 비교는 낱말 시작부터 이름 끝까지 본다(띄어쓰기를 넘어)', () => {
    expect(grade('체조 ㄱ', '올림픽 체조 경기장')).toBe(GRADE.WORD);
    expect(grade('체조 겨', '올림픽 체조 경기장')).toBe(GRADE.WORD);
    expect(grade('ㅊㅈㄱ', '올림픽 체조 경기장')).toBe(GRADE.WORD);
  });

  test('리뷰 재현: 초성 비교에서 한글 밖의 글자를 건너뛰지 않는다', () => {
    expect(grade('ㄷㄹㄱ', 'G드래곤')).toBe(GRADE.NONE);
  });

  test('빈 입력은 아무것과도 맞지 않는다', () => {
    expect(grade('   ', '루멘')).toBe(GRADE.NONE);
  });
});

describe('searchNames(대상마다 한 번, §3.2·§4.1)', () => {
  const items = [
    { id: 'b', name: '다른 콘서트 홀', aliases: [] },
    { id: 'a', name: '루멘', aliases: ['LUMEN'] },
    { id: 'd', name: '가나 루멘', aliases: [] },
    { id: 'c', name: '루멘 아트홀', aliases: ['루멘'] },
  ];
  const ids = (q: string) => searchNames(items, q).map((r) => r.item.id);

  test('등급 → 가나다 → ID 차례이고, 이름과 다른 이름이 함께 맞아도 한 번만 더 높은 등급으로 나온다', () => {
    expect(ids('루멘')).toEqual(['a', 'c', 'd']);
    expect(searchNames(items, '루멘').filter((r) => r.item.id === 'c')).toHaveLength(1);
    expect(searchNames(items, '루멘').find((r) => r.item.id === 'c')?.grade).toBe(GRADE.EXACT);
  });

  test('다른 이름으로도 찾는다', () => {
    expect(ids('lumen')).toEqual(['a']);
  });

  test('로마자만 쳤고 결과가 없으면 한/영 변환으로 다시 찾는다(§3.2 ④)', () => {
    const out = searchNames(items, 'fnaps');
    expect(out.map((r) => r.item.id)).toEqual(['a', 'c', 'd']);
  });

  test('리뷰 재현: 한/영 변환은 Shift를 살리고, 없으면 소문자로 다시 찾는다', () => {
    const list = [
      { id: 'k', name: '꽃', aliases: [] },
      { id: 's', name: '쏘', aliases: [] },
    ];
    expect(searchNames(list, 'Rhc').map((r) => r.item.id)).toEqual(['k']);
    expect(searchNames(list, 'Th').map((r) => r.item.id)).toEqual(['s']);
    expect(searchNames([{ id: 'l', name: '루멘', aliases: [] }], 'FNAPS').map((r) => r.item.id)).toEqual(['l']);
  });

  test('로마자 이름이 실제로 맞으면 변환하지 않는다', () => {
    const list = [
      { id: 'x', name: 'fnaps', aliases: [] },
      { id: 'y', name: '루멘', aliases: [] },
    ];
    expect(searchNames(list, 'fnaps').map((r) => r.item.id)).toEqual(['x']);
  });
});
