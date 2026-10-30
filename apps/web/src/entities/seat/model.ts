// 좌석맵 목업(SCR-010 좌석 선택, d5 §5.10 '시연 흉내': 소형 지도, 구역 6개). 캔버스 보드 SCR-010의 무대·구역 도형, 좌석 좌표, 좌석 상태를 그대로 옮겼다.
// 좌표는 1000×600 배치도 좌표계다(좌석맵 정적 파일의 무대·구역 도형과 좌석 좌표를 흉내 낸다). 실제 서비스에서는 CDN 정적 파일 + 구역별 변경분으로 바뀐다.
// 구역의 남은 좌석(많음·적음·매진)은 heat 3단계와 무늬로 칠한다(ADR-0089: 50% 이상 · 10% 이상 50% 미만 · 10% 미만).

export type SeatGrade = 'R석' | 'S석' | 'A석';
export type ZoneLevel = '많음' | '적음' | '매진';

/** 등급과 가격(비싼 순, CMP-024) */
export const SEAT_TIERS: readonly { name: SeatGrade; price: number }[] = [
  { name: 'R석', price: 154000 },
  { name: 'S석', price: 132000 },
  { name: 'A석', price: 110000 },
];

/** 등급 → 구역 면 색(heat 3단계는 등급 색으로도 쓴다: R 진함 · S 중간 · A 옅음) */
export const GRADE_FILL: Record<SeatGrade, string> = {
  R석: 'var(--heat-3)',
  S석: 'var(--heat-2)',
  A석: 'var(--heat-1)',
};

export interface SeatZone {
  id: string;
  /** 'R1구역' */
  name: string;
  grade: SeatGrade;
  price: number;
  /** 입장 게이트 '동문' */
  gate: string;
  level: ZoneLevel;
  /** SVG polygon points(배치도 좌표) */
  points: string;
  /** 구역 이름표 상자(x·y·폭, 높이 60) */
  label: { x: number; y: number; w: number };
}

/** 무대 상자(배치도 좌표) */
export const STAGE_BOX = { x: 420, y: 56, w: 160, h: 40 } as const;

export const SEAT_ZONES: readonly SeatZone[] = [
  { id: 'S1', name: 'S1구역', grade: 'S석', price: 132000, gate: '동문', level: '많음', points: '196,126 358,118 350,282 186,296', label: { x: 198, y: 175, w: 150 } },
  { id: 'R1', name: 'R1구역', grade: 'R석', price: 154000, gate: '동문', level: '적음', points: '382,118 495,118 495,282 374,282', label: { x: 383, y: 170, w: 108 } },
  { id: 'R2', name: 'R2구역', grade: 'R석', price: 154000, gate: '서문', level: '적음', points: '505,118 618,118 626,282 505,282', label: { x: 509, y: 170, w: 108 } },
  { id: 'S2', name: 'S2구역', grade: 'S석', price: 132000, gate: '서문', level: '적음', points: '642,118 804,126 814,296 650,282', label: { x: 652, y: 175, w: 150 } },
  { id: 'A1', name: 'A1구역', grade: 'A석', price: 110000, gate: '동문', level: '많음', points: '196,318 487,318 487,500 206,500', label: { x: 269, y: 379, w: 150 } },
  { id: 'A2', name: 'A2구역', grade: 'A석', price: 110000, gate: '서문', level: '매진', points: '513,318 804,318 794,500 513,500', label: { x: 581, y: 379, w: 150 } },
];

/** 확대했을 때 그리는 좌석 줄 수·한 줄 좌석 수(보드 R1구역 앞 20열 × 30석) */
export const SEAT_ROWS = 20;
export const SEAT_COLS = 30;

/**
 * 좌석 그림 장면. pick: 내가 12열 7·8번을 고름 · lost: 그 좌석을 다른 분이 먼저 잡음(가까운 9·10번 강조)
 * · free: 홀드가 풀려 다시 가능 · recent: 내가 방금 놓은 좌석(테두리만)
 */
export type SeatScene = 'pick' | 'lost' | 'free' | 'recent';

/** 좌석 하나의 키트 클래스('' 예매 가능 · held · mine · sold · unav · wc, 덧붙임 is-focus · recent). 보드 seatClass 그대로 */
export function seatClassAt(row: number, col: number, scene: SeatScene): string {
  if (scene === 'recent' && row === 12 && (col === 7 || col === 8)) return col === 8 ? 'is-focus recent' : 'recent';
  if (row === 12 && (col === 7 || col === 8)) return scene === 'lost' ? 'held' : scene === 'free' ? '' : 'mine';
  if (row === 12 && (col === 9 || col === 10)) return scene === 'lost' ? 'is-focus' : '';
  if (row === 12 && col >= 3 && col <= 6) return col === 3 ? 'held' : col === 6 ? 'sold' : '';
  if (row === 1 && col >= 13 && col <= 18) return 'unav';
  // 고정 의사 난수(보드와 같은 식): 앞 6열은 더 많이 팔렸다
  let h = Math.sin(row * 12.9898 + col * 78.233) * 43758.5453;
  h -= Math.floor(h);
  const cut = row <= 6 ? 0.42 : 0.26;
  if (h < cut) return 'sold';
  if (h < cut + 0.1) return 'held';
  return '';
}

/** 좌석 중심 좌표(배치도 좌표). 뒤 열로 갈수록 간격이 조금 넓고, 가운데 통로를 둔 완만한 호 */
export function seatXY(row: number, col: number): { x: number; y: number } {
  const p = 5.3 + 0.02 * (row - 1);
  const x = 500 + (col - 15.5) * p + (col >= 16 ? 6 : -6);
  const y = 128 + (row - 1) * 7.6 - 0.01 * (col - 15.5) * (col - 15.5);
  return { x, y };
}

/** 열의 예매 가능 좌석 수(목록 보기 '예매 가능 N석', 보드처럼 앞 15석 기준) */
export function openSeatCount(row: number): number {
  let n = 0;
  for (let c = 1; c <= 15; c++) {
    const k = seatClassAt(row, c, 'pick');
    if (k === '' || k === 'wc') n++;
  }
  return n;
}

const STATUS_TEXT: Record<string, string> = {
  '': '예매 가능',
  held: '다른 분 선택',
  mine: '내 선택',
  sold: '판매됨·선택 불가',
  unav: '판매 제외',
  wc: '예매 가능 · 휠체어석',
};

export interface ListSeat {
  /** '7번' */
  label: string;
  /** 키트 클래스 */
  cls: string;
  status: string;
  selected: boolean;
  /** 고를 수 없음(aria-disabled) */
  disabled: boolean;
}

/** 목록 보기(CMP-022)의 한 열 좌석들(보드 listSeats) */
export function listSeats(row: number, from: number, to: number): ListSeat[] {
  const out: ListSeat[] = [];
  for (let c = from; c <= to; c++) {
    const k = seatClassAt(row, c, 'pick');
    const open = k === '' || k === 'wc' || k === 'mine';
    out.push({ label: `${c}번`, cls: k, status: STATUS_TEXT[k] ?? '예매 가능', selected: k === 'mine', disabled: !open });
  }
  return out;
}
