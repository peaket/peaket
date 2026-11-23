// 관제 위젯 키와 값 모양(openapi /v1/ops/widgets/{widgetKey}·/v1/ops/events/{eventId}/live, docs/frontend.md §4.4.5·§4.6, ADR-0360 결정 9).
// 키 이름은 '위젯이름.대상'이다. 원격 위젯 둘(대기열 팀 입장 비율, 구매 팀 결제사), 관제 실시간 표(rt-sales.summary, F-04-1)와 호스트 판단 위젯 넷(F-03-3)을 실제 값으로 잇고, 나머지 위젯은 원천 기능이 키를 더한다.
// 값은 숫자·상태만 싣고 화면 글자는 위젯이 만든다. 원천을 못 읽으면 같은 키에 error 'source-unavailable'을 싣는다(200).
import { z } from 'zod';

export const WIDGET_KEYS = [
  'queue-admission-rate.summary',
  'purchase-pg-status.summary',
  'rt-sales.summary',
  // 관제 판단 위젯 넷(F-03-3 OPS-380, ADR-0371 결정 8): T-30분 점검 실시간 항목, 여정별 남은 허용 실패, 포화도 요약, 진단 힌트
  'ops-readiness.checklist',
  'ops-budget.journeys',
  'ops-saturation.summary',
  'ops-diagnostics.summary',
] as const;
export type WidgetKey = (typeof WIDGET_KEYS)[number];

/** 키마다 값의 원천(openapi OpsWidgetValue.source). rt-sales.summary는 관제 실시간 표(ClickHouse rt 뷰, F-04-1) */
export const WIDGET_SOURCE_OF = {
  'queue-admission-rate.summary': 'prometheus',
  'purchase-pg-status.summary': 'prometheus',
  'rt-sales.summary': 'clickhouse',
  'ops-readiness.checklist': 'prometheus',
  'ops-budget.journeys': 'prometheus',
  'ops-saturation.summary': 'prometheus',
  'ops-diagnostics.summary': 'prometheus',
} as const satisfies Record<WidgetKey, 'prometheus' | 'clickhouse'>;

/** 그래프 창 15분 [가정](frontend §3.10 '들고 있는 양의 상한') */
export const WIDGET_RANGE_MS = 15 * 60_000;
/** 위젯 조회 창 상한 1시간 [가정](알림 표 보관과 같은 길이) */
export const WIDGET_MAX_RANGE_MS = 3_600_000;
/** 위젯 흐름이 값을 다시 계산하는 주기 1초 [가정](frontend §3.10 '1초 점') */
export const WIDGET_TICK_MS = 1_000;
/** 위젯 흐름 한 번에 받는 키 수 상한(보이는 위젯 아홉 + 여유) */
export const WIDGET_KEYS_PER_STREAM = 16;

export function isWidgetKey(v: string): v is WidgetKey {
  return (WIDGET_KEYS as readonly string[]).includes(v);
}

const nullableNumber = z.number().nullable();

/** 원천을 못 읽은 값(두 키 같은 모양) */
export const WidgetUnavailable = z.object({
  widgetKey: z.enum(WIDGET_KEYS),
  source: z.enum(['prometheus', 'clickhouse']),
  at: z.string(),
  eventId: z.string().nullable(),
  error: z.literal('source-unavailable'),
});

/** 대기열 팀 '입장 비율·빈자리'(admission-ctrl 지표 admission_ratio·admission_target·admission_slots_used·admission_in_flight·admission_soon_waiting) */
export const QueueAdmissionRateSummary = z.object({
  widgetKey: z.literal('queue-admission-rate.summary'),
  source: z.literal('prometheus'),
  at: z.string(),
  eventId: z.string().nullable(),
  ratio: nullableNumber,
  target: nullableNumber,
  slotsUsed: nullableNumber,
  inFlight: nullableNumber,
  soonWaiting: nullableNumber,
  /** 위젯 조회(REST)만 싣는다: 최근 창의 입장 비율 점 */
  series: z.array(z.object({ at: z.string(), ratio: z.number() })).optional(),
});

/** 구매 팀 '결제사'(payment-svc 지표 payment_pg_limit_ratio·payment_pg_circuit_open·payment_pg_inflight·payment_pg_saturated_total). 결제사 지표는 회차 라벨이 없어 회차와 무관하다 */
export const PurchasePgStatusSummary = z.object({
  widgetKey: z.literal('purchase-pg-status.summary'),
  source: z.literal('prometheus'),
  at: z.string(),
  eventId: z.string().nullable(),
  pgs: z.array(
    z.object({
      pg: z.string(),
      limitRatio: nullableNumber,
      circuitOpen: z.boolean().nullable(),
      inflight: nullableNumber,
      saturatedPerMin: nullableNumber,
    }),
  ),
  /** 위젯 조회(REST)만 싣는다: 최근 창의 결제사별 한도 사용률 점 */
  series: z.array(z.object({ at: z.string(), pg: z.string(), limitRatio: z.number() })).optional(),
});

/** 관제 실시간 표 '판매 누적·구역별 잔여석'(F-04-1, docs/streaming.md §4.1·§4.5). 실시간 잠정값이다 */
export const RtSalesSummary = z.object({
  widgetKey: z.literal('rt-sales.summary'),
  source: z.literal('clickhouse'),
  at: z.string(),
  eventId: z.string().nullable(),
  sold: z.number().int(),
  remaining: z.number().int().nullable(),
  salesAmount: z.number().int(),
  ordersConfirmed: z.number().int(),
  ticketsIssued: z.number().int(),
  waiting: z.number().int(),
  queueEntries: z.number().int(),
  sections: z.array(z.object({ sectionId: z.string(), sold: z.number().int(), remaining: z.number().int().nullable() })),
  freshnessSeconds: z.number(),
  degraded: z.boolean(),
  tradeGap: z.boolean(),
});

const ReadinessItemValue = z.object({
  key: z.string(),
  group: z.enum(['required', 'recommended', 'display']),
  status: z.enum(['pass', 'fail', 'unknown', 'not-in-env', 'deferred', 'display-only']),
  value: z.number().optional(),
  unit: z.string().optional(),
  at: z.string().optional(),
  reason: z.string().optional(),
});

/** T-30분 점검 탭의 실시간 항목(readiness 컨텍스트의 점검 계산, GET /v1/ops/events/{eventId}/readiness의 items·preview와 같다) */
export const OpsReadinessChecklist = z.object({
  widgetKey: z.literal('ops-readiness.checklist'),
  source: z.literal('prometheus'),
  at: z.string(),
  eventId: z.string().nullable(),
  items: z.array(ReadinessItemValue),
  preview: z.object({ verdict: z.enum(['go', 'no-go']), failedRequired: z.array(z.string()), failedRecommended: z.array(z.string()) }),
});

/** 여정 일곱(asyncapi OpsAlert.journey)과 동시 입장 목표에 묶인 네 여정(control-tower §6의 3, ADR-0126) */
export const BUDGET_JOURNEYS = ['detail', 'queue_entry', 'queue_state', 'hold', 'seat_status', 'payment_accept', 'payment_confirm'] as const;
export const LINKED_JOURNEYS: readonly (typeof BUDGET_JOURNEYS)[number][] = ['hold', 'seat_status', 'payment_accept', 'payment_confirm'];

/** 여정별 남은 허용 실패(기록 규칙 peaket:slo:onsale_*{event_id,journey}, docs/observability.md §8). 시계열이 없는 여정은 null과 까닭 */
export const OpsBudgetJourneys = z.object({
  widgetKey: z.literal('ops-budget.journeys'),
  source: z.literal('prometheus'),
  at: z.string(),
  eventId: z.string().nullable(),
  journeys: z.array(
    z.object({
      journey: z.enum(BUDGET_JOURNEYS),
      linked: z.boolean(),
      allowed: nullableNumber,
      used: nullableNumber,
      remaining: nullableNumber,
      burnShort: nullableNumber.optional(),
      burnLong: nullableNumber.optional(),
      reason: z.string().optional(),
    }),
  ),
});

export const SATURATION_LEVELS = ['ok', 'warn', 'danger', 'unknown'] as const;
const SaturationField = z.object({ value: nullableNumber, level: z.enum(SATURATION_LEVELS) });

/** 포화도 요약(CPU·Redis 메모리 비율·Kafka 밀림·이벤트 루프 p99). 요약 level은 가장 나쁜 칸, 값이 없는 칸이 있으면 ok가 아니다 */
export const OpsSaturationSummary = z.object({
  widgetKey: z.literal('ops-saturation.summary'),
  source: z.literal('prometheus'),
  at: z.string(),
  eventId: z.string().nullable(),
  level: z.enum(SATURATION_LEVELS),
  cpu: SaturationField,
  redisMemory: SaturationField,
  kafkaLag: SaturationField,
  eventLoop: SaturationField,
});

/** 진단 힌트(RUM·느린 쿼리·네트워크, 운영 명령 없음). 원천이 아직 없어 지금은 늘 원천 실패 값이다 */
export const OpsDiagnosticsSummary = z.object({
  widgetKey: z.literal('ops-diagnostics.summary'),
  source: z.literal('prometheus'),
  at: z.string(),
  eventId: z.string().nullable(),
  rumInpP75Ms: nullableNumber,
  rumLcpP75Ms: nullableNumber,
  slowQueries: z.array(z.object({ queryId: z.string(), db: z.string(), calls: z.number(), meanMs: z.number(), maxMs: z.number() })),
  network: z.enum(['ok', 'warn', 'unknown']),
});

export const WidgetValue = z.union([
  QueueAdmissionRateSummary,
  PurchasePgStatusSummary,
  RtSalesSummary,
  OpsReadinessChecklist,
  OpsBudgetJourneys,
  OpsSaturationSummary,
  OpsDiagnosticsSummary,
  WidgetUnavailable,
]);
export type WidgetValue = z.output<typeof WidgetValue>;

/** 쉼표로 이은 위젯 키 목록을 읽는다. 비었거나 모르는 키가 있으면 그 키 목록을 돌려준다(422) */
export function parseWidgetList(raw: string | undefined): { ok: true; keys: WidgetKey[] } | { ok: false; unknown: string[] } {
  const items = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0 || items.length > WIDGET_KEYS_PER_STREAM) return { ok: false, unknown: items.length === 0 ? [''] : items.slice(WIDGET_KEYS_PER_STREAM) };
  const unknown = items.filter((k) => !isWidgetKey(k));
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, keys: [...new Set(items)] as WidgetKey[] };
}
