// 판매 중지·재개 명령 집행(BAT-465 R-584, ADR-0123) 단위 시험.
// 2인 승인, purchase-svc → queue-svc 차례(중지)와 반대 차례(재개), 실패 시 FAILED와 재시도 가능을 본다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { HttpCommandExecutor } from '../src/adapters/http-command-executor.js';
import { approvalModeOf, type Command } from '../src/modules/commands/index.js';

const NOW = Date.parse('2026-11-14T09:00:00.000Z');
const actor = { accountId: randomUUID(), sessionId: randomUUID(), role: 'commander' };

const command = (type: 'SALE_STOP' | 'SALE_RESUME', params: Record<string, unknown> = {}): Command => ({
  commandId: randomUUID(),
  type,
  state: 'APPROVED',
  reason: '판매자 신원 확인',
  params: { eventId: randomUUID(), reasonCode: 'SELLER_IDENTITY', ...params },
  requestedBy: randomUUID(),
  requestedRole: 'operator',
  createdAtMs: NOW,
  updatedAtMs: NOW,
  approvals: [randomUUID()],
  attempts: 0,
});

interface Call {
  provider: string;
  body: Record<string, unknown>;
}

const client = (provider: string, calls: Call[], status = 200, revision = 1) => ({
  request: async (r: { body?: string | Uint8Array }) => {
    const raw = typeof r.body === 'string' ? r.body : '{}';
    calls.push({ provider, body: JSON.parse(raw) as Record<string, unknown> });
    return new Response(JSON.stringify({ eventId: randomUUID(), suspended: true, revision }), { status, headers: { 'content-type': 'application/json' } });
  },
});

describe('BAT-465 판매 중지·재개 집행', () => {
  test('R584_두_명령_모두_2인_승인이다', () => {
    expect(approvalModeOf('SALE_STOP')).toBe('TWO');
    expect(approvalModeOf('SALE_RESUME')).toBe('TWO');
  });

  test('R584_중지는_purchase_뒤_queue에_SUSPEND를_보내고_판_번호를_넘긴다', async () => {
    const calls: Call[] = [];
    const executor = new HttpCommandExecutor({ purchase: client('purchase-svc', calls, 200, 7), queue: client('queue-svc', calls) });
    const c = command('SALE_STOP');
    const result = await executor.execute(c, actor);
    expect(result).toMatchObject({ status: 'SUCCEEDED', detail: { target: 'purchase-svc+queue-svc', suspended: true, revision: 7 } });
    expect(calls.map((x) => x.provider)).toEqual(['purchase-svc', 'queue-svc']);
    expect(calls[0]!.body).toMatchObject({ action: 'SUSPEND', commandId: c.commandId, reason: c.reason, suspensionRef: c.commandId });
    expect(calls[1]!.body).toMatchObject({ action: 'SUSPEND', commandId: c.commandId, revision: 7 });
  });

  test('R584_재개는_queue_뒤_purchase에_RESUME을_보낸다', async () => {
    const calls: Call[] = [];
    const executor = new HttpCommandExecutor({ purchase: client('purchase-svc', calls, 200, 8), queue: client('queue-svc', calls) });
    const result = await executor.execute(command('SALE_RESUME', { suspensionRef: 'AP-77' }), actor);
    expect(result.status).toBe('SUCCEEDED');
    expect(calls.map((x) => x.provider)).toEqual(['queue-svc', 'purchase-svc']);
    expect(calls[0]!.body).toMatchObject({ action: 'RESUME' });
    expect(calls[1]!.body).toMatchObject({ action: 'RESUME', suspensionRef: 'AP-77' });
  });

  test('R584_한쪽이_없거나_실패하면_FAILED이고_뒤_대상을_부르지_않는다', async () => {
    const calls: Call[] = [];
    const noQueue = new HttpCommandExecutor({ purchase: client('purchase-svc', calls) });
    expect(await noQueue.execute(command('SALE_STOP'), actor)).toEqual({ status: 'FAILED', error: 'target-not-wired' });
    const failing = new HttpCommandExecutor({ purchase: client('purchase-svc', calls, 409), queue: client('queue-svc', calls) });
    expect(await failing.execute(command('SALE_STOP'), actor)).toEqual({ status: 'FAILED', error: 'purchase-svc sale suspension 409' });
    expect(calls.filter((x) => x.provider === 'queue-svc')).toHaveLength(0);
  });

  test('R584_회차_ID나_사유_코드가_틀리면_실행하지_않는다', async () => {
    const calls: Call[] = [];
    const executor = new HttpCommandExecutor({ purchase: client('purchase-svc', calls), queue: client('queue-svc', calls) });
    expect(await executor.execute(command('SALE_STOP', { eventId: 7 }), actor)).toEqual({ status: 'FAILED', error: 'invalid-sale-suspension-params' });
    expect(await executor.execute(command('SALE_STOP', { reasonCode: 'BORED' }), actor)).toEqual({ status: 'FAILED', error: 'invalid-sale-suspension-params' });
    expect(calls).toHaveLength(0);
  });

  test('R584_제어_gRPC가_있으면_그_길로_보내고_ack_판을_본다', async () => {
    const sent: Array<{ target: string; req: Record<string, unknown> }> = [];
    const sender = (target: string, applied = Number.MAX_SAFE_INTEGER) => ({
      apply: async (req: { version: number }) => {
        sent.push({ target, req: req as unknown as Record<string, unknown> });
        return { appliedVersion: applied === Number.MAX_SAFE_INTEGER ? req.version : applied, podName: `${target}-1` };
      },
      close: () => undefined,
    });
    const executor = new HttpCommandExecutor({ control: { purchase: sender('purchase-svc'), queue: sender('queue-svc') } });
    const c = command('SALE_STOP');
    const ok = await executor.execute(c, actor);
    expect(ok).toMatchObject({ status: 'SUCCEEDED', detail: { target: 'control-grpc', suspended: true } });
    expect(sent.map((x) => x.target)).toEqual(['purchase-svc', 'queue-svc']);
    expect(sent[0]!.req).toMatchObject({ commandId: c.commandId, scope: c.params.eventId, kind: 'CONTROL_KIND_SALE_SUSPENSION', version: c.updatedAtMs, desiredStateJson: '{"suspended":true}' });

    const stale = new HttpCommandExecutor({ control: { purchase: sender('purchase-svc', 1), queue: sender('queue-svc') } });
    expect(await stale.execute(command('SALE_STOP'), actor)).toMatchObject({ status: 'FAILED', error: 'ack-pending:purchase-svc:1' });
  });
});
