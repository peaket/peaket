// BAT-465 GAT-300·GAT-310 HTTP 시험: 명령 실행·재시도·감사 체크포인트·폴링 갱신.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { FakeIdentity, quiet } from './support.js';
import type { CommandExecutionResult, CommandExecutor } from '../src/modules/commands/index.js';

const NOW = Date.parse('2026-11-14T07:00:00.000Z');
const identity = new FakeIdentity();
let svc: Awaited<ReturnType<typeof createService>>;
let failNext = false;
const calls: string[] = [];
const executor: CommandExecutor = {
  execute: async (command): Promise<CommandExecutionResult> => {
    calls.push(command.commandId);
    if (failNext) {
      failNext = false;
      return { status: 'FAILED', error: 'core-svc 409' };
    }
    return { status: 'SUCCEEDED', detail: { target: command.type } };
  },
};

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, executor, nowMs: NOW }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

const post = (url: string, headers: Record<string, string>, body: unknown) =>
  svc.http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const get = (url: string, headers: Record<string, string>) => svc.http.inject({ method: 'GET', url, headers });

describe('BAT-465 명령 실행·감사 체크포인트', () => {
  test('GAT300_SCALE_CHANGE는_접수_뒤_실행되어_SUCCEEDED다', async () => {
    const operator = identity.ops('operator');
    const r = await post('/v1/ops/commands', operator, { type: 'SCALE_CHANGE', reason: '규모 올리기', params: { eventId: randomUUID(), scale: 'LARGE' } });
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.payload) as { commandId: string; state: string; attempts: number; result: unknown };
    expect(body).toMatchObject({ state: 'SUCCEEDED', attempts: 1, result: { target: 'SCALE_CHANGE' } });
    expect(calls).toContain(body.commandId);
  });

  test('GAT300_EVENT_CANCEL은_2인_승인_뒤_실행되고_실패는_재시도한다', async () => {
    const operator = identity.ops('operator');
    const commander = identity.ops('commander');
    const created = await post('/v1/ops/commands', operator, { type: 'EVENT_CANCEL', reason: '회차 취소', params: { eventId: randomUUID(), fault: 'ORGANIZER' } });
    expect(created.statusCode).toBe(201);
    const { commandId } = JSON.parse(created.payload) as { commandId: string };
    failNext = true;
    const approved = await post(`/v1/ops/commands/${commandId}/approvals`, commander, {});
    expect(approved.statusCode).toBe(200);
    expect(JSON.parse(approved.payload)).toMatchObject({ commandId, state: 'FAILED', lastError: 'core-svc 409', attempts: 1 });
    const retried = await post(`/v1/ops/commands/${commandId}/retries`, commander, {});
    expect(retried.statusCode).toBe(200);
    expect(JSON.parse(retried.payload)).toMatchObject({ commandId, state: 'SUCCEEDED', attempts: 2 });
  });

  test('GAT310_체크포인트는_목록·상세·검증이_되고_viewer도_읽는다', async () => {
    const commander = identity.ops('commander');
    const viewer = identity.ops('viewer');
    const created = await post('/v1/ops/audit-checkpoints', commander, { reason: '명령 실행 전 점검' });
    expect(created.statusCode).toBe(201);
    const cp = JSON.parse(created.payload) as { checkpointId: string; fromSeq: number; toSeq: number; rootHash: string };
    expect(cp.fromSeq).toBeGreaterThan(0);
    expect(cp.toSeq).toBeGreaterThanOrEqual(cp.fromSeq);
    const list = await get('/v1/ops/audit-checkpoints?limit=10', viewer);
    expect(list.statusCode).toBe(200);
    expect((JSON.parse(list.payload) as { items: Array<{ checkpointId: string }> }).items.some((x) => x.checkpointId === cp.checkpointId)).toBe(true);
    const detail = await get(`/v1/ops/audit-checkpoints/${cp.checkpointId}`, viewer);
    expect(detail.statusCode).toBe(200);
    const verification = await get(`/v1/ops/audit-checkpoints/${cp.checkpointId}/verification`, viewer);
    expect(verification.statusCode).toBe(200);
    expect(JSON.parse(verification.payload)).toMatchObject({ checkpointId: cp.checkpointId, valid: true, rootValid: true, prevValid: true });
  });

  test('GAT310_체크포인트_생성은_commander만_하고_updatedAfter로_폴링한다', async () => {
    const operator = identity.ops('operator');
    expect((await post('/v1/ops/audit-checkpoints', operator, { reason: '권한 없음' })).statusCode).toBe(403);
    const updated = await get(`/v1/ops/commands?updatedAfter=${encodeURIComponent(new Date(NOW - 1).toISOString())}&limit=100`, operator);
    expect(updated.statusCode).toBe(200);
    expect((JSON.parse(updated.payload) as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });
});
