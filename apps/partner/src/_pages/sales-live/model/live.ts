// SCR-026 실시간 판매 현황 목업(보드 SCR-026-m·t·d·xl의 숫자 그대로). 합성 데이터다.
// 데이터를 잇는 단계에서 1분 주기 조회(GET /v1/partner/events/{eventId}/live-snapshot, d5 §6.9)로 바꾼다.
// 목업은 회차와 관계없이 같은 값이다(그림 예: LUMEN 10/25(일) 18:00 KST 회차, 피켓 아레나 2,400석, 오픈 21분 뒤).

/** 집계 기준 시각(판매 중) · 오픈 전 집계 시각 */
export const AS_OF = '20:22 KST';
export const AS_OF_BEFORE = '19:39 KST';
export const OPEN_AT = '10/14(수) 20:00 KST';
export const LOBBY_AT = '19:50 KST';

/** 분당 판매 매수(오픈 20:00부터 1분 단위, 최근 180분까지 싣는다). 합계 1,204석 = 판매 타일 */
export const MINUTE_SALES: readonly { at: string; sold: number }[] = [
  35, 97, 105, 101, 94, 86, 80, 72, 66, 62, 55, 48, 44, 40, 36, 33, 30, 26, 24, 24, 23, 23,
].map((sold, i) => ({ at: `20:${String(i).padStart(2, '0')}`, sold }));

export const SOLD_TOTAL = MINUTE_SALES.reduce((s, m) => s + m.sold, 0);
/** 평균 분당 판매(그래프 점선) */
export const SOLD_AVG = SOLD_TOTAL / MINUTE_SALES.length;
export const PEAK = MINUTE_SALES.reduce((a, b) => (b.sold > a.sold ? b : a));
export const LAST = MINUTE_SALES[MINUTE_SALES.length - 1]!;

export const CHART_SUMMARY = `분당 판매 추이 그래프. 20:00 오픈 직후 ${PEAK.at}에 분당 ${PEAK.sold}석으로 가장 많았고, 그 뒤 줄어 ${LAST.at}에는 분당 ${LAST.sold}석입니다. 오픈 뒤 평균은 분당 ${Math.round(SOLD_AVG)}석입니다.`;

/* ---------- 숫자 타일 ---------- */

export interface Tile {
  label: string;
  /** 'HH:MM KST'로 끝나면 휴대폰에서 ' KST'를 작게 그린다(보드 SCR-026-m) */
  value: string;
  meta: string;
}

/** 휴대폰·태블릿·데스크톱 타일 4개(보드 m·t·d) */
export const TILES: Record<'live' | 'before', readonly Tile[]> = {
  live: [
    { label: '판매', value: '1,204석', meta: '판매 대상 2,400석 중 50.2%' },
    { label: '잔여', value: '1,196석', meta: '다른 분이 홀드·결제 중인 좌석 포함' },
    { label: '예상 매진', value: '21:12 KST', meta: '최근 5분 판매 속도로 계산 [가정]' },
    { label: '지금 대기', value: '9,214명', meta: '대기열 진입 누적 48,000명' },
  ],
  before: [
    { label: '판매', value: '0석', meta: '판매 대상 2,400석' },
    { label: '잔여', value: '2,400석', meta: '다른 분이 홀드·결제 중인 좌석 포함' },
    { label: '예상 매진', value: '—', meta: '오픈 전입니다' },
    { label: '지금 대기', value: '0명', meta: '대기열 진입 누적 0명' },
  ],
};

/** xl 1440 타일 6개(보드 SCR-026-xl). '판매 전'은 xl 보드에 없어 m·t·d 판매 전 값으로 채웠다(추천안) */
export const TILES_XL: Record<'live' | 'before', readonly Tile[]> = {
  live: [
    { label: '판매', value: '1,204석', meta: '판매 대상 2,400석' },
    { label: '판매율', value: '50.2%', meta: '판매 ÷ 판매 대상 좌석' },
    { label: '잔여', value: '1,196석', meta: '다른 분이 홀드·결제 중인 좌석 포함' },
    { label: '예상 매진', value: '21:12 KST', meta: '최근 5분 판매 속도 [가정]' },
    { label: '대기열 진입(누적)', value: '48,000명', meta: '오픈 20:00 KST부터' },
    { label: '지금 대기', value: '9,214명', meta: `${AS_OF} 집계` },
  ],
  before: [
    { label: '판매', value: '0석', meta: '판매 대상 2,400석' },
    { label: '판매율', value: '0%', meta: '판매 ÷ 판매 대상 좌석' },
    { label: '잔여', value: '2,400석', meta: '다른 분이 홀드·결제 중인 좌석 포함' },
    { label: '예상 매진', value: '—', meta: '오픈 전입니다' },
    { label: '대기열 진입(누적)', value: '0명', meta: `오픈 ${OPEN_AT}부터` },
    { label: '지금 대기', value: '0명', meta: `${AS_OF_BEFORE} 집계` },
  ],
};

/* ---------- 구역별 잔여석(HeatmapGrid) ---------- */

/** 열 묶음(무대 쪽부터 3열씩) */
export const ROW_BANDS = ['1~3', '4~6', '7~9', '10~12', '13~15', '16~18'] as const;

/** 보드 SCR-026의 구역 정의: R구역 15열(묶음당 60석), S·A구역 18열(묶음당 75석). null은 그 묶음에 좌석이 없음 */
const HEAT_SPEC: readonly { zone: string; grade: string; cap: number; rem: readonly (number | null)[]; mergeFrom: number }[] = [
  { zone: 'R1', grade: 'R석', cap: 60, rem: [0, 2, 6, 13, 21, null], mergeFrom: -1 },
  { zone: 'R2', grade: 'R석', cap: 60, rem: [0, 1, 5, 11, 19, null], mergeFrom: -1 },
  { zone: 'S1', grade: 'S석', cap: 75, rem: [3, 9, 18, 31, 44, 58], mergeFrom: -1 },
  { zone: 'S2', grade: 'S석', cap: 75, rem: [2, 8, 16, 29, 41, 55], mergeFrom: -1 },
  // 판매 5건 [가정] 미만인 10~18열은 한 칸으로 합친다
  { zone: 'A1', grade: 'A석', cap: 75, rem: [53, 61, 67, 70, 73, 74], mergeFrom: 3 },
  { zone: 'A2', grade: 'A석', cap: 75, rem: [57, 63, 68, 71, 73, 74], mergeFrom: 3 },
];

export type HeatLevel = 'h1' | 'h2' | 'h3';

export interface HeatCell {
  /** 남은 좌석. null이면 '—'(좌석 없음) */
  rem: number | null;
  level: HeatLevel | null;
  /** 합친 칸이면 몇 묶음 */
  span: number;
}

export interface HeatRow {
  zone: string;
  grade: string;
  cells: HeatCell[];
  total: number;
}

/** 남은 비율 3단계(d2 CMP-034, ADR-0089): h1 50% 이상 · h2 10% 이상 50% 미만 · h3 10% 미만(매진 포함) */
function levelOf(rem: number, cap: number): HeatLevel {
  const r = rem / cap;
  if (r >= 0.5) return 'h1';
  if (r >= 0.1) return 'h2';
  return 'h3';
}

/** 보드 heatRows() 그대로. 오픈 전(before)이면 모든 좌석이 남고 칸을 합치지 않는다 */
export function heatRows(before: boolean): HeatRow[] {
  return HEAT_SPEC.map((s) => {
    const cells: HeatCell[] = [];
    let total = 0;
    s.rem.forEach((r, b) => {
      if (r === null) {
        cells.push({ rem: null, level: null, span: 1 });
        return;
      }
      if (!before && s.mergeFrom >= 0 && b >= s.mergeFrom) {
        if (b === s.mergeFrom) {
          const merged = s.rem.slice(b) as number[];
          const sum = merged.reduce((a, v) => a + v, 0);
          total += sum;
          cells.push({ rem: sum, level: levelOf(sum, s.cap * merged.length), span: merged.length });
        }
        return;
      }
      const rem = before ? s.cap : r;
      total += rem;
      cells.push({ rem, level: levelOf(rem, s.cap), span: 1 });
    });
    return { zone: s.zone, grade: s.grade, cells, total };
  });
}

export const HEAT_SUMMARY = {
  live: '구역별 잔여석 격자. R1·R2구역은 무대 쪽 1~3열이 매진이고 뒤로 갈수록 남은 좌석이 많습니다. A1·A2구역은 대부분 남아 있고, 판매 5건 미만인 10~18열은 한 칸으로 합쳤습니다. 구역 잔여 합계 1,196석.',
  before: '구역별 잔여석 격자. 오픈 전이라 모든 좌석이 남아 있습니다. 구역 잔여 합계 2,400석.',
} as const;

export function fmt(n: number): string {
  return n.toLocaleString('ko-KR');
}
