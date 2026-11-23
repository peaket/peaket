// 관제 실시간 표 위젯 값(openapi OpsWidgetRtSalesSummary, 키 rt-sales.summary)을 판매 중 탭 '구역별 잔여석' 칸의 화면 글자로 바꾼다
// (F-04-1 KPI 패널, docs/streaming.md §4.1·§4.5, control-tower §2 '판매 진행 중'). 실시간 잠정값이다.
// 색 칸(h1·h2·h3)은 보드의 범례(50% 이상·10% 이상 50% 미만·10% 미만)와 같은 기준으로 '남은 비율 = 잔여 ÷ (판매 + 잔여)'를 나눈다.
// 가져오는 것이 없는 순수 모듈이라 Node 내장 시험 실행기로 그대로 읽는다.

/** 위젯 키(ops-svc WIDGET_KEYS와 같은 이름) */
export const RT_SALES_KEY = 'rt-sales.summary';
/** NFR-009 판정 기준(신선도 5초 미만) */
export const FRESH_LIMIT_SECONDS = 5;

export interface RtSalesValue {
  widgetKey: string;
  source: string;
  at: string;
  eventId: string | null;
  sold?: number;
  remaining?: number | null;
  salesAmount?: number;
  ordersConfirmed?: number;
  ticketsIssued?: number;
  waiting?: number;
  queueEntries?: number;
  sections?: { sectionId: string; sold: number; remaining: number | null }[];
  freshnessSeconds?: number;
  degraded?: boolean;
  tradeGap?: boolean;
  error?: 'source-unavailable';
}

export type HeatClass = 'h1' | 'h2' | 'h3' | null;

export interface RtSalesView {
  tiles: { label: string; value: string }[];
  sections: { sectionId: string; remaining: string; heat: HeatClass }[];
  /** 화면 읽기 프로그램용 한 줄 요약 */
  summary: string;
  freshness: { text: string; late: boolean };
  degraded: boolean;
  tradeGap: boolean;
  /** 잔여석을 모름(회차 기준 자료 없음) */
  remainingUnknown: boolean;
}

const DASH = '—';
const int = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: number) => Math.round(v).toLocaleString('ko-KR');

export function isUnavailable(v: { error?: string } | null | undefined): boolean {
  return !v || v.error === 'source-unavailable';
}

/** 남은 비율로 범례 칸을 고른다. 판매·잔여가 모두 0이거나 잔여를 모르면 null */
export function heatOf(sold: number, remaining: number | null): HeatClass {
  if (remaining === null) return null;
  const total = sold + remaining;
  if (total <= 0) return null;
  const left = remaining / total;
  if (left >= 0.5) return 'h1';
  if (left >= 0.1) return 'h2';
  return 'h3';
}

export function rtSalesViewOf(v: RtSalesValue): RtSalesView {
  const sold = int(v.sold) ? v.sold : null;
  const remaining = int(v.remaining) ? v.remaining : null;
  const secs = int(v.freshnessSeconds) ? v.freshnessSeconds : null;
  const sections = (v.sections ?? []).map((s) => ({
    sectionId: s.sectionId,
    remaining: int(s.remaining) ? `${count(s.remaining)}석` : DASH,
    heat: heatOf(s.sold, int(s.remaining) ? s.remaining : null),
  }));
  const remainingText = remaining === null ? DASH : `${count(remaining)}석`;
  return {
    tiles: [
      { label: '판매', value: sold === null ? DASH : `${count(sold)}석` },
      { label: '잔여', value: remainingText },
      { label: '판매 금액', value: int(v.salesAmount) ? `${count(v.salesAmount)}원` : DASH },
      { label: '지금 대기', value: int(v.waiting) ? `${count(v.waiting)}명` : DASH },
    ],
    sections,
    summary: sections.length
      ? `구역별 남은 좌석. ${sections.map((s) => `${s.sectionId} ${s.remaining}`).join(', ')}.`
      : '구역별 남은 좌석을 아직 받지 못했습니다.',
    freshness: secs === null ? { text: DASH, late: true } : { text: `${secs < 10 ? secs.toFixed(1) : count(secs)}초 전`, late: secs >= FRESH_LIMIT_SECONDS },
    degraded: v.degraded === true,
    tradeGap: v.tradeGap === true,
    remainingUnknown: remaining === null,
  };
}
