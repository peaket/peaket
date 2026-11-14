// ops-svc 운영 경보 기록(BAT-425 GAT-130) 단위 시험. 같은 eventKey·kind는 한 건으로 모은다.
import { describe, expect, test } from 'vitest';
import { MemoryOpsAlertStore } from '../src/modules/alerts/adapters/memory-ops-alert-store.js';
import { RecordOpsAlert } from '../src/modules/alerts/application/record-alert.js';

const NOW = Date.parse('2026-11-15T01:00:00.000Z');

describe('GAT-130 운영 경보', () => {
  test('GAT130_같은_eventKey와_kind의_경보는_한_건으로_모은다', async () => {
    const store = new MemoryOpsAlertStore();
    const record = new RecordOpsAlert(store, () => NOW);
    const a = await record.handle({ eventKey: 'event-refund:r1:TOSS:AUTO_FAILURE_RATE', kind: 'AUTO_FAILURE_RATE', severity: 'SEV2', source: 'purchase-svc', reason: 'AUTO_FAILURE_RATE', detail: { calls: 20 } });
    const b = await record.handle({ eventKey: 'event-refund:r1:TOSS:AUTO_FAILURE_RATE', kind: 'AUTO_FAILURE_RATE', severity: 'SEV2', source: 'purchase-svc', reason: 'AUTO_FAILURE_RATE', detail: { calls: 21 } });
    expect(store.alerts).toHaveLength(1);
    expect(b.alertId).toBe(a.alertId);
    expect(b.detail).toEqual({ calls: 20 });
  });

  test('GAT130_다른_kind의_경보는_따로_남는다', async () => {
    const store = new MemoryOpsAlertStore();
    const record = new RecordOpsAlert(store, () => NOW);
    await record.handle({ eventKey: 'k', kind: 'AUTO_FAILURE_RATE', severity: 'SEV2', source: 'purchase-svc', reason: 'r' });
    await record.handle({ eventKey: 'k', kind: 'REFUND_WINDOW_CLOSED', severity: 'SEV3', source: 'purchase-svc', reason: 'r' });
    expect(store.alerts.map((a) => a.kind)).toEqual(['AUTO_FAILURE_RATE', 'REFUND_WINDOW_CLOSED']);
  });
});
