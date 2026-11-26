// F-06-3 승인 업무 수명주기 HTTP 시험(시험 담당, 2026-11-26. 시험 리뷰 TR-02·03·06·07·08·09·10·13·14·15 반영).
// 정본: docs/features/transfer-refund.md §3.2·§7.2·§11 R-T6·R-T7·R-T29·R-T26,
// docs/planning/03-policies-glossary.md §2.10·POL-038, docs/api/openapi.yaml /v1/ops/approval-requests*,
// docs/data.md approval_request·approval_vote. 값은 정본에서 가져오고 코드 상수와 같게 고르지 않는다.
// 메모리 조립(AppModule.register({memory:true}))에 승인 수명주기 포트를 꽂아 HTTP 바깥 경계만 본다.
import 'reflect-metadata';
import { createService } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { FakeIdentity } from './support.js';

const KST = (s: string): number => Date.parse(`${s}+09:00`);
const NOW = KST('2026-11-26T10:00:00'); // 목요일
const INTERNAL = 'ops-internal-f063';
let wall = NOW;
const clock = { now: () => wall, monotonicMs: () => wall, advance: (ms: number) => { wall += ms; } };
const audit = new MemoryAuditChain();
const identity = new FakeIdentity();
const logLines: string[] = [];
const logDestination = new Writable({ write: (c, _e, cb) => { logLines.push(String(c)); cb(); } });
const tokenAccount = new Map<string, string>();

class TestReauth {
  async verify(token: string | undefined, o: { sessionId: string; act: 'APPROVAL' }) {
    if (token !== 'approval-token') throw Object.assign(new Error('reauth-required'), { type: 'reauth-required', status: 403 });
    return { accountId: tokenAccount.get(o.sessionId) ?? '', factors: ['password', 'totp', 'passkey'] };
  }
}

type Basis = { targetAccountId: string; dueAtMs?: number; entryStartsAtMs?: number; entryRecorded?: boolean };
const basis = new Map<string, Basis>();
const changedByRef = new Map<string, 'OK' | 'TARGET_CHANGED'>();
const refundCalls: Record<string, unknown>[] = [];
const reclaimCalls: Record<string, unknown>[] = [];
const notified: { approvalId: string; event: string; recipient: { kind: string; accountId?: string; role?: string } }[] = [];
const escalated: Record<string, unknown>[] = [];
const failedCases: { approvalId: string; kind: string; dueAtMs: number | null }[] = [];
const succeededCases: string[] = [];

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
const notifier = { async send(i: (typeof notified)[number]) { notified.push(i); } };
const alerts = { async open(i: Record<string, unknown>) { escalated.push(i); } };
const failureCases = {
  async failed(i: { approvalId: string; kind: string; dueAtMs: number | null }) { failedCases.push(i); },
  async succeeded(id: string) { succeededCases.push(id); },
};

let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({
      memory: true,
      auditChain: audit,
      approvals: { reauth: new TestReauth(), lifecycle: { targets, executors, notifier, alerts, failureCases } } as never,
    }),
    env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: INTERNAL },
    clock,
    logDestination,
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
  failedCases.length = 0;
  succeededCases.length = 0;
  audit.entries.length = 0;
  logLines.length = 0;
  tokenAccount.clear();
  wall = NOW;
});

const ACCOUNTS = {
  requester: randomUUID(),
  lead: randomUUID(),
  commander: randomUUID(),
  otherLead: randomUUID(),
};
const sessionFor = (accountId: string, role: 'operator' | 'commander' | 'cs_agent' | 'cs_lead', sessionId = randomUUID()): Record<string, string> => {
  identity.answers.set(`${accountId}/${sessionId}`, { valid: true, role });
  return { 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': 'ops', 'x-user-scope': '' };
};
const requester = sessionFor(ACCOUNTS.requester, 'cs_agent');
const lead = sessionFor(ACCOUNTS.lead, 'cs_lead');
const commander = sessionFor(ACCOUNTS.commander, 'commander');
const otherLead = sessionFor(ACCOUNTS.otherLead, 'cs_lead');

const headers = (h: Record<string, string>, token?: string, ifMatch?: number): Record<string, string> => ({
  ...h,
  'content-type': 'application/json',
  ...(token ? { 'x-reauth-token': token } : {}),
  ...(ifMatch === undefined ? {} : { 'If-Match': `"${ifMatch}"` }),
});
const reauth = (h: Record<string, string>) => {
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
const get = async (h: Record<string, string>, id: string) => svc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests/${id}`, headers: h });
const versionOf = async (h: Record<string, string>, id: string): Promise<number> => {
  const r = await get(h, id);
  if (r.statusCode !== 200) return 1;
  return Number(JSON.parse(r.payload).version ?? 1);
};
const approve = async (h: Record<string, string>, id: string, reason?: string, version?: number) =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/ops/approval-requests/${id}/approvals`,
    headers: headers(h, reauth(h), version ?? (await versionOf(h, id))),
    payload: JSON.stringify(reason === undefined ? {} : { reason }),
  });
const reject = async (h: Record<string, string>, id: string, reason: string) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${id}/rejections`, headers: headers(h, undefined, await versionOf(h, id)), payload: JSON.stringify({ reason }) });
const withdraw = async (h: Record<string, string>, id: string, reason: string) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${id}/withdrawals`, headers: headers(h, undefined, await versionOf(h, id)), payload: JSON.stringify({ reason }) });
const tick = async (token: string | undefined = INTERNAL) =>
  svc.http.inject({ method: 'POST', url: '/internal/v1/approval-requests/tick', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { 'x-peaket-internal-token': token }) }, payload: '{}' });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

/** 정본의 5영업일(주말만 뺀다, 시작 시각의 같은 KST 시각) */
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
  for (const kind of ['SYSTEM_FAULT_REFUND', 'DISCRETIONARY_WAIVER', 'MINOR_CONTRACT_CANCEL']) basis.set(`${kind}:${orderId}`, { targetAccountId: payer, ...extra });
};
const waiver = (h: Record<string, string>, order: string, amount = 100_000, extra: Record<string, unknown> = {}) =>
  request(h, { kind: 'DISCRETIONARY_WAIVER', targetRef: order, amount, reasonCode: 'ILLNESS', reasonText: '사유 확인', ...extra });
const auditTypes = () => audit.entries.map((e) => e.recordType);

describe('R-T6 재량 면제의 1인·2인 판정', () => {
  test('R-T6 ① 29만 원·주문 1건은 요청자 + cs_lead 1인(requiredApprovals 2)이고 dueAt은 요청 + 5영업일이다 [ASVS v5.0.0-2.1.2]', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const r = await waiver(requester, order, 290_000);
    expect(json(r)).toMatchObject({ kind: 'DISCRETIONARY_WAIVER', targetRef: order, amount: 290_000, requiredApprovals: 2, status: 'PENDING_APPROVAL', approvals: [] });
    expect(json(r).dueAt).toBe('2026-12-03T01:00:00.000Z');
  });

  test('R-T6 ② 30만 원 정각은 1인이고 30만 원을 1원 넘으면 2인이다', async () => {
    const a = randomUUID();
    const b = randomUUID();
    orderBasis(a, randomUUID());
    orderBasis(b, randomUUID());
    expect(json(await waiver(requester, a, 300_000))).toMatchObject({ requiredApprovals: 2 });
    expect(json(await waiver(requester, b, 300_001))).toMatchObject({ requiredApprovals: 3 });
  });

  test('R-T6 ② 여러 주문을 한 번에 요청하면(relatedOrderIds) 3이다 [ASVS v5.0.0-2.2.1]', async () => {
    const a = randomUUID();
    const b = randomUUID();
    orderBasis(a, randomUUID());
    orderBasis(b, randomUUID());
    const r = await waiver(requester, a, 100_000, { relatedOrderIds: [b] });
    expect(json(r)).toMatchObject({ requiredApprovals: 3 });
  });

  test('R-T6 ② 다른 종류에 relatedOrderIds를 보내면 400 invalid-body다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const r = await requestRaw(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복', relatedOrderIds: [randomUUID()] });
    expect(r.statusCode).toBe(400);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('invalid-body') });
  });

  test('R-T6 ② 같은 결제자의 90일 안 두 번째 요청은 10만 원이어도 3이다', async () => {
    const payer = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    orderBasis(first, payer);
    orderBasis(second, payer);
    expect((await waiver(requester, first)).statusCode).toBe(201);
    expect(json(await waiver(requester, second))).toMatchObject({ requiredApprovals: 3 });
  });

  test('R-T6 ② 90일 경계: 89일은 세고 90일 정각은 세지 않는다', async () => {
    const payerA = randomUUID();
    const firstA = randomUUID();
    const within = randomUUID();
    orderBasis(firstA, payerA);
    orderBasis(within, payerA);
    expect((await waiver(requester, firstA)).statusCode).toBe(201);
    wall = NOW + 89 * 86_400_000;
    expect(json(await waiver(requester, within))).toMatchObject({ requiredApprovals: 3 });

    wall = NOW;
    const payerB = randomUUID();
    const firstB = randomUUID();
    const atBoundary = randomUUID();
    orderBasis(firstB, payerB);
    orderBasis(atBoundary, payerB);
    expect((await waiver(requester, firstB)).statusCode).toBe(201);
    wall = NOW + 90 * 86_400_000;
    expect(json(await waiver(requester, atBoundary))).toMatchObject({ requiredApprovals: 2 });
  });

  test('R-T6 ② 철회·반려·만료한 앞 요청은 세지 않는다 [ASVS v5.0.0-2.1.2]', async () => {
    const payer = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    const third = randomUUID();
    const fourth = randomUUID();
    orderBasis(first, payer);
    orderBasis(second, payer);
    orderBasis(third, payer);
    orderBasis(fourth, payer);

    const a = json(await waiver(requester, first));
    expect((await withdraw(requester, a['approvalId'] as string, '철회')).statusCode).toBe(200);
    expect(json(await waiver(requester, second))).toMatchObject({ requiredApprovals: 2 });

    const b = json(await waiver(requester, second));
    expect((await reject(lead, b['approvalId'] as string, '반려')).statusCode).toBe(200);
    expect(json(await waiver(requester, third))).toMatchObject({ requiredApprovals: 2 });

    const c = json(await waiver(requester, third));
    wall = plusBusinessDays(NOW, 5);
    await tick();
    expect(json(await get(lead, c['approvalId'] as string))).toMatchObject({ status: 'EXPIRED' });
    expect(json(await waiver(requester, fourth))).toMatchObject({ requiredApprovals: 2 });
  });

  test('R-T6 ② 두 번째 요청의 결제자가 다르면 세지 않는다', async () => {
    const first = randomUUID();
    const second = randomUUID();
    orderBasis(first, randomUUID());
    orderBasis(second, randomUUID());
    expect((await waiver(requester, first)).statusCode).toBe(201);
    expect(json(await waiver(requester, second))).toMatchObject({ requiredApprovals: 2 });
  });
});

describe('R-T7 요청자는 자기 승인 업무를 승인할 수 없다', () => {
  test('R-T7 다른 세션 같은 계정도 요청자면 403 approval-self-not-allowed이고 감사에 남는다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-16.3.2]', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제 기록 확인' }));
    const sameAccountOtherSession = sessionFor(ACCOUNTS.requester, 'cs_lead');
    const r = await approve(sameAccountOtherSession, created['approvalId'] as string);
    expect(r.statusCode).toBe(403);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('approval-self-not-allowed') });
    expect(json(await get(requester, created['approvalId'] as string))).toMatchObject({ status: 'PENDING_APPROVAL', approvals: [] });
    expect(refundCalls).toHaveLength(0);
    expect(audit.entries).toContainEqual(expect.objectContaining({ recordType: 'APPROVAL_DENIED', payload: expect.objectContaining({ reason: 'SELF' }) }));
  });

  test('R-T7 요청자가 같은 세션으로 반려해도 403이다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    expect((await reject(requester, created['approvalId'] as string, '내 요청')).statusCode).toBe(403);
  });

  test('R-T7 승인 역할이 아닌 사람은 403 approval-role-required이고 감사에 남는다 [ASVS v5.0.0-8.2.1]', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    const r = await approve(commander, created['approvalId'] as string);
    expect(r.statusCode).toBe(403);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('approval-role-required') });
    expect(refundCalls).toHaveLength(0);
    expect(audit.entries).toContainEqual(expect.objectContaining({ recordType: 'APPROVAL_DENIED', payload: expect.objectContaining({ reason: 'ROLE' }) }));
  });
});

describe('승인 실행과 1·2인 차례', () => {
  test('시스템 잘못 환불은 cs_lead 1인이 승인하면 DONE이고 환급 실행을 한 번 부른다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제 기록 확인' }));
    const r = await approve(lead, created['approvalId'] as string);
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ status: 'DONE', approvals: [ACCOUNTS.lead] });
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0]).toMatchObject({ approvalId: created['approvalId'], kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333 });
    expect(auditTypes()).toEqual(expect.arrayContaining(['APPROVAL_REQUESTED', 'APPROVAL_APPROVED', 'APPROVAL_EXECUTING', 'APPROVAL_DONE']));
  });

  test('canApprove는 종류·역할·상태·이미 표를 낸 사람으로 가른다 [ASVS v5.0.0-8.2.1]', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const one = json(await request(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '1인' }));
    expect(json(await get(lead, one['approvalId'] as string))).toMatchObject({ canApprove: true });
    expect(json(await get(commander, one['approvalId'] as string))).toMatchObject({ canApprove: false });
    expect(json(await get(requester, one['approvalId'] as string))).toMatchObject({ canApprove: false });

    const two = json(await waiver(requester, order, 310_000));
    expect(json(await get(lead, two['approvalId'] as string))).toMatchObject({ canApprove: true });
    expect(json(await get(commander, two['approvalId'] as string))).toMatchObject({ canApprove: true });
    expect((await approve(lead, two['approvalId'] as string)).statusCode).toBe(200);
    expect(json(await get(lead, two['approvalId'] as string))).toMatchObject({ canApprove: false, status: 'PENDING_APPROVAL' });
    expect(json(await get(commander, two['approvalId'] as string))).toMatchObject({ canApprove: true });
    expect((await approve(commander, two['approvalId'] as string)).statusCode).toBe(200);
    expect(json(await get(commander, two['approvalId'] as string))).toMatchObject({ canApprove: false, status: 'DONE' });
  });

  test('재량 면제 2인은 cs_lead 한 표로 끝나지 않고 commander가 두 번째로 승인해야 DONE이다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await waiver(requester, order, 310_000, { reasonCode: 'BEREAVEMENT', reasonText: '사망 사실 확인' }));
    const first = await approve(lead, created['approvalId'] as string);
    expect(json(first)).toMatchObject({ status: 'PENDING_APPROVAL', approvals: [ACCOUNTS.lead] });
    expect(refundCalls).toHaveLength(0);
    const second = await approve(commander, created['approvalId'] as string);
    expect(json(second)).toMatchObject({ status: 'DONE', approvals: [ACCOUNTS.lead, ACCOUNTS.commander] });
    expect(refundCalls).toHaveLength(1);
  });

  test('같은 사람이 두 번 승인해도 한 표만 남고 끝나지 않는다 [ASVS v5.0.0-2.3.4]', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await waiver(requester, order, 310_000, { reasonCode: 'BEREAVEMENT', reasonText: '사망' }));
    expect((await approve(lead, created['approvalId'] as string)).statusCode).toBe(200);
    expect((await approve(lead, created['approvalId'] as string)).statusCode).toBe(409);
    expect(refundCalls).toHaveLength(0);
  });

  test('반려하면 REJECTED와 사유가 남고 실행하지 않는다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    const r = await reject(lead, created['approvalId'] as string, '증빙이 부족합니다');
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ status: 'REJECTED', closeReason: '증빙이 부족합니다' });
    expect(refundCalls).toHaveLength(0);
    expect(auditTypes()).toContain('APPROVAL_REJECTED');
  });

  test('실행이 실패하면 FAILED·CS 건을 남기고, 같은 승인 ID로 다시 승인하면 DONE·건을 닫는다 [ASVS v5.0.0-2.3.4]', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    let attempt = 0;
    const flaky = {
      refund: async (i: Record<string, unknown>) => {
        refundCalls.push(i);
        attempt += 1;
        if (attempt === 1) throw new Error('purchase down');
        return { status: 'REFUNDED' as const, cancellationId: randomUUID(), refundAmount: i['amount'] as number };
      },
      reclaim: executors.reclaim,
    };
    const c = { now: () => wall, monotonicMs: () => wall, advance: (ms: number) => { wall += ms; } };
    const local = await createService({
      name: 'ops-svc',
      module: AppModule.register({ memory: true, auditChain: new MemoryAuditChain(), approvals: { reauth: new TestReauth(), lifecycle: { targets, executors: flaky, notifier, alerts, failureCases } } as never }),
      env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: INTERNAL },
      clock: c,
      logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
      adminAuthz: identity,
    });
    try {
      const created = json(await local.http.inject({ method: 'POST', url: '/v1/ops/approval-requests', headers: headers(requester), payload: JSON.stringify({ kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }) }));
      const id = created['approvalId'] as string;
      const first = await local.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${id}/approvals`, headers: headers(lead, reauth(lead), 1), payload: '{}' });
      expect(first.statusCode).toBeGreaterThanOrEqual(500);
      const after = await local.http.inject({ method: 'GET', url: `/v1/ops/approval-requests/${id}`, headers: lead });
      expect(json(after)).toMatchObject({ status: 'FAILED' });
      expect(failedCases).toEqual([expect.objectContaining({ approvalId: id, kind: 'SYSTEM_FAULT_REFUND' })]);
      const retry = await local.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${id}/approvals`, headers: headers(lead, reauth(lead), 2), payload: '{}' });
      expect(retry.statusCode).toBe(200);
      expect(json(retry)).toMatchObject({ status: 'DONE' });
      expect(refundCalls.map((x) => x['approvalId'])).toEqual([id, id]);
      expect(succeededCases).toEqual([id]);
    } finally {
      await local.close();
    }
  });

  test('승인 본문의 reason은 1,000자를 넘을 수 없다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    const r = await approve(lead, created['approvalId'] as string, '가'.repeat(1_001));
    expect(r.statusCode).toBe(400);
  });
});

describe('R-T29 ①② 승인 업무 철회', () => {
  test('R-T29 ① 요청자가 사유를 적어 거두면 WITHDRAWN·사유·감사가 남고 승인할 수 없다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    const r = await withdraw(requester, created['approvalId'] as string, '결제자가 취소를 원하지 않습니다');
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ status: 'WITHDRAWN', closeReason: '결제자가 취소를 원하지 않습니다' });
    expect((await approve(lead, created['approvalId'] as string)).statusCode).toBe(409);
    expect(refundCalls).toHaveLength(0);
    expect(auditTypes()).toContain('APPROVAL_WITHDRAWN');
  });

  test('R-T29 ② 요청자가 아닌 사람이 거두려 하면 403이고 상태가 그대로다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    const r = await withdraw(lead, created['approvalId'] as string, '내가 거둔다');
    expect(r.statusCode).toBe(403);
    expect(json(await get(requester, created['approvalId'] as string))).toMatchObject({ status: 'PENDING_APPROVAL' });
  });

  test('이미 철회한 요청을 다시 철회하면 200이고 처음 사유 그대로다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    await withdraw(requester, created['approvalId'] as string, '처음 사유');
    const r = await withdraw(requester, created['approvalId'] as string, '두 번째 사유');
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ status: 'WITHDRAWN', closeReason: '처음 사유' });
  });

  test('승인·실행이 끝난 요청은 철회할 수 없다(409)', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    await approve(lead, created['approvalId'] as string);
    expect((await withdraw(requester, created['approvalId'] as string, '늦은 철회')).statusCode).toBe(409);
  });

  test('철회하면 1영업일 상위 알림을 다시 열지 않는다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await waiver(requester, order, 310_000, { reasonCode: 'BEREAVEMENT', reasonText: '사망' }));
    wall = NOW + 2 * 86_400_000;
    await withdraw(requester, created['approvalId'] as string, '요청자 철회');
    await tick();
    expect(escalated).toHaveLength(0);
  });
});

describe('R-T29 ③④⑤ 만료·대상 변경·경계', () => {
  const reclaim = (ref: string, o: { entryStartsAtMs: number; targetAccountId?: string }) => {
    basis.set(`TRANSFER_RECLAIM:${ref}`, { targetAccountId: o.targetAccountId ?? randomUUID(), entryStartsAtMs: o.entryStartsAtMs });
  };

  test('R-T29 ③ 양도 회수 요청이 승인 대기인 채 입장이 시작되면 tick이 EXPIRED(TARGET_CHANGED)로 끝내고 요청자·승인 역할에 알린다 [ASVS v5.0.0-2.3.3]', async () => {
    const ticket = randomUUID();
    const entry = KST('2026-12-10T18:00:00');
    reclaim(ticket, { entryStartsAtMs: entry });
    const created = json(await request(lead, { kind: 'TRANSFER_RECLAIM', targetRef: ticket, amount: 0, reasonCode: 'ACCOUNT_TAKEOVER', reasonText: '받은 사람의 소명 기간이 지남' }));
    wall = entry;
    const r = await tick();
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ expired: 1 });
    const after = json(await get(lead, created['approvalId'] as string));
    expect(after).toMatchObject({ status: 'EXPIRED', closeReason: 'TARGET_CHANGED' });
    expect(notified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ approvalId: created['approvalId'], event: 'EXPIRED', recipient: { kind: 'ACCOUNT', accountId: ACCOUNTS.lead } }),
        expect.objectContaining({ approvalId: created['approvalId'], event: 'EXPIRED', recipient: { kind: 'ROLE', role: 'commander' } }),
      ]),
    );
    expect(reclaimCalls).toHaveLength(0);
    expect(auditTypes()).toContain('APPROVAL_EXPIRED');
  });

  test('R-T29 ⑤ 입장 시작 1초 뒤 승인하면 409 approval-target-changed이고 회수 호출이 0이다', async () => {
    const ticket = randomUUID();
    const entry = KST('2026-12-10T18:00:00');
    reclaim(ticket, { entryStartsAtMs: entry });
    const created = json(await request(lead, { kind: 'TRANSFER_RECLAIM', targetRef: ticket, amount: 0, reasonCode: 'ACCOUNT_TAKEOVER', reasonText: '소명 기간 지남' }));
    wall = entry + 1_000;
    const r = await approve(commander, created['approvalId'] as string);
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('approval-target-changed') });
    expect(reclaimCalls).toHaveLength(0);
    expect(json(await get(lead, created['approvalId'] as string))).toMatchObject({ status: 'EXPIRED', closeReason: 'TARGET_CHANGED' });
  });

  test('양도 회수는 요청 + 1일 경계 전에는 승인할 수 없고 정각부터 승인할 수 있다', async () => {
    const ticket = randomUUID();
    reclaim(ticket, { entryStartsAtMs: KST('2026-12-10T18:00:00') });
    const created = json(await request(lead, { kind: 'TRANSFER_RECLAIM', targetRef: ticket, amount: 0, reasonCode: 'ACCOUNT_TAKEOVER', reasonText: '소명 기한 경계' }));
    wall = NOW + 86_400_000 - 1;
    expect((await approve(commander, created['approvalId'] as string)).statusCode).toBe(409);
    wall = NOW + 86_400_000;
    const ok = await approve(commander, created['approvalId'] as string);
    expect(ok.statusCode).toBe(200);
    expect(json(ok)).toMatchObject({ status: 'DONE' });
    expect(reclaimCalls).toHaveLength(1);
  });

  test('대상이 바뀌었으면 승인 직전에 409 approval-target-changed이고 상태가 EXPIRED가 된다', async () => {
    const order = randomUUID();
    const payer = randomUUID();
    orderBasis(order, payer);
    const created = json(await request(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    changedByRef.set(`SYSTEM_FAULT_REFUND:${order}`, 'TARGET_CHANGED');
    const r = await approve(lead, created['approvalId'] as string);
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('approval-target-changed') });
    expect(refundCalls).toHaveLength(0);
    expect(json(await get(requester, created['approvalId'] as string))).toMatchObject({ status: 'EXPIRED', closeReason: 'TARGET_CHANGED' });
  });

  test('기한 경계: dueAt 1ms 전은 승인되고 dueAt 정각은 409 approval-expired다', async () => {
    const orderA = randomUUID();
    const orderB = randomUUID();
    const due = KST('2026-12-03T10:00:00');
    basis.set(`SYSTEM_FAULT_REFUND:${orderA}`, { targetAccountId: randomUUID(), dueAtMs: due });
    basis.set(`SYSTEM_FAULT_REFUND:${orderB}`, { targetAccountId: randomUUID(), dueAtMs: due });
    const a = json(await request(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: orderA, amount: 10_000, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '경계 전' }));
    const b = json(await request(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: orderB, amount: 10_000, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '경계' }));
    wall = due - 1;
    expect((await approve(lead, a['approvalId'] as string)).statusCode).toBe(200);
    wall = due;
    expect((await approve(lead, b['approvalId'] as string)).statusCode).toBe(409);
    expect(refundCalls).toHaveLength(1);
  });
});

describe('1영업일 무응답 상위 알림', () => {
  test('1영업일 경계 전에는 그대로, 정각에 ESCALATED·경보 한 번이고 다시 돌아도 두 번 열지 않는다 [ASVS v5.0.0-2.3.3]', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await waiver(requester, order, 310_000, { reasonCode: 'BEREAVEMENT', reasonText: '사망' }));
    wall = KST('2026-11-27T10:00:00') - 1;
    await tick();
    expect(json(await get(lead, created['approvalId'] as string))).toMatchObject({ status: 'PENDING_APPROVAL' });
    expect(escalated).toHaveLength(0);
    wall = KST('2026-11-27T10:00:00');
    expect(json(await tick())).toMatchObject({ escalated: 1 });
    expect(json(await get(lead, created['approvalId'] as string))).toMatchObject({ status: 'ESCALATED' });
    expect(escalated).toEqual([expect.objectContaining({ approvalId: created['approvalId'], kind: 'APPROVAL_ESCALATED', recipient: { kind: 'ROLE', role: 'commander' } })]);
    await tick();
    expect(escalated).toHaveLength(1);
    expect(auditTypes()).toContain('APPROVAL_ESCALATED');
  });

  test('ESCALATED에서 첫 승인을 하면 PENDING_APPROVAL로 돌아가고, 두 번째 승인으로 끝난다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await waiver(requester, order, 310_000, { reasonCode: 'BEREAVEMENT', reasonText: '사망' }));
    wall = KST('2026-11-27T10:00:00');
    await tick();
    const first = await approve(lead, created['approvalId'] as string);
    expect(json(first)).toMatchObject({ status: 'PENDING_APPROVAL' });
    const second = await approve(commander, created['approvalId'] as string);
    expect(json(second)).toMatchObject({ status: 'DONE' });
  });

  test('ESCALATED에서도 요청자는 철회할 수 있다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await waiver(requester, order, 310_000, { reasonCode: 'BEREAVEMENT', reasonText: '사망' }));
    wall = KST('2026-11-27T10:00:00');
    await tick();
    expect((await withdraw(requester, created['approvalId'] as string, 'ESCALATED 철회')).statusCode).toBe(200);
  });
});

describe('요청 본문·대상·내부 경계', () => {
  test('사유 코드·사유 글이 없으면 400 invalid-body이고 승인 업무를 만들지 않는다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const r = await requestRaw(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333 });
    expect(r.statusCode).toBe(400);
  });

  test('없는 주문은 404 not-found이고 승인 업무를 만들지 않는다', async () => {
    const r = await requestRaw(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: randomUUID(), amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '없는 주문' });
    expect(r.statusCode).toBe(404);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('not-found') });
  });

  test('미성년자 계약 취소는 증빙 확인 사실이 없으면 422 approval-evidence-required다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const r = await requestRaw(requester, { kind: 'MINOR_CONTRACT_CANCEL', targetRef: order, amount: 33_333, reasonCode: 'MINOR', reasonText: '미성년자 계약 취소' });
    expect(r.statusCode).toBe(422);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('approval-evidence-required') });
    const ok = await request(requester, { kind: 'MINOR_CONTRACT_CANCEL', targetRef: order, amount: 33_333, reasonCode: 'MINOR', reasonText: '미성년자 계약 취소', evidenceChecked: 'PHONE_VERIFICATION' });
    expect(json(ok)).toMatchObject({ evidenceChecked: 'PHONE_VERIFICATION' });
  });

  test('일반 요청 경로가 받지 않는 종류는 모두 422 approval-kind-not-allowed다 [ASVS v5.0.0-8.2.1]', async () => {
    for (const kind of ['PAYOUT_BATCH', 'SETTLEMENT_ADJUSTMENT', 'COMMANDER_ROLE_CHANGE', 'CONTRACT_TERMS_CHANGE', 'SALE_SUSPENSION', 'SALE_RESUMPTION', 'FRAUD_ACTION', 'BOOKING_RESTRICTION']) {
      const r = await requestRaw(lead, { kind, targetRef: randomUUID(), amount: 0, reasonCode: 'X', reasonText: 'X' });
      expect(r.statusCode, kind).toBe(422);
      expect(json(r), kind).toMatchObject({ type: expect.stringContaining('approval-kind-not-allowed') });
    }
  });

  test('요청 역할이 아닌 사람이 요청하면 403이다(양도 회수를 cs_agent가 요청)', async () => {
    const ticket = randomUUID();
    basis.set(`TRANSFER_RECLAIM:${ticket}`, { targetAccountId: randomUUID(), entryStartsAtMs: KST('2026-12-10T18:00:00') });
    const r = await requestRaw(requester, { kind: 'TRANSFER_RECLAIM', targetRef: ticket, amount: 0, reasonCode: 'ACCOUNT_TAKEOVER', reasonText: '남의 요청' });
    expect(r.statusCode).toBe(403);
  });

  test('R-T26 ② 재량 면제의 증빙은 확인한 종류만 남고 파일·내용 칸은 받지 않는다', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await request(requester, { kind: 'DISCRETIONARY_WAIVER', targetRef: order, amount: 290_000, reasonCode: 'ILLNESS', reasonText: '진단서 확인', evidenceChecked: 'DOCUMENT:진단서' }));
    expect(created).toMatchObject({ evidenceChecked: 'DOCUMENT:진단서' });
    expect(created).not.toHaveProperty('evidenceFile');
    const bad = await requestRaw(requester, { kind: 'DISCRETIONARY_WAIVER', targetRef: order, amount: 290_000, reasonCode: 'ILLNESS', reasonText: '파일 첨부', evidenceFile: 'base64...' });
    expect(bad.statusCode).toBe(400);
  });

  test('결제자 계정(target_account_id)은 응답·감사·로그에 나오지 않는다 [ASVS v5.0.0-16.3.2]', async () => {
    const order = randomUUID();
    const payer = randomUUID();
    orderBasis(order, payer);
    const created = json(await request(requester, { kind: 'SYSTEM_FAULT_REFUND', targetRef: order, amount: 33_333, reasonCode: 'DUPLICATE_PAYMENT', reasonText: '중복 결제' }));
    const view = await get(lead, created['approvalId'] as string);
    expect(view.payload).not.toContain(payer);
    expect(view.payload).not.toContain('targetAccountId');
    expect(JSON.stringify(audit.entries)).not.toContain(payer);
    expect(logLines.join('\n')).not.toContain(payer);
  });

  test('내부 tick은 토큰이 없거나 틀리면 403이고 상태를 바꾸지 않는다 [ASVS v5.0.0-8.3.1]', async () => {
    const order = randomUUID();
    orderBasis(order, randomUUID());
    const created = json(await waiver(requester, order, 310_000, { reasonCode: 'BEREAVEMENT', reasonText: '사망' }));
    wall = KST('2026-11-27T10:00:00');
    for (const token of [undefined, 'wrong-token']) {
      const r = await tick(token);
      expect(r.statusCode).toBe(403);
    }
    expect(json(await get(lead, created['approvalId'] as string))).toMatchObject({ status: 'PENDING_APPROVAL' });
    expect(escalated).toHaveLength(0);
    expect((await tick()).statusCode).toBe(200);
    expect(json(await get(lead, created['approvalId'] as string))).toMatchObject({ status: 'ESCALATED' });
  });
});
