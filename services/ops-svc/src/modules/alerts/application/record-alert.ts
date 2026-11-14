// 운영 경보 기록 쓰임새(BAT-425 GAT-130). 같은 eventKey·kind는 한 건으로 모은다.
import { randomUUID } from 'node:crypto';
import type { OpsAlert, OpsAlertSeverity, OpsAlertStore } from '../domain/ops-alert.js';

export interface OpsAlertInput {
  readonly eventKey: string;
  readonly kind: string;
  readonly severity: OpsAlertSeverity;
  readonly source: string;
  readonly reason: string;
  readonly detail?: Record<string, unknown>;
  readonly createdAt?: string;
}

export class RecordOpsAlert {
  constructor(
    private readonly store: OpsAlertStore,
    private readonly nowMs: () => number,
  ) {}

  async handle(i: OpsAlertInput): Promise<OpsAlert> {
    return this.store.open({
      alertId: randomUUID(),
      eventKey: i.eventKey,
      kind: i.kind,
      severity: i.severity,
      source: i.source,
      reason: i.reason,
      detail: i.detail ?? {},
      nowMs: i.createdAt !== undefined ? Date.parse(i.createdAt) : this.nowMs(),
    });
  }

  /** 열린 경보를 푼다(O-T20 신선도 회복). 없는 경보는 undefined다 */
  async resolve(i: { eventKey: string; kind: string; reason: string; resolvedAt?: string }): Promise<OpsAlert | undefined> {
    return this.store.resolve({
      eventKey: i.eventKey,
      kind: i.kind,
      reason: i.reason,
      nowMs: i.resolvedAt !== undefined ? Date.parse(i.resolvedAt) : this.nowMs(),
    });
  }
}
