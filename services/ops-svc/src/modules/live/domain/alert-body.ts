// 경보 기록 한 행 → 화면 경보 본문(asyncapi OpsAlert, openapi OpsAlert, F-03-3 ADR-0371 결정 9).
// 알림 표 트리거(마이그레이션 0029 ops_push_alert_event)와 같은 규칙이다: 두 본문이 같은 경보에서 같은 칸·같은 값이어야 한다(경보 목록 REST와 흐름 alert 사건의 짝).
// 바꾸면 0029 뒤의 새 마이그레이션에서 트리거 함수도 함께 바꾼다.
import type { OpsAlert } from '../../alerts/index.js';

/** 계약 열거의 경보 종류(밖의 내부 종류는 hygiene로 보이고 sourceKind에 남는다) */
export const ALERT_KINDS = ['slo', 'cause', 'invariant', 'control', 'hygiene', 'legal', 'field', 'change', 'security', 'flow'] as const;
/** 여정 일곱(asyncapi OpsAlert.journey) */
export const ALERT_JOURNEYS = ['detail', 'queue_entry', 'queue_state', 'hold', 'seat_status', 'payment_accept', 'payment_confirm'] as const;
/** 경보 기록 detail에서 본문으로 옮기는 글 칸 */
export const ALERT_DETAIL_FIELDS = ['foldedUnder', 'runbookUrl', 'dashboardUrl', 'exploreUrl', 'dependency'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 트리거의 to_char(… AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')와 같은 꼴(밀리초 아래는 버린다) */
const iso = (ms: number): string => new Date(Math.floor(ms)).toISOString();

export function alertBodyOf(a: OpsAlert): Record<string, unknown> {
  const detail = a.detail ?? {};
  const text = (k: string): string | undefined => (typeof detail[k] === 'string' ? (detail[k] as string) : undefined);
  const journey = text('journey');
  const body: Record<string, unknown> = {
    alertId: a.alertId,
    status: a.resolvedAtMs === undefined ? 'firing' : 'resolved',
    startsAt: iso(a.createdAtMs),
    ...(a.resolvedAtMs !== undefined ? { endsAt: iso(a.resolvedAtMs) } : {}),
    severity: a.severity,
    title: a.reason,
    kind: (ALERT_KINDS as readonly string[]).includes(a.kind) ? a.kind : 'hygiene',
    sourceKind: a.kind,
    ...(UUID.test(a.eventKey) ? { eventId: a.eventKey.toLowerCase() } : {}),
    ...(journey !== undefined && (ALERT_JOURNEYS as readonly string[]).includes(journey) ? { journey } : {}),
  };
  for (const k of ALERT_DETAIL_FIELDS) {
    const v = text(k);
    if (v !== undefined) body[k] = v;
  }
  return body;
}
