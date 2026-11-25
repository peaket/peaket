// F-04-12 후보 계산 실행기. 시도마다 fraud_cluster_run 행을 남기고, 실패하면 같은 판의 다음 시도(AUTO_RETRY)를 돈다.
// 네 번째 실패(처음 1 + 자동 3)에 SEV3를 낸다(docs/features/forensic-replay.md §6.7.3, §1.3 4).
import { autoRetriesLeftOf, classifyRunFailure, type FraudRunRecord, type FraudRunTrigger } from '../domain/investigation.js';
import type { FraudAlerts, FraudForensicsRunner, FraudOpsEventSink, InvestigationStore } from '../domain/ports.js';

export class FraudClusterRunService {
  constructor(
    private readonly d: {
      store: InvestigationStore;
      runner: FraudForensicsRunner;
      events: FraudOpsEventSink;
      alerts: FraudAlerts;
      now: () => number;
    },
  ) {}

  async runOnce(i: {
    eventId: string;
    generation: number;
    snapshotVersion: number;
    ruleVersion: string;
    trigger: FraudRunTrigger;
    startAttempt?: number;
  }): Promise<{ status: 'DONE' | 'FAILED'; attempts: number }> {
    let attempt = i.startAttempt ?? 1;
    let trigger = i.trigger;
    let consumed = 0;
    for (;;) {
      consumed += 1;
      const startedAtMs = this.d.now();
      const result = await this.d.runner.run({
        eventId: i.eventId,
        generation: i.generation,
        attempt,
        snapshotVersion: i.snapshotVersion,
        ruleVersion: i.ruleVersion,
      });
      const finishedAtMs = this.d.now();
      if (result.ok) {
        const run: FraudRunRecord = {
          eventId: i.eventId,
          generation: i.generation,
          attempt,
          trigger,
          snapshotVersion: i.snapshotVersion,
          ruleVersion: i.ruleVersion,
          status: 'DONE',
          failureReason: null,
          resultFingerprint: result.resultFingerprint,
          clusterCount: result.clusterCount,
          startedAtMs,
          finishedAtMs,
        };
        await this.d.store.putRun(run);
        this.d.events.emit({
          opsEvent: 'FRAUD_CLUSTER_RUN',
          stage: 'DONE',
          eventId: i.eventId,
          generation: i.generation,
          attempt,
          trigger,
          result: 'DONE',
          clusterCount: result.clusterCount,
        });
        return { status: 'DONE', attempts: consumed };
      }
      const run: FraudRunRecord = {
        eventId: i.eventId,
        generation: i.generation,
        attempt,
        trigger,
        snapshotVersion: i.snapshotVersion,
        ruleVersion: i.ruleVersion,
        status: 'FAILED',
        failureReason: classifyRunFailure(result.error),
        resultFingerprint: null,
        clusterCount: null,
        startedAtMs,
        finishedAtMs,
      };
      await this.d.store.putRun(run);
      this.d.events.emit({
        opsEvent: 'FRAUD_CLUSTER_RUN',
        stage: 'FAILED',
        eventId: i.eventId,
        generation: i.generation,
        attempt,
        trigger,
        result: 'FAILED',
      });
      if (autoRetriesLeftOf(run) === 0) {
        await this.d.alerts.raise({
          eventId: i.eventId,
          version: i.generation,
          severity: 'SEV3',
          kind: 'FRAUD_CLUSTER_RUN_FAILED',
        });
        return { status: 'FAILED', attempts: consumed };
      }
      attempt += 1;
      trigger = 'AUTO_RETRY';
    }
  }
}
