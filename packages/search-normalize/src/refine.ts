// 브라우저 거르기 함수(docs/features/search.md §4.5, ADR-0271 결정 11). apps/web autocomplete.ts에서 옮긴다(모양 그대로).
// BAT-165 웨이브 7 시험 담당이 둔 빈 뼈대다. 구현 담당이 옮겨 채우고 웹이 다시 내보낸다.

export type InputKind = 'chosung' | 'hangul' | 'roman';

export interface LastAnswer<T> {
  /** 정규화한 입력 */
  query: string;
  items: readonly T[];
  /** 서버가 준 후보 수(그리지 못해 뺀 것 포함). 없으면 items 수 */
  rawCount?: number;
}

/** 입력 종류(초성만·한글·로마자) */
export function inputKind(_q: string): InputKind {
  throw new Error('아직 없음');
}

/** 받은 후보 안에서 거를 수 있으면 거른 결과, 아니면 undefined(다시 요청한다) */
export function refineLocally<T>(_last: LastAnswer<T> | undefined, _q: string, _label: (t: T) => string, _limit?: number): T[] | undefined {
  throw new Error('아직 없음');
}
