// F-02-7(A, OPS-310) C-T7: ack 시간 초과로 FAILED가 된 명령의 상세와 런북 CLI 한 줄.
// 정본: docs/features/control-tower.md §4 T10·§14 C-T7, docs/review/plans/F-02-7.md 6.7·8절.
// 시험은 메모리 원장·가짜 전송으로만 한다(PostgreSQL·Docker 없음).
import { randomUUID } from 'node:crypto';
import type { Clock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { type Command, type CommandType, ControlDispatcher, ControlFanout, type ControlTargets, type ControlTransport, MemoryCommandStore } from '../src/modules/commands/index.js';
import { viewOf } from '../src/modules/commands/inbound/command-view.js';

const T = Date.parse('2026-11-28T00:00:00.000Z');
const EVENT = '0193a000-0000-7000-9000-0000000000e1';
const REQUESTER = '0193a000-0000-7000-8000-0000ffff0001';

function movableClock(start: number) {
  let wall = start;
  let mono = 0;
  const clock: Clock = { now: () => wall, monotonicMs: () => mono };
  return {
    clock,
    advance: (ms: number) => {
      wall += ms;
      mono += ms;
    },
  };
}

type Service = 'admission-ctrl' | 'purchase-svc' | 'queue-svc';

function harness() {
  const audit = new MemoryAuditChain();
  const store = new MemoryCommandStore(audit);
  const time = movableClock(T);
  const targets: ControlTargets = {
    resolve: async (service: string) => {
      const s = service as Service;
      return [`${s}:50061`];
    },
  };
  const transport: ControlTransport = {
    apply: async (_svc, _address, req) => ({ appliedVersion: req.version - 1, podName: 'never-acks' }),
  };
  const sleep = async (ms: number) => time.advance(ms);
  const dispatcher = () => new ControlDispatcher({ store, fanout: new ControlFanout({ targets, transport, clock: time.clock, sleep }), clock: time.clock });
  const dispatched = async (type: CommandType, params: Record<string, unknown>, eventId?: string): Promise<Command> => {
    const c = await store.create({ commandId: randomUUID(), type, reason: '결제사 장애로 판매를 멈춘다', params, requestedBy: REQUESTER, requestedRole: 'commander', nowMs: time.clock.now(), approvalMode: 'ONE', ...(eventId ? { eventId } : {}) });
    return store.markDispatched(c.commandId, time.clock.now());
  };
  return {
    store,
    time,
    dispatched,
    run: async (c: Command) => {
      await dispatcher().resume(c.commandId);
      return (await store.find(c.commandId))!;
    },
  };
}

describe('F-02-7 C-T7 런북 한 줄', () => {
  test('C-T7 ① ack 시간 초과로 FAILED가 된 명령의 상세에 상태·시도 횟수·마지막 오류가 있다', async () => {
    const h = harness();
    const failed = await h.run(await h.dispatched('KILL_SWITCH', { scope: 'EVENT', eventIds: [EVENT] }, EVENT));
    expect(failed.state).toBe('FAILED');
    expect(failed.lastError).toMatch(/^ack-timeout:/);
    const view = viewOf(failed);
    expect(view.state).toBe('FAILED');
    expect(view.attempts).toBe(1);
    expect(view.lastError).toBe(failed.lastError);
  });

  test('C-T7 ② FAILED 상세가 다시 시도에 필요한 값을 싣고, 승인 대기와 섞이지 않는다', async () => {
    const h = harness();
    const failed = await h.run(await h.dispatched('KILL_SWITCH', { scope: 'EVENT', eventIds: [EVENT] }, EVENT));
    const view = viewOf(failed);
    expect(view.canApprove).toBe(false);
    expect(view.approvalExpiresAt).toBeUndefined();
    expect(view.attempts).toBe(1);
    expect(view.state).toBe('FAILED');
  });

  test('C-T7 ③ FAILED 명령 상세에 채운 런북 CLI 한 줄이 나오고 사유의 따옴표·$를 안전하게 인용한다', async () => {
    const h = harness();
    const failed = await h.run(await h.dispatched('KILL_SWITCH', { scope: 'EVENT', eventIds: [EVENT] }, EVENT));
    const view = viewOf({ ...failed, reason: '결제사 "장애" $HOME' });
    const line = (view as unknown as { runbookCommand?: string }).runbookCommand;
    expect(line).toBeDefined();
    expect(line).toContain('draft sale-pause');
    expect(line).toContain(`--event ${EVENT}`);
    expect(line).toContain('--reason "결제사 \\"장애\\" \\$HOME"');
    expect(line).toContain(`--command-id ${failed.commandId}`);
    expect(line).toContain(`--out runbook-${failed.commandId}.json`);
  });

  test('C-T7 ③ 플랫폼 범위는 --scope platform, 입장 일시정지는 --param expiresInSec=600을 쓴다', async () => {
    const h = harness();
    const platform = await h.run(await h.dispatched('KILL_SWITCH', { scope: 'PLATFORM' }));
    const platformLine = (viewOf(platform) as unknown as { runbookCommand?: string }).runbookCommand;
    expect(platformLine).toContain('draft sale-pause --scope platform');
    expect(platformLine).not.toContain('--event');

    const pause = await h.run(await h.dispatched('ADMISSION_PAUSE', { eventId: EVENT }, EVENT));
    const pauseLine = (viewOf(pause) as unknown as { runbookCommand?: string }).runbookCommand;
    expect(pauseLine).toContain('draft admission-pause');
    expect(pauseLine).toContain(`--event ${EVENT}`);
    expect(pauseLine).toContain('--param expiresInSec=600');

    const stop = await h.run(await h.dispatched('AUTOMATION_STOP', {}));
    const stopLine = (viewOf(stop) as unknown as { runbookCommand?: string }).runbookCommand;
    expect(stopLine).toContain('draft automation-stop --scope platform');
  });

  test('C-T7 ③ 런북 프리셋이 없는 명령(대기실 공지)에는 한 줄을 만들지 않는다', async () => {
    const h = harness();
    const banner = await h.run(await h.dispatched('LOBBY_BANNER', { eventId: EVENT, templateId: 'notice-1' }, EVENT));
    const view = viewOf(banner) as unknown as { runbookCommand?: string };
    expect(view.runbookCommand).toBeUndefined();
  });
});
