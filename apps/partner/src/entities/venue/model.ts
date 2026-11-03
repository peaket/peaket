// 공연장 목업. 지어낸 이름이다(실제 공연장 이름·배치도를 쓰지 않는다, d5 §6.5 '템플릿의 출처').

export interface Venue {
  id: string;
  name: string;
  city: string;
  /** 대략 좌석 수 */
  capacity: number;
  /** 등록된 배치본 이름 */
  layoutName: string;
}

export const venues: readonly Venue[] = [
  { id: 'venue-peaket-arena', name: '피켓 아레나', city: '서울', capacity: 15000, layoutName: '피켓 아레나 · 엔드 스테이지' },
  { id: 'venue-blue-hall', name: '블루 콘서트홀', city: '서울', capacity: 2000, layoutName: '블루 콘서트홀 · 기본' },
  { id: 'venue-river-theater', name: '리버 아트센터 대극장', city: '부산', capacity: 2500, layoutName: '대극장 · 오케스트라 피트 없음' },
  { id: 'venue-small-stage', name: '골목 소극장', city: '서울', capacity: 300, layoutName: '소극장 · 기본' },
];

export function getVenue(id: string): Venue | undefined {
  return venues.find((v) => v.id === id);
}
