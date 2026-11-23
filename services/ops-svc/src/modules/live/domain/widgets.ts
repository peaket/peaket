// 관제 위젯 키와 값 모양(openapi /v1/ops/widgets/{widgetKey}·/v1/ops/events/{eventId}/live, docs/frontend.md §4.4.5·§4.6, ADR-0360 결정 9).
// 키 이름은 '위젯이름.대상'이다. 원천이 지금 있는 둘만 실제 값으로 잇고(대기열 팀 입장 비율, 구매 팀 결제사), 나머지 위젯은 원천 기능이 키를 더한다.
// 값은 숫자·상태만 싣고 화면 글자는 위젯이 만든다. 원천을 못 읽으면 같은 키에 error 'source-unavailable'을 싣는다(200).
import { z } from 'zod';

export const WIDGET_KEYS = ['queue-admission-rate.summary', 'purchase-pg-status.summary', 'rt-sales.summary'] as const;
export type WidgetKey = (typeof WIDGET_KEYS)[number];

/** 키마다 값의 원천(openapi OpsWidgetValue.source). rt-sales.summary는 관제 실시간 표(ClickHouse rt 뷰, F-04-1) */
export const WIDGET_SOURCE_OF = {
  'queue-admission-rate.summary': 'prometheus',
  'purchase-pg-status.summary': 'prometheus',
  'rt-sales.summary': 'clickhouse',
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

export const WidgetValue = z.union([QueueAdmissionRateSummary, PurchasePgStatusSummary, RtSalesSummary, WidgetUnavailable]);
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
