// F-04-12 외부 포트의 로컬 구현. 발송·라벨·경보의 실제 어댑터는 F-04-13·F-04-19가 붙인다.
import type { FraudAlerts, FraudLabels, FraudNotifier, FraudOpsEventSink, InvestigationAccessLog, SnapshotVerifier, FraudForensicsRunner } from '../domain/ports.js';

const line = (kind: string, fields: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ level: 'info', service: 'ops-svc', kind, ...fields })}\n`);
};

export class LoggingFraudNotifier implements FraudNotifier {
  async holderNotice(i: { eventId: string; caseId: string; accountId: string; ticketIds: readonly string[]; dueAtMs: number }): Promise<void> {
    line('fraud_holder_notice', { eventId: i.eventId, caseId: i.caseId, accountId: i.accountId, ticketCount: i.ticketIds.length, dueAt: new Date(i.dueAtMs).toISOString() });
  }
}

export class LoggingFraudLabels implements FraudLabels {
  async apply(i: { eventId: string; caseId: string; accountIds: readonly string[]; label: 'HUMAN' | 'BOT' }): Promise<void> {
    line('fraud_label', { eventId: i.eventId, caseId: i.caseId, accountCount: i.accountIds.length, label: i.label });
  }
}

export class LoggingFraudAlerts implements FraudAlerts {
  async raise(i: { eventId: string; version: number; severity: 'SEV2' | 'SEV3'; kind: string }): Promise<void> {
    line('fraud_alert', { eventId: i.eventId, version: i.version, severity: i.severity, alertKind: i.kind });
  }
}

export class LoggingInvestigationAccess implements InvestigationAccessLog {
  async record(i: Record<string, unknown>): Promise<void> {
    line('invAccess', i);
  }
}

export class LoggingFraudOpsEvent implements FraudOpsEventSink {
  emit(i: Parameters<FraudOpsEventSink['emit']>[0]): void {
    line('ops_event', { opsEvent: i.opsEvent, stage: i.stage, eventId: i.eventId, generation: i.generation, attempt: i.attempt, trigger: i.trigger, result: i.result, clusterCount: i.clusterCount });
  }
}

/** F-04-12에서는 실제 기록 재계산기를 붙이지 않았다. 하루 검증은 이 경우 판정하지 않는다. */
export class UnavailableSnapshotVerifier implements SnapshotVerifier {
  async verify(): Promise<never> {
    throw new Error('기록 검증기(inv-forensics)가 조립되지 않았다');
  }
}

export class UnavailableFraudForensicsRunner implements FraudForensicsRunner {
  async run(): Promise<never> {
    throw new Error('후보 계산 실행기(inv-forensics)가 조립되지 않았다');
  }
}
