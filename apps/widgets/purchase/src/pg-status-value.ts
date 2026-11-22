// 위젯 값(openapi OpsWidgetPurchasePgStatusSummary)을 '결제사' 위젯의 화면 글자로 바꾼다(ADR-0360 결정 9).
// 원천은 payment-svc 지표(결제사 라벨)라 회차와 무관하다. 승인률·승인 호출 p99·결제 확정 p99는 아직 원천 지표가 없어 '—'다.
// 기본 결제사는 진행 중 호출이 가장 많은 결제사, 다음 결제사는 대체로 그린다. 가져오는 것이 없는 순수 모듈이라 Node 내장 시험 실행기로 그대로 읽는다.

/** 위젯 키(ops-svc WIDGET_KEYS와 같은 이름) */
export const PG_STATUS_KEY = 'purchase-pg-status.summary';

export interface PgRow {
  pg: string;
  limitRatio: number | null;
  circuitOpen: boolean | null;
  inflight: number | null;
  saturatedPerMin: number | null;
}

export interface PgStatusValue {
  widgetKey: string;
  source: 'prometheus';
  at: string;
  eventId: string | null;
  pgs?: readonly PgRow[];
  error?: 'source-unavailable';
}

/** 화면 글자(PgStatusWidget의 data와 같은 모양) */
export interface PgStatusText {
  primary: { name: string; approval: string; callP99: string; confirmP99: string; limitUse: string; overLimit: string; state: { text: string; warning?: boolean } };
  fallback: { name: string; status: string };
}

const DASH = '—';
/** 지표 라벨 → 화면 이름 */
const PG_NAMES: Record<string, string> = { toss: '토스페이먼츠', tosspayments: '토스페이먼츠', portone: '포트원' };
const nameOf = (pg: string) => PG_NAMES[pg.toLowerCase()] ?? pg;

export function isUnavailable(v: { error?: string } | null | undefined): boolean {
  return !v || v.error === 'source-unavailable';
}

function stateOf(r: PgRow): { text: string; warning?: boolean } {
  if (r.circuitOpen === true) return { text: '서킷 열림', warning: true };
  if (r.saturatedPerMin !== null && r.saturatedPerMin > 0) return { text: '호출 상한에 막힘', warning: true };
  return { text: '기본' };
}

export function pgStatusTextOf(v: PgStatusValue): PgStatusText {
  // 기본은 지금 승인 호출이 가장 많이 도는 결제사(같으면 이름 차례). 결제사 배정 원천을 위젯 값에 싣는 것은 원천 기능 몫이다
  const rows = [...(v.pgs ?? [])].sort((a, b) => (b.inflight ?? -1) - (a.inflight ?? -1) || (a.pg < b.pg ? -1 : a.pg > b.pg ? 1 : 0));
  const primary = rows[0];
  const fallback = rows[1];
  return {
    primary: primary
      ? {
          name: `${nameOf(primary.pg)}(기본)`,
          approval: DASH,
          callP99: DASH,
          confirmP99: DASH,
          limitUse: primary.limitRatio === null ? DASH : `${Math.round(primary.limitRatio)}%`,
          overLimit: primary.saturatedPerMin === null ? DASH : `분당 ${Math.round(primary.saturatedPerMin).toLocaleString('ko-KR')}건`,
          state: stateOf(primary),
        }
      : { name: '결제사 지표 없음', approval: DASH, callP99: DASH, confirmP99: DASH, limitUse: DASH, overLimit: DASH, state: { text: DASH } },
    fallback: fallback
      ? { name: `${nameOf(fallback.pg)}(대체)`, status: fallback.circuitOpen === true ? '서킷 열림' : `대기 · 진행 중 호출 ${fallback.inflight === null ? DASH : Math.round(fallback.inflight)}건` }
      : { name: '대체 결제사', status: '지표 없음' },
  };
}

/** 'n초 전'(5초 넘으면 경고, frontend §3.10) */
export function freshnessOf(atIso: string, nowMs: number): { text: string; stale: boolean } {
  const s = Math.max(0, Math.round((nowMs - Date.parse(atIso)) / 1000));
  return { text: `${s}초 전`, stale: s > 5 };
}
