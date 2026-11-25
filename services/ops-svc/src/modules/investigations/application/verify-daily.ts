// F-04-12 하루 검증. 열린 사건이 있는 회차의 마지막 기록 고정 판만 다시 계산해 견준다.
// 불일치면 SEV2·내보내기 차단 상태(verify_status=MISMATCH)를 남긴다(docs/features/forensic-replay.md §6.7.2).
import type { FraudAlerts, FraudOpsEventSink, InvestigationStore, SnapshotVerifier } from '../domain/ports.js';

export class VerifyDailySnapshots {
  constructor(
    private readonly d: {
      store: InvestigationStore;
      verifier: SnapshotVerifier;
      alerts: FraudAlerts;
      events: FraudOpsEventSink;
      now: () => number;
    },
  ) {}

  async runOnce(): Promise<{ checked: number; mismatched: number }> {
    const events = await this.d.store.openCaseEvents();
    let checked = 0;
    let mismatched = 0;
    const nowMs = this.d.now();
    for (const eventId of events) {
      const snapshot = await this.d.store.latestSnapshot(eventId);
      if (!snapshot) continue;
      let result: { ok: boolean; mismatchedTables: string[] };
      try {
        result = await this.d.verifier.verify(snapshot);
      } catch {
        // 검증기를 쓸 수 없으면 판정하지 않는다(통과로 세지 않는다)
        continue;
      }
      checked += 1;
      if (result.ok) {
        await this.d.store.verifySnapshot(eventId, snapshot.version, 'OK', nowMs);
        this.d.events.emit({ opsEvent: 'FRAUD_SNAPSHOT', stage: 'VERIFIED', eventId, generation: snapshot.version, result: 'OK' });
        continue;
      }
      mismatched += 1;
      await this.d.store.verifySnapshot(eventId, snapshot.version, 'MISMATCH', nowMs);
      await this.d.alerts.raise({ eventId, version: snapshot.version, severity: 'SEV2', kind: 'FRAUD_SNAPSHOT_MISMATCH' });
      this.d.events.emit({ opsEvent: 'FRAUD_SNAPSHOT', stage: 'VERIFY_FAILED', eventId, generation: snapshot.version, result: 'MISMATCH' });
    }
    return { checked, mismatched };
  }
}
