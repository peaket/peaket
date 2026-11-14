// 운영 경보의 메모리 저장소(단위 시험).
import type { OpsAlert, OpsAlertStore } from '../domain/ops-alert.js';

export class MemoryOpsAlertStore implements OpsAlertStore {
  readonly alerts: OpsAlert[] = [];

  async open(input: Parameters<OpsAlertStore['open']>[0]): Promise<OpsAlert> {
    const existing = this.alerts.find((a) => a.eventKey === input.eventKey && a.kind === input.kind);
    if (existing) {
      // 열려 있으면 첫 경보를 그대로 둔다(멱등). 풀렸던 경보가 다시 나빠지면 다시 연다(이력은 한 행에 남긴다)
      if (existing.resolvedAtMs === undefined) return existing;
      const next: OpsAlert = {
        alertId: existing.alertId,
        eventKey: existing.eventKey,
        kind: existing.kind,
        severity: input.severity,
        source: input.source,
        reason: input.reason,
        detail: input.detail,
        createdAtMs: input.nowMs,
      };
      this.alerts[this.alerts.indexOf(existing)] = next;
      return next;
    }
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

  async resolve(input: Parameters<OpsAlertStore['resolve']>[0]): Promise<OpsAlert | undefined> {
    const existing = this.alerts.find((a) => a.eventKey === input.eventKey && a.kind === input.kind);
    if (!existing) return undefined;
    if (existing.resolvedAtMs !== undefined) return existing;
    const next: OpsAlert = { ...existing, resolvedAtMs: input.nowMs, resolvedReason: input.reason };
    this.alerts[this.alerts.indexOf(existing)] = next;
    return next;
  }
}
