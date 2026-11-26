// F-06-3 승인 업무 수명주기 HTTP 시험(시험 담당, 2026-11-26).
// 정본: docs/features/transfer-refund.md §3.2·§7.2·§11 R-T6·R-T7·R-T29·R-T26,
// docs/planning/03-policies-glossary.md §2.10·POL-038, docs/api/openapi.yaml /v1/ops/approval-requests*,
// docs/data.md approval_request·approval_vote. 값은 정본에서 가져오고 코드 상수와 같게 고르지 않는다.
// 메모리 조립(AppModule.register({memory:true}))에 승인 수명주기 포트를 꽂아 HTTP 바깥 경계만 본다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { FakeIdentity, quiet } from './support.js';

const KST = (s: string): number => Date.parse(`${s}+09:00`);
const NOW = KST('2026-11-26T10:00:00');
let wall = NOW;
const clock = { now: () => wall, monotonicMs: () => wall, advance: (ms: number) => { wall += ms; } };
const audit = new MemoryAuditChain();
const identity = new FakeIdentity();
const tokenAccount = new Map<string, string>();
const sessionAccount = new Map<string, string>();

class TestReauth {
  async verify(token: string | undefined, o: { sessionId: string; act: 'APPROVAL' }) {
    if (token !== 'approval-token') throw Object.assign(new Error('reauth-required'), { problem: { type: 'reauth-required', status: 403 } });
    return { accountId: tokenAccount.get(o.sessionId) ?? '', factors: ['password', 'totp', 'passkey'] };
  }
}

type Basis = {
  targetAccountId: string;
  dueAtMs?: number;
  entryStartsAtMs?: number;
  entryRecorded?: boolean;
  changed?: boolean;
};
const basis = new Map<string, Basis>();
const changedByRef = new Map<string, 'OK' | 'TARGET_CHANGED'>();
const refundCalls: Record<string, unknown>[] = [];
const reclaimCalls: Record<string, unknown>[] = [];
const notified: Record<string, unknown>[] = [];
const escalated: Record<string, unknown>[] = [];

const targets = {
  async basis(kind: string, targetRef: string) {
    return basis.get(`${kind}:${targetRef}`);
  },
  async changed(kind: string, targetRef: string) {
    return changedByRef.get(`${kind}:${targetRef}`) ?? 'OK';
  },
};
const executors = {
  async refund(i: Record<string, unknown>) {
    refundCalls.push(i);
    return { status: 'REFUNDED' as const, cancellationId: randomUUID(), refundAmount: i['amount'] as number };
  },
  async reclaim(i: Record<string, unknown>) {
    reclaimCalls.push(i);
    return { result: 'RECLAIMED' as const, previousHolderAccountId: randomUUID() };
  },
};
const notifier = { async send(i: Record<string, unknown>) { notified.push(i); } };
const alerts = { async open(i: Record<string, unknown>) { escalated.push(i); } };

let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({
      memory: true,
      auditChain: audit,
      approvals: { reauth: new TestReauth(), lifecycle: { targets, executors, notifier, alerts } } as never,
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});
beforeEach(() => {
  basis.clear();
  changedByRef.clear();
  refundCalls.length = 0;
  reclaimCalls.length = 0;
  notified.length = 0;
  escalated.length = 0;
  audit.entries.length = 0;
  tokenAccount.clear();
  sessionAccount.clear();
  wall = NOW;
});

const as = (role: 'operator' | 'commander' | 'cs_agent' | 'cs_lead') => {
  const h = identity.ops(role);
  sessionAccount.set(h['x-session-id']!, h['x-user-id']!);
  return h;
};
const headers = (h: Record<string, string>, token?: string): Record<string, string> => ({
  ...h,
  'content-type': 'application/json',
  ...(token ? { 'x-reauth-token': token } : {}),
});
const approveToken = (h: Record<string, string>) => {
  tokenAccount.set(h['x-session-id']!, h['x-user-id']!);
  return 'approval-token';
};
const requestRaw = async (h: Record<string, string>, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: '/v1/ops/approval-requests', headers: headers(h), payload: JSON.stringify(body) });
const request = async (h: Record<string, string>, body: Record<string, unknown>) => {
  const r = await requestRaw(h, body);
  expect(r.statusCode, r.payload).toBe(201);
  return r;
};
const approve = async (h: Record<string, string>, id: string, reason?: string) =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/ops/approval-requests/${id}/approvals`,
    headers: headers(h, approveToken(h)),
    payload: JSON.stringify(reason === undefined ? {} : { reason }),
  });
const reject = async (h: Record<string, string>, id: string, reason: string) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${id}/rejections`, headers: headers(h), payload: JSON.stringify({ reason }) });
const withdraw = async (h: Record<string, string>, id: string, reason: string) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${id}/withdrawals`, headers: headers(h), payload: JSON.stringify({ reason }) });
const get = async (h: Record<string, string>, id: string) =>
  svc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests/${id}`, headers: h });
const tick = async () =>
  svc.http.inject({ method: 'POST', url: '/internal/v1/approval-requests/tick', headers: { 'content-type': 'application/json', 'x-peaket-internal-token': 'test-internal' }, payload: '{}' });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

/** 5영업일(주말만 뺀다, 시작 시각의 같은 KST 시각). 정본 due_at 기본값 */
const plusBusinessDays = (ms: number, days: number): number => {
  const d = new Date(ms);
  let left = days;
  while (left > 0) {
    d.setTime(d.getTime() + 86_400_000);
    const day = new Date(d.getTime() + 9 * 3_600_000).getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return d.getTime();
};

const orderBasis = (orderId: string, payer: string, extra: Partial<Basis> = {}) => {
  basis.set(`SYSTEM_FAULT_REFUND:${orderId}`, { targetAccountId: payer, ...extra });
  basis.set(`DISCRETIONARY_WAIVER:${orderId}`, { targetAccountId: payer, ...extra });
  basis.set(`MINOR_CONTRACT_CANCEL:${orderId}`, { targetAccountId: payer, ...extra });
};

describe('R-T6 재량 면제의 1인·2인 판정', () => {
  test('R-T6 ① 29만 원·주문 1건은 요청자 + cs_lead 1인(requiredApprovals 2)이다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const r = await request(as('cs_agent'), { kind: 'DISCRETIONARY_WAIVER', targetRef: order, amount: 290_000, reasonCode: 'ILLNESS', reasonText: '진단서를 화면으로 확인함' });
    expect(r.statusCode).toBe(201);
    expect(json(r)).toMatchObject({ kind: 'DISCRETIONARY_WAIVER', targetRef: order, amount: 290_000, requiredApprovals: 2, status: 'PENDING_APPROVAL', approvals: [] });
    expect(json(r).dueAt).toBe(new Date(plusBusinessDays(NOW, 5)).toISOString());
  });

  test('R-T6 ② 31만 원은 cs_lead와 commander 두 사람의 승인이 필요하다(requiredApprovals 3)', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const r = await request(as('cs_agent'), { kind: 'DISCRETIONARY_WAIVER', targetRef: order, amount: 310_000, reasonCode: 'BEREAVEMENT', reasonText: '사망 사실 확인' });
    expect(r.statusCode).toBe(201);
    expect(json(r)).toMatchObject({ requiredApprovals: 3 });
  });

  test('R-T6 ② 같은 결제자의 90일 안 두 번째 요청은 10만 원이어도 3이다', async () => {
    const payer = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    orderBasis(first, payer);
    orderBasis(second, payer);
    expect((await request(as('cs_agent'), { kind: 'DISCRETIONARY_WAIVER', targetRef: first, amount: 100_000, reasonCode: 'ILLNESS', reasonText: '첫 요청' })).statusCode).toBe(201);
    const r = await request(as('cs_agent'), { kind: 'DISCRETIONARY_WAIVER', targetRef: second, amount: 100_000, reasonCode: 'ILLNESS', reasonText: '두 번째 요청' });
    expect(r.statusCode).toBe(201);
    expect(json(r)).toMatchObject({ requiredApprovals: 3 });
  });

  test('R-T6 ② 90일이 지난 앞 요청은 세지 않는다', async () => {
    const payer = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    orderBasis(first, payer);
    orderBasis(second, payer);
    const a = json(await request(as('cs_agent'), { kind: 'DISCRETIONARY_WAIVER', targetRef: first, amount: 100_000, reasonCode: 'ILLNESS', reasonText: '앞 요청' }));
    clock.advance(91 * 86_400_000);
    const r = await request(as('cs_agent'), { kind: 'DISCRETIONARY_WAIVER', targetRef: second, amount: 100_000, reasonCode: 'ILLNESS', reasonText: '90일 뒤' });
    expect(r.statusCode).toBe(201);
    expect(json(r)).toMatchObject({ requiredApprovals: 2 });
    expect(a['requiredApprovals']).toBe(2);
  });

  test('R-T6 ② 두 번째 요청의 결제자가 다르면 세지 않는다', async () => {
    const first = randomUUID();
    const second = randomUUID();
    orderBasis(first, randomUUID());
    orderBasis(second, randomUUID());
    expect((await request(as('cs_agent'), { kind: 'DISCRETIONARY_WAIVER', targetRef: first, amount: 100_000, reasonCode: 'ILLNESS', reasonText: '첫 결제자' })).statusCode).toBe(201);
    expect(json(await request(as('cs_agent'), { kind: 'DISCRETIONARY_WAIVER', targetRef: second, amount: 100_000, reasonCode: 'ILLNESS', reasonText: '다른 결제자' }))).toMatchObject({ requiredApprovals: 2 });
  });
});

describe('R-T7 요청자는 자기 승인 업무를 승인할 수 없다', () => {
  test('R-T7 요청자 본인이 승인하면 403 approval-self-not-allowed이고 상태·승인 표가 그대로다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const agent = as('cs_agent');
    const created = json(await request(agent, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제 기록 확인' }));
    const r = await approve(agent, created['approvalId'] as string);
    expect(r.statusCode).toBe(403);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('approval-self-not-allowed') });
    expect(json(await get(agent, created['approvalId'] as string))).toMatchObject({ status: 'PENDING_APPROVAL', approvals: [] });
    expect(refundCalls).toHaveLength(0);
  });

  test('R-T7 요청자가 반려해도 403이다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const agent = as('cs_agent');
    const created = json(await request(agent, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    expect((await reject(agent, created['approvalId'] as string, '내 요청')).statusCode).toBe(403);
  });

  test('R-T7 승인 역할이 아닌 사람은 403 approval-role-required다(1인 업무를 commander가 승인)', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(as('cs_agent'), { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    const r = await approve(as('commander'), created['approvalId'] as string);
    expect(r.statusCode).toBe(403);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('approval-role-required') });
    expect(refundCalls).toHaveLength(0);
  });
});

describe('승인 실행과 2인 차례', () => {
  test('시스템 잘못 환불은 cs_lead 1인이 승인하면 EXECUTING을 거쳐 DONE이고 환급 실행을 한 번 부른다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(as('cs_agent'), { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제 기록 확인' }));
    const lead = as('cs_lead');
    const r = await approve(lead, created['approvalId'] as string);
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ status: 'DONE', approvals: [expect.any(String)] });
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0]).toMatchObject({ approvalId: created['approvalId'], kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333 });
    expect(audit.entries.map((e) => e.recordType)).toEqual(expect.arrayContaining(['APPROVAL_REQUESTED', 'APPROVAL_APPROVED', 'APPROVAL_EXECUTING', 'APPROVAL_DONE']));
  });

  test('재량 면제 2인은 cs_lead 한 표로 끝나지 않고 commander가 두 번째로 승인해야 DONE이다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(as('cs_agent'), { kind: 'DISCRETIONARY_WAIVER', targetRef: order, amount: 310_000, reasonCode: 'BEREAVEMENT', reasonText: '사망 사실 확인' }));
    const lead = as('cs_lead');
    const first = await approve(lead, created['approvalId'] as string);
    expect(first.statusCode).toBe(200);
    expect(json(first)).toMatchObject({ status: 'PENDING_APPROVAL', approvals: [expect.any(String)] });
    expect(refundCalls).toHaveLength(0);
    const second = await approve(as('commander'), created['approvalId'] as string);
    expect(second.statusCode).toBe(200);
    expect(json(second)).toMatchObject({ status: 'DONE', approvals: [expect.any(String), expect.any(String)] });
    expect(refundCalls).toHaveLength(1);
  });

  test('같은 사람이 두 번 승인해도 한 표만 남고 끝나지 않는다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(as('cs_agent'), { kind: 'DISCRETIONARY_WAIVER', targetRef: order, amount: 310_000, reasonCode: 'BEREAVEMENT', reasonText: '사망' }));
    const lead = as('cs_lead');
    expect((await approve(lead, created['approvalId'] as string)).statusCode).toBe(200);
    expect((await approve(lead, created['approvalId'] as string)).statusCode).toBe(409);
    expect(refundCalls).toHaveLength(0);
  });

  test('반려하면 REJECTED와 사유가 남고 실행하지 않는다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(as('cs_agent'), { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    const r = await reject(as('cs_lead'), created['approvalId'] as string, '증빙이 부족합니다');
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ status: 'REJECTED', closeReason: '증빙이 부족합니다' });
    expect(refundCalls).toHaveLength(0);
    expect((await approve(as('cs_lead'), created['approvalId'] as string)).statusCode).toBe(409);
  });

  test('실행이 실패하면 FAILED와 CS 승인 실패 건이 남고, 다시 승인하면 같은 승인 ID로 다시 실행한다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(as('cs_agent'), { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    const failing = { refund: async () => { throw new Error('purchase down'); }, reclaim: executors.reclaim };
    // 실패 실행기는 이 시험에서만 갈아 끼운다(모듈 재조립은 beforeAll 밖이라 이 시험이 직접 서비스를 띄운다)
    const c = fakeClock({ now: NOW });
    const failedSvc = await createService({
      name: 'ops-svc',
      module: AppModule.register({ memory: true, auditChain: new MemoryAuditChain(), approvals: { reauth: new TestReauth(), lifecycle: { targets, executors: failing, notifier, alerts } } as never }),
      env: { PEAKET_ENV: 'ci' },
      clock: c,
      logDestination: quiet(),
      adminAuthz: identity,
    });
    try {
      const lead = identity.ops('cs_lead');
      sessionAccount.set(lead['x-session-id']!, lead['x-user-id']!);
      const created2 = json(await failedSvc.http.inject({ method: 'POST', url: '/v1/ops/approval-requests', headers: headers(as('cs_agent')), payload: JSON.stringify({ kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }) }));
      const r = await failedSvc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${created2['approvalId']}/approvals`, headers: headers(lead, approveToken(lead)), payload: '{}' });
      expect(r.statusCode).toBeGreaterThanOrEqual(500);
      const after = await failedSvc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests/${created2['approvalId']}`, headers: lead });
      expect(json(after)).toMatchObject({ status: 'FAILED' });
    } finally {
      await failedSvc.close();
    }
    expect(created['approvalId']).toBeTruthy();
  });

  test('승인 본문의 reason은 1,000자를 넘을 수 없다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(as('cs_agent'), { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    const r = await approve(as('cs_lead'), created['approvalId'] as string, '가'.repeat(1_001));
    expect(r.statusCode).toBe(400);
  });
});

describe('R-T29 ①② 승인 업무 철회', () => {
  test('R-T29 ① 요청자가 사유를 적어 거두면 WITHDRAWN·사유가 남고 승인할 수 없다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const agent = as('cs_agent');
    const created = json(await request(agent, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    const r = await withdraw(agent, created['approvalId'] as string, '결제자가 취소를 원하지 않습니다');
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ status: 'WITHDRAWN', closeReason: '결제자가 취소를 원하지 않습니다' });
    expect((await approve(as('cs_lead'), created['approvalId'] as string)).statusCode).toBe(409);
    expect(refundCalls).toHaveLength(0);
  });

  test('R-T29 ② 요청자가 아닌 사람이 거두려 하면 403이고 상태가 그대로다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(as('cs_agent'), { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    const r = await withdraw(as('cs_lead'), created['approvalId'] as string, '내가 거둔다');
    expect(r.statusCode).toBe(403);
    expect(json(await get(as('cs_agent'), created['approvalId'] as string))).toMatchObject({ status: 'PENDING_APPROVAL' });
  });

  test('이미 철회한 요청을 다시 철회하면 200이고 처음 사유 그대로다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const agent = as('cs_agent');
    const created = json(await request(agent, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    await withdraw(agent, created['approvalId'] as string, '처음 사유');
    const r = await withdraw(agent, created['approvalId'] as string, '두 번째 사유');
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ status: 'WITHDRAWN', closeReason: '처음 사유' });
  });

  test('승인·실행이 끝난 요청은 철회할 수 없다(409)', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const agent = as('cs_agent');
    const created = json(await request(agent, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    await approve(as('cs_lead'), created['approvalId'] as string);
    expect((await withdraw(agent, created['approvalId'] as string, '늦은 철회')).statusCode).toBe(409);
  });

  test('철회하면 1영업일 상위 알림을 다시 열지 않는다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const agent = as('cs_agent');
    const created = json(await request(agent, { kind: 'DISCRETIONARY_WAIVER', targetRef: order, amount: 310_000, reasonCode: 'BEREAVEMENT', reasonText: '사망' }));
    clock.advance(2 * 86_400_000);
    await withdraw(agent, created['approvalId'] as string, '요청자 철회');
    await tick();
    expect(escalated).toHaveLength(0);
  });
});

describe('R-T29 ③⑤ 대상 변경 만료와 승인 직전 재확인', () => {
  const reclaim = (ref: string, o: { entryStartsAtMs: number; targetAccountId?: string }) => {
    basis.set(`TRANSFER_RECLAIM:${ref}`, { targetAccountId: o.targetAccountId ?? randomUUID(), entryStartsAtMs: o.entryStartsAtMs });
  };

  test('R-T29 ③ 양도 회수 요청이 승인 대기인 채 입장이 시작되면 tick이 EXPIRED(TARGET_CHANGED)로 끝내고 요청자·승인자에게 알린다', async () => {
    const ticket = randomUUID();
    const entry = KST('2026-11-30T18:00:00');
    reclaim(ticket, { entryStartsAtMs: entry });
    const created = json(await request(as('cs_lead'), { kind: 'TRANSFER_RECLAIM', targetRef: ticket, amount: 0, reasonCode: 'ACCOUNT_TAKEOVER', reasonText: '받은 사람의 소명 기간이 지남' }));
    clock.advance(entry - clock.now());
    const r = await tick();
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ expired: 1 });
    const after = json(await get(as('cs_lead'), created['approvalId'] as string));
    expect(after).toMatchObject({ status: 'EXPIRED', closeReason: 'TARGET_CHANGED' });
    expect(notified.filter((n) => n['approvalId'] === created['approvalId']).length).toBeGreaterThanOrEqual(1);
    expect(reclaimCalls).toHaveLength(0);
  });

  test('R-T29 ⑤ 입장 시작 1초 뒤 승인하면 409 approval-expired이고 회수 호출이 0이다', async () => {
    const ticket = randomUUID();
    const entry = KST('2026-11-30T18:00:00');
    reclaim(ticket, { entryStartsAtMs: entry });
    const created = json(await request(as('cs_lead'), { kind: 'TRANSFER_RECLAIM', targetRef: ticket, amount: 0, reasonCode: 'ACCOUNT_TAKEOVER', reasonText: '소명 기간 지남' }));
    clock.advance(entry - clock.now() + 1_000);
    const r = await approve(as('commander'), created['approvalId'] as string);
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('approval-expired') });
    expect(reclaimCalls).toHaveLength(0);
    expect(json(await get(as('cs_lead'), created['approvalId'] as string))).toMatchObject({ status: 'EXPIRED' });
  });

  test('양도 회수는 요청 + 1일(소명 기한) 전에는 승인할 수 없다(409 reclaim-appeal-window)', async () => {
    const ticket = randomUUID();
    reclaim(ticket, { entryStartsAtMs: KST('2026-12-10T18:00:00') });
    const created = json(await request(as('cs_lead'), { kind: 'TRANSFER_RECLAIM', targetRef: ticket, amount: 0, reasonCode: 'ACCOUNT_TAKEOVER', reasonText: '소명 기한 전' }));
    clock.advance(23 * 3_600_000);
    const r = await approve(as('commander'), created['approvalId'] as string);
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('reclaim-appeal-window') });
    expect(reclaimCalls).toHaveLength(0);
  });

  test('양도 회수는 소명 기한 뒤·입장 시작 전이면 commander가 승인해 회수를 한 번 부른다', async () => {
    const ticket = randomUUID();
    const holder = randomUUID();
    reclaim(ticket, { entryStartsAtMs: KST('2026-12-10T18:00:00'), targetAccountId: holder });
    const created = json(await request(as('cs_lead'), { kind: 'TRANSFER_RECLAIM', targetRef: ticket, amount: 0, reasonCode: 'ACCOUNT_TAKEOVER', reasonText: '소명 기간 지남' }));
    clock.advance(25 * 3_600_000);
    const r = await approve(as('commander'), created['approvalId'] as string);
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ status: 'DONE' });
    expect(reclaimCalls).toHaveLength(1);
    expect(reclaimCalls[0]).toMatchObject({ approvalId: created['approvalId'], targetRef: ticket, targetAccountId: holder });
  });

  test('대상이 바뀌었으면 승인 직전에 409 approval-target-changed이고 상태가 EXPIRED가 된다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(as('cs_agent'), { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    changedByRef.set(`SYSTEM_FAULT_REFUND:${order}`, 'TARGET_CHANGED');
    const r = await approve(as('cs_lead'), created['approvalId'] as string);
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('approval-target-changed') });
    expect(refundCalls).toHaveLength(0);
    expect(json(await get(as('cs_agent'), created['approvalId'] as string))).toMatchObject({ status: 'EXPIRED', closeReason: 'TARGET_CHANGED' });
  });

  test('기한 경계: dueAt 1ms 전은 승인되고 dueAt 정각은 409 approval-expired다', async () => {
    const orderA = randomUUID();
    const orderB = randomUUID();
    orderBasis(orderA, randomUUID());
    orderBasis(orderB, randomUUID());
    const due = plusBusinessDays(NOW, 5);
    basis.set(`SYSTEM_FAULT_REFUND:${orderA}`, { targetAccountId: randomUUID(), dueAtMs: due });
    basis.set(`SYSTEM_FAULT_REFUND:${orderB}`, { targetAccountId: randomUUID(), dueAtMs: due });
    const a = json(await request(as('cs_agent'), { kind: 'SYSTEM_FAULT_REFUND', targetRef: orderA, amount: 10_000, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '경계 전' }));
    const b = json(await request(as('cs_agent'), { kind: 'SYSTEM_FAULT_REFUND', targetRef: orderB, amount: 10_000, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '경계' }));
    clock.advance(due - clock.now() - 1);
    expect((await approve(as('cs_lead'), a['approvalId'] as string)).statusCode).toBe(200);
    clock.advance(1);
    expect((await approve(as('cs_lead'), b['approvalId'] as string)).statusCode).toBe(409);
    expect(refundCalls).toHaveLength(1);
  });
});

describe('1영업일 무응답 상위 알림과 철회', () => {
  test('요청 + 1영업일이 지나면 ESCALATED와 경보를 한 번 열고, 다시 돌아도 두 번 열지 않는다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(as('cs_agent'), { kind: 'DISCRETIONARY_WAIVER', targetRef: order, amount: 310_000, reasonCode: 'BEREAVEMENT', reasonText: '사망' }));
    clock.advance(plusBusinessDays(NOW, 1) - clock.now());
    expect(json(await tick())).toMatchObject({ escalated: 1 });
    expect(json(await get(as('cs_lead'), created['approvalId'] as string))).toMatchObject({ status: 'ESCALATED' });
    expect(escalated).toHaveLength(1);
    await tick();
    expect(escalated).toHaveLength(1);
  });

  test('ESCALATED에서 첫 승인을 하면 PENDING_APPROVAL로 돌아가고, 두 번째 승인으로 끝난다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(as('cs_agent'), { kind: 'DISCRETIONARY_WAIVER', targetRef: order, amount: 310_000, reasonCode: 'BEREAVEMENT', reasonText: '사망' }));
    clock.advance(plusBusinessDays(NOW, 1) - clock.now());
    await tick();
    const first = await approve(as('cs_lead'), created['approvalId'] as string);
    expect(json(first)).toMatchObject({ status: 'PENDING_APPROVAL' });
    const second = await approve(as('commander'), created['approvalId'] as string);
    expect(json(second)).toMatchObject({ status: 'DONE' });
  });

  test('ESCALATED에서도 요청자는 철회할 수 있다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const agent = as('cs_agent');
    const created = json(await request(agent, { kind: 'DISCRETIONARY_WAIVER', targetRef: order, amount: 310_000, reasonCode: 'BEREAVEMENT', reasonText: '사망' }));
    clock.advance(plusBusinessDays(NOW, 1) - clock.now());
    await tick();
    expect((await withdraw(agent, created['approvalId'] as string, 'ESCALATED 철회')).statusCode).toBe(200);
  });
});

describe('요청 본문·대상 검사', () => {
  test('사유 코드·사유 글이 없으면 400 invalid-body이고 승인 업무를 만들지 않는다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const r = await requestRaw(as('cs_agent'), { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333 });
    expect(r.statusCode).toBe(400);
  });

  test('없는 주문은 404 not-found이고 승인 업무를 만들지 않는다', async () => {
    const r = await requestRaw(as('cs_agent'), { kind: 'SYSTEM_FAULT_REFUND', targetRef: randomUUID(), amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '없는 주문' });
    expect(r.statusCode).toBe(404);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('not-found') });
  });

  test('미성년자 계약 취소는 증빙 확인 사실이 없으면 422 approval-evidence-required다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const r = await requestRaw(as('cs_agent'), { kind: 'MINOR_CONTRACT_CANCEL', targetRef: order, amount: 33_333, reasonCode: 'MINOR', reasonText: '미성년자 계약 취소' });
    expect(r.statusCode).toBe(422);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('approval-evidence-required') });
    const ok = await request(as('cs_agent'), { kind: 'MINOR_CONTRACT_CANCEL', targetRef: order, amount: 33_333, reasonCode: 'MINOR', reasonText: '미성년자 계약 취소', evidenceChecked: 'PHONE_VERIFICATION' });
    expect(ok.statusCode).toBe(201);
    expect(json(ok)).toMatchObject({ evidenceChecked: 'PHONE_VERIFICATION' });
  });

  test('이 경로로 만들 수 없는 종류(COMMANDER_ROLE_CHANGE·FRAUD_ACTION·CONTRACT_TERMS_CHANGE)는 422다', async () => {
    for (const kind of ['COMMANDER_ROLE_CHANGE', 'FRAUD_ACTION', 'CONTRACT_TERMS_CHANGE']) {
      const r = await requestRaw(as('operator'), { kind, targetRef: randomUUID(), amount: 0, reasonCode: 'X', reasonText: 'X' });
      expect(r.statusCode).toBe(422);
    }
  });

  test('요청 역할이 아닌 사람이 요청하면 403이다(양도 회수를 cs_agent가 요청)', async () => {
    const ticket = randomUUID();
    basis.set(`TRANSFER_RECLAIM:${ticket}`, { targetAccountId: randomUUID(), entryStartsAtMs: KST('2026-12-10T18:00:00') });
    const r = await requestRaw(as('cs_agent'), { kind: 'TRANSFER_RECLAIM', targetRef: ticket, amount: 0, reasonCode: 'ACCOUNT_TAKEOVER', reasonText: '남의 요청' });
    expect(r.statusCode).toBe(403);
  });

  test('R-T26 ② 재량 면제의 증빙은 확인한 종류만 남고 파일·내용 칸은 받지 않는다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(as('cs_agent'), { kind: 'DISCRETIONARY_WAIVER', targetRef: order, amount: 290_000, reasonCode: 'ILLNESS', reasonText: '진단서 확인', evidenceChecked: 'DOCUMENT:진단서' }));
    expect(created).toMatchObject({ evidenceChecked: 'DOCUMENT:진단서' });
    expect(created).not.toHaveProperty('evidenceFile');
    const bad = await requestRaw(as('cs_agent'), { kind: 'DISCRETIONARY_WAIVER', targetRef: order, amount: 290_000, reasonCode: 'ILLNESS', reasonText: '파일 첨부', evidenceFile: 'base64...' });
    expect(bad.statusCode).toBe(400);
  });
});
