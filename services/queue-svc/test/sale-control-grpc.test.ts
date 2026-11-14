// 제어 gRPC ApplyControl(BAT-465 R-584, ADR-0102·0123)의 queue-svc 처리 시험.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { saleSuspensionControlBinding, suspendedOf } from '../src/control/control-server.js';
import { MemorySaleSuspensionCopies, SetSaleSuspensionCopy } from '../src/modules/sale/index.js';

const NOW = Date.parse('2026-11-14T09:00:00.000Z');

const call = (handlers: Record<string, unknown>, request: Record<string, unknown>) =>
  new Promise<{ e: { code?: number; message?: string } | null; v?: Record<string, unknown> }>((resolve) => {
    const fn = handlers.ApplyControl as (c: { request: Record<string, unknown> }, cb: (e: { code?: number; message?: string } | null, v?: Record<string, unknown>) => void) => void;
    fn({ request }, (e, v) => resolve({ e, v }));
  });

const fixture = () => {
  const copies = new MemorySaleSuspensionCopies();
  const errors: string[] = [];
  const binding = saleSuspensionControlBinding({ setSuspension: new SetSaleSuspensionCopy(copies), podName: 'queue-svc-1', nowMs: () => NOW, onError: (m) => void errors.push(m) });
  return { copies, errors, handlers: binding.handlers };
};

describe('BAT-465 제어 gRPC ApplyControl (queue-svc)', () => {
  test('R584_판매_중지를_사본에_쓰고_판_번호를_ack한다', async () => {
    const f = fixture();
    const eventId = randomUUID();
    const r = await call(f.handlers, {
      command_id: randomUUID(),
      scope: eventId,
      kind: 'CONTROL_KIND_SALE_SUSPENSION',
      version: 12,
      desired_state_json: '{"suspended":true}',
    });
    expect(r.e).toBeNull();
    expect(r.v).toMatchObject({ applied_version: 12, pod_name: 'queue-svc-1' });
    expect(f.copies.written.get(eventId)?.notice).toMatchObject({ suspended: '1', suspRev: '12' });
    expect(f.copies.written.get(eventId)?.ctl).toMatchObject({ suspended: '1', suspRev: '12' });
  });

  test('R584_모르는_종류와_모양이_틀린_요청은_거절한다', async () => {
    const f = fixture();
    expect((await call(f.handlers, { command_id: randomUUID(), scope: randomUUID(), kind: 'CONTROL_KIND_SALE_PAUSE', version: 1, desired_state_json: '{}' })).e?.code).toBe(12);
    expect((await call(f.handlers, { command_id: 'x', scope: randomUUID(), kind: 'CONTROL_KIND_SALE_SUSPENSION', version: 1, desired_state_json: '{"suspended":true}' })).e?.code).toBe(3);
    expect((await call(f.handlers, { command_id: randomUUID(), scope: randomUUID(), kind: 'CONTROL_KIND_SALE_SUSPENSION', version: 1, desired_state_json: '{"paused":true}' })).e?.code).toBe(3);
    expect(suspendedOf('{"suspended":false}')).toBe(false);
    expect(f.errors.length).toBeGreaterThan(0);
  });
});
