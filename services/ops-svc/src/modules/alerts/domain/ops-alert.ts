// 운영 경보 기록 계약(BAT-425 GAT-130, docs/features/control-tower.md §13).
// purchase-svc의 회차 취소 환불 자동 정지·신청 창 닫힘을 ops-svc가 받아 남긴다. 콘솔 SSE 연결은 후속이다.
export const OPS_ALERT_SEVERITIES = ['SEV1', 'SEV2', 'SEV3'] as const;
export type OpsAlertSeverity = (typeof OPS_ALERT_SEVERITIES)[number];

export interface OpsAlert {
  readonly alertId: string;
  readonly eventKey: string;
  readonly kind: string;
  readonly severity: OpsAlertSeverity;
  readonly source: string;
  readonly reason: string;
  readonly detail: Record<string, unknown>;
  readonly createdAtMs: number;
  /** 풀린 시각. 없으면 열려 있다 */
  readonly resolvedAtMs?: number;
  readonly resolvedReason?: string;
}

export interface OpsAlertStore {
  /** 같은 (eventKey, kind)의 경보는 한 건으로 모은다(멱등). 풀렸던 경보가 다시 나빠지면 다시 연다 */
  open(input: { alertId: string; eventKey: string; kind: string; severity: OpsAlertSeverity; source: string; reason: string; detail: Record<string, unknown>; nowMs: number }): Promise<OpsAlert>;
  /** 열린 경보를 푼다. 없으면 undefined. 이미 풀렸으면 그대로 둔다 */
  resolve(input: { eventKey: string; kind: string; reason: string; nowMs: number }): Promise<OpsAlert | undefined>;
}

/**
 * 경보 목록 읽기(F-03-3 OPS-380, 관제 경보 목록 REST·늘 여는 흐름 reset 뒤 다시 읽기, ADR-0371 결정 9). 쓰기·멱등 규칙은 OpsAlertStore 그대로다.
 * 걸린 경보는 언제 열렸든 모두, 풀린 경보는 resolvedSinceMs 이후에 풀린 것만, eventKey를 주면 그 키만 돌려준다.
 * 차례는 걸린 경보 먼저(최근에 열린 것부터), 그다음 최근에 풀린 것부터이고 limit을 넘지 않는다(넘치면 오래 전에 풀린 것부터 빠진다)
 */
export interface OpsAlertList {
  list(q: { eventKey?: string; resolvedSinceMs: number; limit: number }): Promise<readonly OpsAlert[]>;
}

/** 목록 차례: 걸린 경보(최근에 열린 것부터) → 풀린 경보(최근에 풀린 것부터) */
export function compareAlertsForList(a: OpsAlert, b: OpsAlert): number {
  const af = a.resolvedAtMs === undefined;
  const bf = b.resolvedAtMs === undefined;
  if (af !== bf) return af ? -1 : 1;
  if (af) return b.createdAtMs - a.createdAtMs;
  return b.resolvedAtMs! - a.resolvedAtMs!;
}
