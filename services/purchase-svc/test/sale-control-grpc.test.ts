// 제어 gRPC ApplyControl(BAT-465 R-584, ADR-0102·0103·0123)의 purchase-svc 처리 시험.
// 판 번호가 지금 값보다 클 때만 쓰고, 같거나 작으면 지금 판을 돌려준다(멱등). 다른 종류는 UNIMPLEMENTED다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { applyControl, suspendedOf } from '../src/control/control-server.js';
import { MemorySaleControlCopies, MemorySaleControlStore, SetSaleSuspension } from '../src/modules/sale-control/index.js';

const NOW = Date.parse('2026-11-14T09:00:00.000Z');
const deps = () => {
  const store = new MemorySaleControlStore();
  const copies = new MemorySaleControlCopies();
  return { store, copies, deps: { setSuspension: new SetSaleSuspension(store, copies), podName: 'purchase-svc-1', nowMs: () => NOW } };
};
const req = (over: Record<string, unknown> = {}) => ({
  commandId: randomUUID(),
  scope: randomUUID(),
  kind: 'CONTROL_KIND_SALE_SUSPENSION',
  version: 10,
  desiredStateJson: '{"suspended":true}',
  ...over,
});

describe('BAT-465 제어 gRPC ApplyControl (purchase-svc)', () => {
  test('R584_판_번호가_크면_쓰고_ack에_적용한_판과_파드_이름을_준다', async () => {
    const w = deps();
    const eventId = randomUUID();
    const ack = await applyControl(req({ scope: eventId }), w.deps);
    expect(ack).toMatchObject({ appliedVersion: 10, podName: 'purchase-svc-1' });
    expect(w.copies.written.get(eventId)).toMatchObject({ suspended: '1', rev: '10' });
  });

  test('R584_같거나_작은_판은_아무것도_바꾸지_않는다', async () => {
    const w = deps();
    const eventId = randomUUID();
    await applyControl(req({ scope: eventId, version: 10 }), w.deps);
    const again = await applyControl(req({ scope: eventId, version: 10, desiredStateJson: '{"suspended":false}' }), w.deps);
    expect(again.appliedVersion).toBe(10);
    expect(w.store.rows.get(eventId)?.suspended).toBe(true);
    const older = await applyControl(req({ scope: eventId, version: 9, desiredStateJson: '{"suspended":false}' }), w.deps);
    expect(older.appliedVersion).toBe(10);
    expect(w.store.rows.get(eventId)?.suspended).toBe(true);
    const newer = await applyControl(req({ scope: eventId, version: 11, desiredStateJson: '{"suspended":false}' }), w.deps);
    expect(newer.appliedVersion).toBe(11);
    expect(w.store.rows.get(eventId)?.suspended).toBe(false);
  });

  test('R584_모르는_종류와_모양이_틀린_요청은_거절한다', async () => {
    const w = deps();
    await expect(applyControl(req({ kind: 'CONTROL_KIND_SALE_PAUSE' }), w.deps)).rejects.toMatchObject({ code: 12 });
    await expect(applyControl(req({ scope: 'not-a-uuid' }), w.deps)).rejects.toMatchObject({ code: 3 });
    await expect(applyControl(req({ desiredStateJson: '{"paused":true}' }), w.deps)).rejects.toMatchObject({ code: 3 });
    expect(suspendedOf('{"suspended":false}')).toBe(false);
    expect(suspendedOf('{}')).toBeUndefined();
  });
});
