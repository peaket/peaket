// 브라우저 거르기 함수 시험(BAT-165 웨이브 7 T-23, SR-T12, ADR-0271 결정 11: apps/web에서 이 패키지로 옮긴다).
// 정본: docs/features/search.md §4.5(152~155줄: 받은 후보가 8개보다 적을 때, 앞선 입력이 두 글자(한글 두 음절) 이상이고,
// 입력 종류(초성만·한글·로마자)가 같으며, 거른 결과가 0건이 아닐 때만 거른다), :303 SR-T12의 예.
import { describe, expect, test } from 'vitest';
import { inputKind, refineLocally } from '../src/index.js';

const label = (t: { label: string }) => t.label;
const of = (...names: string[]) => names.map((l) => ({ label: l }));
// 정본 값(search.md §4.1 모두 8개 [가정]). 코드 상수를 가져오지 않는다
const FULL = 8;

describe('브라우저 거르기', () => {
  test('SR-T12 거르기는 두 글자 이상·같은 입력 종류·0건 아님일 때만 하고 그 밖은 다시 요청한다', () => {
    // 정본 예 ①: '루' 다음 '루멘'은 다시 요청한다('루'의 목록에는 중간 일치 '빛나는루멘'이 없다)
    expect(refineLocally({ query: '루', items: of('루멘 콘서트', '루나 페스티벌') }, '루멘', label)).toBeUndefined();
    // 두 음절이면 거른다
    expect(refineLocally({ query: '루멘', items: of('루멘 콘서트', '루멘 팬미팅') }, '루멘 팬', label)?.map(label)).toEqual(['루멘 팬미팅']);
    // 정본 예 ②: 'ㄹㅁ'(초성) 다음 'ㄹㅁㅏ'(낱자)는 비교 방식이 바뀌어 다시 요청한다. 초성끼리면 거른다
    expect(refineLocally({ query: 'ㄹㅁ', items: of('루멘 팬미팅', '루멘 콘서트') }, 'ㄹㅁㅏ', label)).toBeUndefined();
    expect(refineLocally({ query: 'ㄹㅁ', items: of('루멘 팬미팅', '루멘 콘서트') }, 'ㄹㅁ ㅍ', label)?.map(label)).toEqual(['루멘 팬미팅']);
    // 정본 예 ③: 로마자 입력에서 거른 결과가 0건이면 다시 요청한다(서버가 한/영 변환 후보를 준다)
    expect(refineLocally({ query: 'fk', items: of('FKD 라이브') }, 'fkd', label)?.map(label)).toEqual(['FKD 라이브']);
    expect(refineLocally({ query: 'fk', items: of('FKD 라이브') }, 'fkdl', label)).toBeUndefined();
    // 로마자 한 글자는 출발점이 되지 않는다. 두 글자부터
    expect(refineLocally({ query: 'l', items: of('LUMEN') }, 'lu', label)).toBeUndefined();
    expect(refineLocally({ query: 'lu', items: of('LUMEN', 'LUNA') }, 'lum', label)?.map(label)).toEqual(['LUMEN']);
    // 후보 수 경계: 7개면 거르고 8개면(더 있을 수 있어) 다시 요청한다. 서버가 준 수(rawCount)로 센다
    expect(refineLocally({ query: 'lu', items: Array.from({ length: FULL - 1 }, () => ({ label: 'lumen' })) }, 'lum', label)).toHaveLength(FULL - 1);
    expect(refineLocally({ query: 'lu', items: Array.from({ length: FULL }, () => ({ label: 'lumen' })) }, 'lum', label)).toBeUndefined();
    expect(refineLocally({ query: 'lu', items: of('LUMEN'), rawCount: FULL }, 'lum', label)).toBeUndefined();
    // 앞선 입력으로 시작하지 않거나 같은 입력이면 다시 요청한다. 앞선 답이 없어도 요청한다
    expect(refineLocally({ query: 'lu', items: of('LUMEN') }, 'ab', label)).toBeUndefined();
    expect(refineLocally({ query: 'lu', items: of('LUMEN') }, 'lu', label)).toBeUndefined();
    expect(refineLocally(undefined, 'lumen', label)).toBeUndefined();
    // 앞선 답에 브라우저가 설명하지 못하는 후보(다른 이름으로 맞은 것)가 섞였으면 다시 요청한다
    expect(refineLocally({ query: '루멘', items: of('LUMENS', '루멘스타 콘서트') }, '루멘스', label)).toBeUndefined();
    // 띄어쓰기를 없앤 값으로도 견준다
    expect(refineLocally({ query: '루멘', items: of('루멘 콘서트', '루멘 팬미팅') }, '루멘콘', label)?.map(label)).toEqual(['루멘 콘서트']);
  });

  test('SR-T12 입력 종류는 초성만·한글·로마자 셋이다', () => {
    expect(['ㄹㅁ', 'ㄹㅁ ㅎ', 'ㄳ'].map(inputKind)).toEqual(['chosung', 'chosung', 'chosung']);
    expect(['루ㅁ', 'ㄹㅏ', '루멘', '루멘 2026'].map(inputKind)).toEqual(['hangul', 'hangul', 'hangul', 'hangul']);
    expect(['lumen', 'fkdl', 'lumen 2026'].map(inputKind)).toEqual(['roman', 'roman', 'roman']);
  });
});
