// 회차 단계와 T-30분 점검·Go/No-Go 판정 규칙(F-03-3 OPS-380, ADR-0371 결정 1~5).
// 정본: docs/features/control-tower.md §2('T-30분 점검'·'T=0 집중(최초 10분)'·'판매 진행 중'·'온세일 종료 후'·'공연 당일 입장' 단계, Go/No-Go 판정 문단),
// docs/design/d5-screen-blueprint.md §7.2(체크리스트 '필수 13 · 권고 2', '대상 없음'). 여기 상수는 그 값을 코드에 둔 자리다(시험은 정본에서 값을 가져온다).

/** T-30분 점검이 시작되는 때: 판매 시작 30분 전(control-tower §2) */
export const READINESS_CHECK_FROM_MS = 30 * 60_000;
/** T=0 집중 단계의 길이: 판매 시작부터 10분(control-tower §2 'T=0 집중(최초 10분)') */
export const T0_FOCUS_MS = 10 * 60_000;
/** 판정 창의 끝: 판매 시작 20분 전('T-20분까지 실패 항목이 회복되면 다시 판정해 Go로 바꿀 수 있다', ADR-0371 결정 4) */
export const JUDGE_UNTIL_BEFORE_MS = 20 * 60_000;

export const STAGES = ['t30', 't0', 'live', 'after', 'entry', 'none'] as const;
export type Stage = (typeof STAGES)[number];

/** core-svc 판매 설정에서 읽은 회차 일정(밀리초) */
export interface SaleSchedule {
  readonly opensAtMs: number;
  readonly saleEndsAtMs: number;
  readonly entryOpensAtMs: number | null;
  readonly entryClosedAtMs: number | null;
}

/**
 * 지금 단계. 입장 창(entryOpensAt 이상·entryClosedAt 미만)이 먼저이고, 그 밖은 판매 시각으로 정한다.
 * 판매 시작 30분 전보다 앞이거나 입장이 끝난 뒤는 활성 회차가 아니다(none, d5 §7.2 '대상 없음').
 */
export function stageOf(s: SaleSchedule, nowMs: number): Stage {
  if (s.entryOpensAtMs !== null && nowMs >= s.entryOpensAtMs) {
    if (s.entryClosedAtMs === null || nowMs < s.entryClosedAtMs) return 'entry';
    return 'none';
  }
  if (nowMs < s.opensAtMs - READINESS_CHECK_FROM_MS) return 'none';
  if (nowMs < s.opensAtMs) return 't30';
  if (nowMs < s.opensAtMs + T0_FOCUS_MS) return 't0';
  if (nowMs < s.saleEndsAtMs) return 'live';
  return 'after';
}

/** 판정 창 [판매 시작 − 30분, 판매 시작 − 20분](두 끝 포함) */
export function judgementWindowOf(s: SaleSchedule): { fromMs: number; untilMs: number } {
  return { fromMs: s.opensAtMs - READINESS_CHECK_FROM_MS, untilMs: s.opensAtMs - JUDGE_UNTIL_BEFORE_MS };
}

export const ITEM_GROUPS = ['required', 'recommended', 'display'] as const;
export type ItemGroup = (typeof ITEM_GROUPS)[number];
export const ITEM_STATUSES = ['pass', 'fail', 'unknown', 'not-in-env', 'deferred', 'display-only'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** 점검 항목 하나의 결과(openapi OpsReadinessItem) */
export interface ReadinessItem {
  readonly key: string;
  readonly group: ItemGroup;
  readonly status: ItemStatus;
  readonly value?: number;
  readonly unit?: string;
  readonly at?: string;
  /** 확인할 수 없음의 까닭: source-unavailable(원천을 못 읽음)·source-not-built(원천 기능 전)·no-sample(빈 결과·NaN·5분 넘게 표본 없음) */
  readonly reason?: string;
}

/**
 * 점검 항목 목록(control-tower §2 T-30분 점검 칸, d5 §7.2 체크리스트의 차례). 원천의 종류:
 * - metric: 지표 창고(Prometheus) 고정 쿼리(어댑터 prometheus-readiness-probe.ts가 쿼리를 가진다)
 * - cloud: 원천이 클라우드에만 있다. local·ci·demo는 '이 환경에 없음'(판정에서 뺀다), 그 밖은 기록 규칙 peaket:readiness:<이름>(1 통과·0 실패)
 * - rule: 원천 기능이 기록 규칙 peaket:readiness:<이름>을 내면 그 값(그 전에는 확인할 수 없음)
 * - display: 표시만(판정에 들지 않는다)
 */
export type ItemSource = 'metric' | 'cloud' | 'rule' | 'display';
export interface ItemDefinition {
  readonly key: string;
  readonly group: ItemGroup;
  readonly source: ItemSource;
}

export const READINESS_ITEMS: readonly ItemDefinition[] = [
  { key: 'prewarm', group: 'required', source: 'cloud' },
  { key: 'datastores', group: 'required', source: 'metric' },
  { key: 'payment-provider', group: 'required', source: 'metric' },
  { key: 'identity-providers', group: 'required', source: 'rule' },
  { key: 'cdn-limits', group: 'required', source: 'cloud' },
  { key: 'synthetic', group: 'required', source: 'metric' },
  { key: 'oncall-test', group: 'required', source: 'rule' },
  { key: 'clock-offset', group: 'required', source: 'metric' },
  { key: 'credentials', group: 'required', source: 'rule' },
  { key: 'cross-region-backup', group: 'required', source: 'cloud' },
  { key: 'deployments', group: 'required', source: 'rule' },
  { key: 'freeze-window', group: 'required', source: 'rule' },
  { key: 'managed-maintenance', group: 'required', source: 'cloud' },
  { key: 'cdn-hit-ratio', group: 'recommended', source: 'cloud' },
  { key: 'demand-forecast', group: 'recommended', source: 'rule' },
  { key: 'pg-assignment', group: 'display', source: 'display' },
];

/** 노드 시계 오프셋 기준 20ms(control-tower §2 '노드 시계가 표준 시각과 어긋난 정도(오프셋) 20ms 이하'). 절댓값으로 본다 */
export const CLOCK_OFFSET_MAX_SECONDS = 0.02;
/** CDN 엣지 캐시 적중률 기준 90% [가정]과 판정 보류 요청 수 1,000건 [가정](control-tower §2 권고, ADR-0062) */
export const CDN_HIT_RATIO_MIN = 0.9;
export const CDN_HIT_MIN_REQUESTS = 1_000;

/** '이 환경에 없음'을 쓰는 환경(저장소의 'local·ci만 닫힌 대역' 규칙에 데모를 더한 것, ADR-0371 결정 3) */
export const NOT_IN_ENV_ENVS = ['local', 'ci', 'demo'] as const;

export interface ReadinessPreview {
  readonly verdict: 'go' | 'no-go';
  readonly failedRequired: string[];
  readonly failedRecommended: string[];
}

/**
 * 지금 판정 미리 보기(ADR-0371 결정 3): 필수 중 fail·unknown은 실패(원천을 못 읽은 필수 항목을 통과로 보지 않는다, control-tower §6의 6 '입력이 없으면 멈춘다'와 같은 뜻),
 * 권고 중 fail은 사유를 받아 계속하는 실패, not-in-env·deferred·display-only는 판정에 들지 않는다. 필수 실패가 하나라도 있으면 No-Go.
 */
export function previewOf(items: readonly ReadinessItem[]): ReadinessPreview {
  const failedRequired = items.filter((i) => i.group === 'required' && (i.status === 'fail' || i.status === 'unknown')).map((i) => i.key);
  const failedRecommended = items.filter((i) => i.group === 'recommended' && i.status === 'fail').map((i) => i.key);
  return { verdict: failedRequired.length > 0 ? 'no-go' : 'go', failedRequired, failedRecommended };
}

/** 기록한 판정 한 건(판정 기록 표 ops_go_no_go_judgement, 마이그레이션 0029) */
export interface GoNoGoJudgement {
  readonly judgementId: string;
  readonly eventId: string;
  readonly verdict: 'go' | 'no-go';
  readonly failedRequired: readonly string[];
  readonly failedRecommended: readonly string[];
  readonly recommendedReasons: Readonly<Record<string, string>>;
  readonly items: readonly ReadinessItem[];
  readonly judgedAtMs: number;
  /** 같은 회차 안에서 1씩 느는 순번 */
  readonly sequence: number;
  /** 판정자의 로그 가명(HMAC 앞 16바이트). 계정 ID는 남기지 않는다 */
  readonly judgedByRef: string;
}

/** 판정 기록 저장소. record는 판정 표 쓰기와 감사 체인 GO_NO_GO_JUDGED를 한 트랜잭션에 남긴다 */
export interface JudgementStore {
  /** 다음 순번을 매겨 기록하고 그 판정을 돌려준다 */
  record(input: Omit<GoNoGoJudgement, 'sequence'>): Promise<GoNoGoJudgement>;
  /** 회차의 마지막 판정(없으면 undefined) */
  last(eventId: string): Promise<GoNoGoJudgement | undefined>;
}

/** 감사 체인 기록 종류(control-tower §7, ADR-0371 결정 5) */
export const GO_NO_GO_JUDGED = 'GO_NO_GO_JUDGED';

/** 감사 체인 payload(판정자 계정 ID 없음, 가명 참조만) */
export function judgementAuditPayload(j: Omit<GoNoGoJudgement, 'sequence'> & { sequence: number }): Record<string, unknown> {
  return {
    eventId: j.eventId,
    verdict: j.verdict,
    failedRequired: [...j.failedRequired],
    failedRecommended: [...j.failedRecommended],
    recommendedReasons: { ...j.recommendedReasons },
    sequence: j.sequence,
    judgedByRef: j.judgedByRef,
  };
}

/** 판매 설정을 읽지 못했다(core-svc 실패·시간 초과·모양 틀림) */
export class ReadinessSourceUnavailable extends Error {
  override readonly name = 'ReadinessSourceUnavailable';
}

/** core-svc 판매 설정 읽기 포트. 없는 회차는 undefined, 읽지 못하면 ReadinessSourceUnavailable */
export interface SaleScheduleSource {
  get(eventId: string): Promise<SaleSchedule | undefined>;
}

/** 점검 항목 원천 포트(지표 창고) */
export interface ReadinessProbe {
  check(nowMs: number): Promise<ReadinessItem[]>;
}
