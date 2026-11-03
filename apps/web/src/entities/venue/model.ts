// 공연장 목업(d5 §10.3 '피켓 아레나(가상)'). 모든 이름·주소는 지어낸 것이다.
export interface Venue {
  id: string;
  name: string;
  /** 홈 공연장 줄의 원형 이니셜(d5 §5.1 ⑪) */
  initial: string;
  /** 표시 주소(가상) */
  address: string;
  /** 좌석 수 [가정] */
  seats?: number;
}

export const VENUES: readonly Venue[] = [
  { id: 'ven-peaket-arena', name: '피켓 아레나', initial: '피', address: '서울특별시 가상구 피켓로 100 (가상 주소)', seats: 2400 },
  { id: 'ven-seoul-small', name: '서울 소극장', initial: '서', address: '서울특별시 가상구 소극장길 12 (가상 주소)', seats: 320 },
  { id: 'ven-starlight-hall', name: '별빛 콘서트홀', initial: '별', address: '서울특별시 가상구 별빛대로 7 (가상 주소)', seats: 1200 },
  { id: 'ven-hangang-jazz', name: '한강 재즈홀', initial: '한', address: '서울특별시 가상구 강변로 33 (가상 주소)', seats: 480 },
  { id: 'ven-forest-stage', name: '숲속 야외무대', initial: '숲', address: '경기도 가상시 숲길 5 (가상 주소)', seats: 5000 },
  { id: 'ven-sea-theater', name: '바다 극장', initial: '바', address: '부산광역시 가상구 바닷길 21 (가상 주소)', seats: 640 },
];

export function getVenue(id: string): Venue | undefined {
  return VENUES.find((v) => v.id === id);
}
