// 위젯 값(openapi OpsWidgetQueueAdmissionRateSummary)을 '입장 비율·빈자리' 위젯의 화면 글자로 바꾼다(ADR-0360 결정 9).
// 값은 ops-svc 위젯 조회·위젯 흐름이 주는 숫자이고, 화면 글자(퍼센트·자리·명)는 위젯 팀이 정한다. 모르는 칸은 '—'다.
// 가져오는 것이 없는 순수 모듈이라 Node 내장 시험 실행기로 그대로 읽는다.

/** 위젯 키(ops-svc WIDGET_KEYS와 같은 이름) */
export const ADMISSION_RATE_KEY = 'queue-admission-rate.summary';

export interface AdmissionRateValue {
  widgetKey: string;
  source: 'prometheus';
  at: string;
  eventId: string | null;
  ratio?: number | null;
  target?: number | null;
  slotsUsed?: number | null;
  inFlight?: number | null;
  soonWaiting?: number | null;
  error?: 'source-unavailable';
}

/** 화면 글자(AdmissionRateWidget의 data와 같은 모양) */
export interface AdmissionRateText {
  rate: string;
  vacancy: { value: string; meta: string };
  coming: string;
  soon: string;
  soonP99: string;
  formula: string;
}

const DASH = '—';
const n = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: number) => Math.round(v).toLocaleString('ko-KR');

/** 원천을 못 읽은 값인가 */
export function isUnavailable(v: { error?: string } | null | undefined): boolean {
  return !v || v.error === 'source-unavailable';
}

export function admissionRateTextOf(v: AdmissionRateValue): AdmissionRateText {
  const rate = n(v.ratio) ? `${Math.round(v.ratio * 100)}%` : DASH;
  const vacancy = n(v.target) && n(v.slotsUsed) ? Math.max(0, v.target - v.slotsUsed) : null;
  return {
    rate,
    vacancy: {
      value: vacancy === null ? DASH : `${count(vacancy)}자리`,
      meta: n(v.target) && n(v.slotsUsed) ? `동시 입장 목표 ${count(v.target)}명 − 예매 단계 인원 ${count(v.slotsUsed)}명` : '동시 입장 목표·예매 단계 인원을 받지 못했습니다',
    },
    coming: n(v.inFlight) ? `${count(v.inFlight)}명` : DASH,
    soon: n(v.soonWaiting) ? `${count(v.soonWaiting)}명` : DASH,
    // 곧 입장 대기 p99 지표는 아직 원천이 없다(control-tower §13 위젯 원천 표)
    soonP99: DASH,
    formula:
      vacancy !== null && n(v.soonWaiting) && n(v.inFlight) && n(v.ratio) && v.ratio > 0
        ? `자동 제어가 보는 값과 같습니다(잠정 아님). serving 증가 = (빈자리 ${count(vacancy)} − 곧 입장 대기 ${count(v.soonWaiting)} − 오는 중 ${count(v.inFlight)}) ÷ 입장 비율 ${v.ratio.toFixed(2)} ≈ ${count(Math.max(0, (vacancy - v.soonWaiting - v.inFlight) / v.ratio))}`
        : '자동 제어가 보는 값과 같습니다(잠정 아님).',
  };
}

/** 'n초 전'(5초 넘으면 경고, frontend §3.10) */
export function freshnessOf(atIso: string, nowMs: number): { text: string; stale: boolean } {
  const s = Math.max(0, Math.round((nowMs - Date.parse(atIso)) / 1000));
  return { text: `${s}초 전`, stale: s > 5 };
}
