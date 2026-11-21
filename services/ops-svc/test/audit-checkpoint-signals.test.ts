// 감사 공개 앵커 신호(BAT-360 OPS-280, ADR-0348 결정 10, docs/observability.md '감사 공개 앵커 신호', control-tower §14 C-T41).
// 정본 값: 게시 안 된 가장 오래된 공개 체크포인트가 6시간(정각 포함)이면 SEV3 audit-checkpoint-publish-lag, PENDING이 24시간(정각 포함)이면 SEV3 audit-ots-incomplete,
// 체인을 다시 모은 루트가 저장값과 다르면 SEV2 audit-checkpoint-mismatch와 AUDIT_CHAIN_MISMATCH 기록(한 번). 지표 셋의 이름은 observability 표 그대로다.
// 경계 양쪽(− 1ms·정각)을 가짜 시각으로 본다. 저장소·체인·경보는 제품 메모리 짝 가짜(포트 구현)다.
import { describe, expect, test } from 'vitest';
import { MemoryOpsAlertStore } from '../src/modules/alerts/index.js';
import {
  AuditCheckpointPublisher,
  AuditCheckpointService,
  CheckpointSignalMonitor,
  CheckpointSignals,
  MemoryAuditChain,
  MemoryAuditPublicStore,
  MemoryAuditPublishStore,
  MemoryOpenTimestampsCalendar,
  ephemeralCheckpointSigner,
} from '../src/modules/audit/index.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 체크포인트를 만든 시각(일 체크포인트가 이미 지난 낮 시각을 골라 수동 체크포인트만 생기게 한다) */
const T0 = Date.parse('2026-11-24T13:07:00.000+09:00');

async function fixture() {
  const chain = new MemoryAuditChain();
  const store = new MemoryAuditPublishStore();
  const alerts = new MemoryOpsAlertStore();
  const signals = new CheckpointSignals();
  const service = new AuditCheckpointService(store, chain, () => T0);
  for (let i = 0; i < 3; i += 1) await chain.append({ recordType: 'COMMAND_CREATED', recordId: crypto.randomUUID(), payload: { i }, nowMs: T0 - HOUR + i });
  const cp = await service.create({ reason: '신호 시험', actorRef: 'commander' });
  const monitor = new CheckpointSignalMonitor({ source: store, verify: (id) => service.verify(id), alerts, signals, audit: chain });
  return { chain, store, alerts, signals, service, cp, monitor };
}

const openAlerts = (alerts: MemoryOpsAlertStore, kind: string) => alerts.alerts.filter((a) => a.kind === kind && a.resolvedAtMs === undefined);
const metric = async (m: { get(): Promise<{ values: { value: number }[] }> }) => (await m.get()).values[0]?.value;

describe('B8 게시 밀림·대기 증명 신호(ADR-0348 결정 10)', () => {
  test('C-T41 게시 안 된 체크포인트가 6시간 − 1ms면 경보가 없고 6시간 정각에 SEV3 audit-checkpoint-publish-lag 하나, 게시하면 풀린다', async () => {
    const f = await fixture();
    expect(await f.monitor.runOnce(T0 + 6 * HOUR - 1)).toMatchObject({ publishLag: false });
    expect(openAlerts(f.alerts, 'audit-checkpoint-publish-lag')).toEqual([]);
    expect(await f.monitor.runOnce(T0 + 6 * HOUR)).toMatchObject({ publishLag: true });
    await f.monitor.runOnce(T0 + 6 * HOUR + MINUTE);
    expect(openAlerts(f.alerts, 'audit-checkpoint-publish-lag')).toEqual([
      expect.objectContaining({ kind: 'audit-checkpoint-publish-lag', severity: 'SEV3', eventKey: 'audit-checkpoint', source: 'ops-svc', detail: expect.objectContaining({ no: 1 }) }),
    ]);
    // 게시 작업이 따라잡으면 풀리고, 지표는 마지막 게시 시각(초)을 낸다
    const publishedAt = T0 + 6 * HOUR + 2 * MINUTE;
    await new AuditCheckpointPublisher({ store: f.store, chain: f.chain, signer: ephemeralCheckpointSigner('sig-test'), calendars: [new MemoryOpenTimestampsCalendar()], targets: [new MemoryAuditPublicStore('public'), new MemoryAuditPublicStore('anchor')] }).run(publishedAt);
    await f.monitor.runOnce(publishedAt + MINUTE);
    expect(openAlerts(f.alerts, 'audit-checkpoint-publish-lag')).toEqual([]);
    expect(f.alerts.alerts.find((a) => a.kind === 'audit-checkpoint-publish-lag')!.resolvedAtMs).toBe(publishedAt + MINUTE);
    expect(await metric(f.signals.lastPublished)).toBe(Math.floor(publishedAt / 1000));
    // 이 실행은 그날 일 체크포인트(2, 수동 체크포인트의 감사 기록을 덮는다)도 만들어 둘 다 PENDING이다
    expect((await f.store.findByNo(2))!.kind).toBe('DAILY');
    expect(await metric(f.signals.pendingOts)).toBe(2);
  });

  test('B8 PENDING 증명이 24시간 − 1ms면 경보가 없고 24시간 정각에 SEV3 audit-ots-incomplete, 완료되면 풀린다', async () => {
    const f = await fixture();
    const cal = new MemoryOpenTimestampsCalendar('https://cal-signals.test.invalid');
    const publisher = new AuditCheckpointPublisher({ store: f.store, chain: f.chain, signer: ephemeralCheckpointSigner('sig-ots'), calendars: [cal], targets: [new MemoryAuditPublicStore('public'), new MemoryAuditPublicStore('anchor')] });
    await publisher.run(T0 + MINUTE);
    expect((await f.store.findByNo(1))!.otsState).toBe('PENDING');
    expect(await f.monitor.runOnce(T0 + 24 * HOUR - 1)).toMatchObject({ otsIncomplete: false, publishLag: false });
    expect(openAlerts(f.alerts, 'audit-ots-incomplete')).toEqual([]);
    expect(await f.monitor.runOnce(T0 + 24 * HOUR)).toMatchObject({ otsIncomplete: true });
    expect(openAlerts(f.alerts, 'audit-ots-incomplete')).toEqual([expect.objectContaining({ severity: 'SEV3', eventKey: 'audit-checkpoint', detail: expect.objectContaining({ no: 1 }) })]);
    cal.complete();
    await publisher.run(T0 + 24 * HOUR + MINUTE);
    expect((await f.store.findByNo(1))!.otsState).toBe('COMPLETE');
    await f.monitor.runOnce(T0 + 24 * HOUR + 2 * MINUTE);
    expect(openAlerts(f.alerts, 'audit-ots-incomplete')).toEqual([]);
    expect(await metric(f.signals.pendingOts)).toBe(0);
  });
});

describe('B7 어긋남 신호(ADR-0348 결정 10)', () => {
  test('B7 서명 전 체크포인트의 루트가 체인과 다르면 임대를 쥔 파드가 SEV2 audit-checkpoint-mismatch와 AUDIT_CHAIN_MISMATCH 기록을 한 번 남기고 지표를 올린다', async () => {
    const f = await fixture();
    // 임대 없는 파드는 어긋남 검증을 하지 않는다
    expect((await f.monitor.runOnce(T0 + MINUTE)).mismatches).toEqual([]);
    expect(await f.monitor.runOnce(T0 + MINUTE, { leader: true })).toMatchObject({ mismatches: [] });
    // 다른 프로세스(새 감시)가 어긋난 뒤 본다: 기록 2의 해시를 바꾼다
    (f.chain.entries[1] as { hash: string }).hash = 'cd'.repeat(32);
    const fresh = new CheckpointSignalMonitor({ source: f.store, verify: (id) => f.service.verify(id), alerts: f.alerts, signals: f.signals, audit: f.chain });
    expect((await fresh.runOnce(T0 + 2 * MINUTE, { leader: true })).mismatches).toEqual([1]);
    expect(await metric(f.signals.mismatchTotal)).toBe(1);
    // 다른 파드가 다시 봐도 경보·기록은 하나로 모인다
    const again = new CheckpointSignalMonitor({ source: f.store, verify: (id) => f.service.verify(id), alerts: f.alerts, signals: f.signals, audit: f.chain });
    await again.runOnce(T0 + 3 * MINUTE, { leader: true });
    expect(f.alerts.alerts.filter((a) => a.kind === 'audit-checkpoint-mismatch')).toEqual([
      expect.objectContaining({ severity: 'SEV2', eventKey: 'audit-checkpoint:1', detail: expect.objectContaining({ no: 1, checkpointId: f.cp.checkpointId }) }),
    ]);
    const mismatchRecords = f.chain.entries.filter((e) => e.recordType === 'AUDIT_CHAIN_MISMATCH');
    expect(mismatchRecords).toHaveLength(1);
    expect(mismatchRecords[0]!.record).toMatchObject({ recordId: f.cp.checkpointId, payload: expect.objectContaining({ checkpointId: f.cp.checkpointId, no: 1, fromSeq: 1, toSeq: 3 }) });
  });

  test('B360-SIG ① 지표 이름은 observability 정본의 셋이다', async () => {
    const sg = new CheckpointSignals();
    const names = await Promise.all([sg.lastPublished, sg.pendingOts, sg.mismatchTotal].map(async (m) => (await m.get()).name));
    expect(names).toEqual(['audit_checkpoint_last_published_timestamp', 'audit_checkpoint_pending_ots', 'audit_checkpoint_mismatch_total']);
  });
});
