// 좌석맵 목업: 템플릿 10종(d5 §6.5 표, 좌석 수는 [가정])과 LUMEN 공연 배치본 요약.
// 실제 공연장 배치도가 아니라 흔한 공연장 모양을 본뜬 출발점이다(ADR-0066). 구역 수는 캔버스 보드 SCR-022 템플릿 카드 값이다.

export type TemplateFamily = '아레나·돔·경기장' | '극장' | '콘서트홀' | '평면';

export interface SeatmapTemplate {
  code: string;
  name: string;
  family: TemplateFamily;
  /** 기본 좌석(약) */
  defaultCapacity: number;
  /** 구성 한 줄 */
  composition: string;
  /** 고를 수 있는 것(없으면 '—') */
  variants: string;
  floors: number;
  zones: number;
}

export const TEMPLATE_FAMILIES: readonly ('전체' | TemplateFamily)[] = ['전체', '아레나·돔·경기장', '극장', '콘서트홀', '평면'];

export const seatmapTemplates: readonly SeatmapTemplate[] = [
  { code: 'ARENA-END', name: '실내 아레나 · 엔드 스테이지', family: '아레나·돔·경기장', defaultCapacity: 12000, composition: '플로어 지정석 + 2·3층 스탠드(말굽형)', variants: '—', floors: 3, zones: 24 },
  { code: 'ARENA-THRUST', name: '실내 아레나 · 돌출 무대', family: '아레나·돔·경기장', defaultCapacity: 11000, composition: '엔드 스테이지에서 플로어 가운데로 길게 나온 무대', variants: '돌출 길이', floors: 3, zones: 24 },
  { code: 'ARENA-CENTER', name: '실내 아레나 · 센터 무대', family: '아레나·돔·경기장', defaultCapacity: 13000, composition: '가운데 무대, 사방 플로어·스탠드', variants: '—', floors: 3, zones: 32 },
  { code: 'DOME', name: '돔 구장', family: '아레나·돔·경기장', defaultCapacity: 25000, composition: '그라운드 지정석 + 1~3층 스탠드, 외야 쪽 무대', variants: '그라운드 구역 수', floors: 4, zones: 44 },
  { code: 'STADIUM', name: '종합운동장', family: '아레나·돔·경기장', defaultCapacity: 50000, composition: '그라운드 지정석 + 둥근 스탠드, 한쪽 무대', variants: '그라운드 구역 수', floors: 2, zones: 36 },
  { code: 'THEATER-L', name: '대극장(3층)', family: '극장', defaultCapacity: 2500, composition: '1층 + 2·3층 발코니', variants: '오케스트라 피트 있음·없음', floors: 3, zones: 12 },
  { code: 'THEATER-M', name: '중극장(2층)', family: '극장', defaultCapacity: 1000, composition: '1층 + 2층', variants: '오케스트라 피트 있음·없음', floors: 2, zones: 6 },
  { code: 'THEATER-S', name: '소극장', family: '극장', defaultCapacity: 300, composition: '단층 경사 객석', variants: '—', floors: 1, zones: 2 },
  { code: 'HALL', name: '콘서트홀(합창석)', family: '콘서트홀', defaultCapacity: 2000, composition: '1층 + 무대 뒤 합창석 + 2·3층 옆 발코니', variants: '합창석 판매 여부', floors: 3, zones: 11 },
  { code: 'FLAT', name: '평면 블록(컨벤션·야외 특설)', family: '평면', defaultCapacity: 3000, composition: '평평한 바닥의 의자 블록', variants: '블록 수', floors: 1, zones: 12 },
];

export interface SeatmapSummary {
  totalSeats: number;
  byGrade: readonly { grade: string; seats: number }[];
  /** 예상 매출 표시 문자열 */
  expectedRevenue: string;
  wheelchairSeats: number;
  /** 기준 수 M = min(⌈N ÷ 100⌉, 20) */
  wheelchairRequired: number;
}

/** LUMEN 콘서트 2026 서울(피켓 아레나) 배치본 요약(d5 §6.5 미리보기 요약 줄) */
export const lumenSeatmapSummary: SeatmapSummary = {
  totalSeats: 15000,
  byGrade: [
    { grade: 'R', seats: 4200 },
    { grade: 'S', seats: 6300 },
    { grade: 'A', seats: 4500 },
  ],
  expectedRevenue: '₩19억',
  wheelchairSeats: 120,
  wheelchairRequired: 20,
};
