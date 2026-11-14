// 운영 경보의 메모리 저장소(단위 시험).
import type { OpsAlert, OpsAlertStore } from '../domain/ops-alert.js';

export class MemoryOpsAlertStore implements OpsAlertStore {
  readonly alerts: OpsAlert[] = [];

  async open(input: Parameters<OpsAlertStore['open']>[0]): Promise<OpsAlert> {
    const existing = this.alerts.find((a) => a.eventKey === input.eventKey && a.kind === input.kind);
    if (existing) return existing;
    const alert: OpsAlert = {
      alertId: input.alertId,
      eventKey: input.eventKey,
      kind: input.kind,
      severity: input.severity,
      source: input.source,
      reason: input.reason,
      detail: input.detail,
      createdAtMs: input.nowMs,
    };
    this.alerts.push(alert);
    return alert;
  }
}
