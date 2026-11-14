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
