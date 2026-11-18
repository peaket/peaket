// /v1/ops/event-cancellations HTTP(메모리 조립, BAT-420 GAT-110 Q·W·H). 판매 중지는 실제 /v1/ops/commands SALE_STOP으로 걸고,
// 판매 중지 확인·판정 대기 건·판매 재개 막기는 AppModule의 메모리 기본 조립을 쓴다(구현 담당이 잇는다).
// 시험 담당이 구현 전에 썼다(ADR-0270).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { Command, CommandExecutor } from '../src/modules/commands/index.js';
import type { EventRefundReader, EventRefundStarter, EventSaleStopper } from '../src/modules/event-cancellations/index.js';
import { DRY_RUN, JOB, NOW, fakeReauth, okHolds, tokenFor } from './event-cancellation-fixtures.js';
import { FakeIdentity, quiet } from './support.js';

const identity = new FakeIdentity();
const executed: Array<{ type: Command['type']; commandId: string }> = [];
const executor: CommandExecutor = {
  execute: async (c) => {
    executed.push({ type: c.type, commandId: c.commandId });
    return { status: 'SUCCEEDED' };
  },
};
const started: string[] = [];
const stopped: string[] = [];
const behaviour = { jobFails: false, accountPending: undefined as number | undefined };
const refunds: EventRefundStarter = {
  start: async (i) => (started.push(i.requestId), { jobId: i.requestId, state: 'RUNNING' }),
  pause: async (i) => ({ jobId: i.requestId, state: 'PAUSED' }),
  resume: async (i) => ({ jobId: i.requestId, state: 'RUNNING' }),
};
const reader: EventRefundReader = {
  preview: async () => DRY_RUN,
  job: async () => {
    if (behaviour.jobFails) throw new Error('job down');
    // BAT-420-rest 리뷰 반영 RV-05(시험 담당 l3-b420-test): purchase 진행 답의 계좌 대기 수를 읽은 값(어댑터가 accountPending으로 싣는다)
    return behaviour.accountPending === undefined ? JOB : { ...JOB, accountPending: behaviour.accountPending };
  },
};
const stopper: EventSaleStopper = { stop: async (q) => void stopped.push(q.requestId) };
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, executor, eventCancellations: { refunds, reauth: fakeReauth(), reader, stopper, holds: okHolds() } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

type Headers = Record<string, string>;
const post = (url: string, headers: Headers, body: unknown) => svc.http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const get = (url: string, headers: Headers) => svc.http.inject({ method: 'GET', url, headers });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const withReauth = (who: Headers, key: string = randomUUID()): Headers => ({ ...who, 'idempotency-key': key, 'x-reauth-token': tokenFor(who['x-user-id']!) });

/** 실제 운영 명령 SALE_STOP(2인 승인)으로 판매를 멈춘다 */
async function suspend(eventId: string): Promise<void> {
  const created = await post('/v1/ops/commands', identity.ops('commander'), { type: 'SALE_STOP', reason: '판매 중지', params: { eventId, reasonCode: 'LEGAL_REQUEST' } });
  expect(created.statusCode).toBe(201);
  const approved = await post(`/v1/ops/commands/${json(created).commandId as string}/approvals`, identity.ops('commander'), {});
  expect(json(approved).state).toBe('SUCCEEDED');
}

/** 판매 중지 → commander 요청 → 판정 → operator 확정 */
async function running(eventId: string, commander: Headers = identity.ops('commander')): Promise<string> {
  await suspend(eventId);
  const r = await post('/v1/ops/event-cancellations', withReauth(commander), { eventId, reason: '공연 취소' });
  expect(r.statusCode).toBe(201);
  const requestId = json(r).requestId as string;
  const j = await post(`/v1/ops/event-cancellations/${requestId}/judgement`, commander, { fault: 'ORGANIZER', reason: '주최 측 귀책', fanNoticeReason: '공연이 취소되었습니다' });
  expect(json(j).status).toBe('PENDING_APPROVAL');
  const a = await post(`/v1/ops/event-cancellations/${requestId}/approvals`, withReauth(identity.ops('operator')), {});
  expect(json(a).status).toBe('RUNNING');
  return requestId;
}

describe('/v1/ops/event-cancellations [BAT-420 GAT-110]', () => {
  test('GAT-110 Q4 [ASVS v5.0.0-8.2.1] commander 요청은 연기를 받지 않고 operator는 403이다(HTTP)', async () => {
    const eventId = randomUUID();
    await suspend(eventId);
    const operator = identity.ops('operator');
    expect((await post('/v1/ops/event-cancellations', withReauth(operator), { eventId, reason: '공연 취소' })).statusCode).toBe(403);
    expect((await post('/v1/ops/event-cancellations', withReauth(identity.ops('commander')), { eventId, kind: 'POSTPONE', reason: '연기' })).statusCode).toBe(400);
  });

  test('GAT-110 Q2 commander 요청에 Idempotency-Key가 없으면 400 idempotency-key-invalid다(HTTP)', async () => {
    const eventId = randomUUID();
    await suspend(eventId);
    const commander = identity.ops('commander');
    const r = await post('/v1/ops/event-cancellations', { ...commander, 'x-reauth-token': tokenFor(commander['x-user-id']!) }, { eventId, reason: '공연 취소' });
    expect(r.statusCode).toBe(400);
    expect(json(r).type).toMatch(/idempotency-key-invalid$/);
  });

  test('GAT-110 Q1 commander 요청에 재인증 토큰이 없으면 403 reauth-required다(HTTP)', async () => {
    const eventId = randomUUID();
    await suspend(eventId);
    const r = await post('/v1/ops/event-cancellations', { ...identity.ops('commander'), 'idempotency-key': randomUUID() }, { eventId, reason: '공연 취소' });
    expect(r.statusCode).toBe(403);
    expect(json(r).type).toMatch(/reauth-required$/);
  });

  test('R-T23 ⑤ 판매 중지가 아닌 회차의 commander 요청은 409 sale-not-suspended다(HTTP, 명령 기록으로 확인)', async () => {
    const r = await post('/v1/ops/event-cancellations', withReauth(identity.ops('commander')), { eventId: randomUUID(), reason: '공연 취소' });
    expect(r.statusCode).toBe(409);
    expect(json(r).type).toMatch(/sale-not-suspended$/);
  });

  test('R-T23 ⑥ 판매 중지된 회차의 commander 요청은 201 REQUESTED이고 판정·확정으로 일괄 환불이 시작된다(HTTP)', async () => {
    const eventId = randomUUID();
    const requestId = await running(eventId);
    expect(started).toContain(requestId);
    expect(stopped).toContain(requestId);
  });

  test('GAT-110 Q2 같은 Idempotency-Key·같은 본문은 같은 요청 ID를, 다른 본문은 422 idempotency-key-reused를 준다(HTTP)', async () => {
    const eventId = randomUUID();
    await suspend(eventId);
    const commander = identity.ops('commander');
    const key = randomUUID();
    const a = await post('/v1/ops/event-cancellations', withReauth(commander, key), { eventId, reason: '공연 취소' });
    const b = await post('/v1/ops/event-cancellations', withReauth(commander, key), { eventId, reason: '공연 취소' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(json(b).requestId).toBe(json(a).requestId);
    const c = await post('/v1/ops/event-cancellations', withReauth(commander, key), { eventId, reason: '다른 사유' });
    expect(c.statusCode).toBe(422);
    expect(json(c).type).toMatch(/idempotency-key-reused$/);
    const listed = await get(`/v1/ops/event-cancellations?eventId=${eventId}`, commander);
    expect((json(listed).items as unknown[]).length).toBe(1);
  });

  test('GAT-110 Q3 진행 중 요청이 있으면 409 event-cancellation-active이고 확장 칸 requestId에 기존 요청 ID를 싣는다(HTTP)', async () => {
    const eventId = randomUUID();
    await suspend(eventId);
    const first = await post('/v1/ops/event-cancellations', withReauth(identity.ops('commander')), { eventId, reason: '공연 취소' });
    const second = await post('/v1/ops/event-cancellations', withReauth(identity.ops('commander')), { eventId, reason: '다시' });
    expect(second.statusCode).toBe(409);
    expect(json(second)).toMatchObject({ type: expect.stringMatching(/event-cancellation-active$/), requestId: json(first).requestId });
  });

  test('R-T37 ③ 판정 전 요청을 operator가 반려하면 403 rejection-not-allowed다(HTTP)', async () => {
    const eventId = randomUUID();
    await suspend(eventId);
    const r = await post('/v1/ops/event-cancellations', withReauth(identity.ops('commander')), { eventId, reason: '공연 취소' });
    const rejected = await post(`/v1/ops/event-cancellations/${json(r).requestId as string}/rejections`, identity.ops('operator'), { reason: '근거 없음' });
    expect(rejected.statusCode).toBe(403);
    expect(json(rejected).type).toMatch(/rejection-not-allowed$/);
  });

  test('GAT-110 W1 상세는 dryRun과 결제사별 진행률을 싣고 읽기 실패면 상태만 실으며 목록은 둘 다 싣지 않는다(HTTP)', async () => {
    const eventId = randomUUID();
    const operator = identity.ops('operator');
    const requestId = await running(eventId);
    const detail = await get(`/v1/ops/event-cancellations/${requestId}`, operator);
    expect(detail.statusCode).toBe(200);
    expect(detail.headers['cache-control']).toBe('no-store');
    const body = json(detail);
    expect(body.dryRun).toEqual(DRY_RUN);
    expect(body.progress).toMatchObject({ state: 'RUNNING', total: 30, done: 8, failed: 5 });
    expect((body.progress as { perPg: unknown[] }).perPg).toEqual([
      expect.objectContaining({ pg: 'TOSS', state: 'RUNNING', done: 5, failed: 1, unknown: 2 }),
      expect.objectContaining({ pg: 'PORTONE', state: 'PAUSED', pauseReason: 'MANUAL', done: 3, failed: 4, unknown: 6 }),
    ]);
    behaviour.jobFails = true;
    try {
      const failed = await get(`/v1/ops/event-cancellations/${requestId}`, operator);
      expect(failed.statusCode).toBe(200);
      expect(json(failed).progress).toEqual({ state: 'RUNNING' });
    } finally {
      behaviour.jobFails = false;
    }
    const list = await get(`/v1/ops/event-cancellations?eventId=${eventId}`, operator);
    const item = (json(list).items as Array<Record<string, unknown>>)[0]!;
    expect(item).not.toHaveProperty('dryRun');
    expect((item.progress as Record<string, unknown> | undefined)?.perPg).toBeUndefined();
  });

  test('R-T37 ⑤ 회차 취소가 확정된 회차의 판매 재개 명령은 만들 때 409 event-cancelled이고 확정 전에 만든 재개는 실행 때 FAILED다(HTTP)', async () => {
    const eventId = randomUUID();
    await suspend(eventId);
    const early = await post('/v1/ops/commands', identity.ops('commander'), { type: 'SALE_RESUME', reason: '판매 재개 준비', params: { eventId } });
    expect(early.statusCode).toBe(201);
    expect(json(early).state).toBe('PENDING_APPROVAL');
    const commander = identity.ops('commander');
    const r = await post('/v1/ops/event-cancellations', withReauth(commander), { eventId, reason: '공연 취소' });
    const requestId = json(r).requestId as string;
    await post(`/v1/ops/event-cancellations/${requestId}/judgement`, commander, { fault: 'ORGANIZER', reason: '주최 측 귀책', fanNoticeReason: '공연이 취소되었습니다' });
    expect(json(await post(`/v1/ops/event-cancellations/${requestId}/approvals`, withReauth(identity.ops('operator')), {})).status).toBe('RUNNING');

    const late = await post('/v1/ops/commands', identity.ops('commander'), { type: 'SALE_RESUME', reason: '판매 재개', params: { eventId } });
    expect(late.statusCode).toBe(409);
    expect(json(late).type).toMatch(/event-cancelled$/);

    const approved = await post(`/v1/ops/commands/${json(early).commandId as string}/approvals`, identity.ops('commander'), {});
    expect(approved.statusCode).toBe(200);
    expect(json(approved)).toMatchObject({ state: 'FAILED', lastError: 'event-cancelled' });
    expect(executed.filter((x) => x.type === 'SALE_RESUME')).toEqual([]);
    // 판매 중지는 막지 않는다
    expect((await post('/v1/ops/commands', identity.ops('commander'), { type: 'SALE_STOP', reason: '판매 중지 다시', params: { eventId, reasonCode: 'OTHER' } })).statusCode).toBe(201);
  });

  // BAT-420-rest 리뷰 반영 RV-05 재현(시험 담당 l3-b420-test, 2026-11-19): 정본 payment §6 '계좌 대기' 끝·transfer-refund §11 R-T40 ⑤
  test('R-T40 ⑤ 관제 상세 GET /v1/ops/event-cancellations/{requestId}의 progress.accountPending은 진행 답의 계좌 대기 수(2)이고, 결제사별 몫에는 싣지 않으며, 없으면 칸이 없다', async () => {
    const operator = identity.ops('operator');
    const requestId = await running(randomUUID());
    behaviour.accountPending = 2;
    try {
      const body = json(await get(`/v1/ops/event-cancellations/${requestId}`, operator));
      expect(body.progress).toMatchObject({ state: 'RUNNING', total: 30, done: 8, failed: 5, accountPending: 2 });
      for (const part of (body.progress as { perPg: Record<string, unknown>[] }).perPg) expect(part).not.toHaveProperty('accountPending');
    } finally {
      behaviour.accountPending = undefined;
    }
    const without = json(await get(`/v1/ops/event-cancellations/${requestId}`, operator));
    expect(without.progress).not.toHaveProperty('accountPending');
  });
});
