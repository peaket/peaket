// J-T36 ①·④ 정산서 수기 조정의 2인 승인(ops 쪽, F-07-5 LCH-100, ADR-0368 결정 7·8, POL-038 ⑦, docs/features/settlement.md §4.3·§13 J-T36).
// cs_lead가 요청하면 202 승인 업무(SETTLEMENT_ADJUSTMENT, 대상 = 정산서, 금액·사유 코드, 정족수 2)와 payment 조정 행 PENDING이 생긴다.
// 요청자 본인·cs_lead·재인증 없는 commander의 승인은 403이고, 다른 commander가 act=APPROVAL 재인증 뒤 승인하면 payment 적용을 부른다.
// payment는 승인 ID를 믿지 않고 GET /internal/v1/approval-requests/{approvalId}로 사실을 대조하므로, 적용 중에 그 경로가 주는 사실도 본다.
import { ProblemError } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { HttpPayoutPaymentClient } from '../src/modules/payouts/index.js';
import { SettlementAdjustmentApprovals } from '../src/modules/approvals/index.js';
import { opsSettlementFlow, type OpsRole, type OpsSettlementFlow } from './settlement-flow-support.js';

const NOW = Date.parse('2026-11-19T06:00:00.000Z');
let f: OpsSettlementFlow;
beforeEach(async () => {
  f = await opsSettlementFlow(NOW);
});
afterEach(async () => {
  await f.close();
  vi.unstubAllGlobals();
});

const STATEMENT = '0194c000-0000-7000-8000-00000000f075';
const BODY = { amount: -1_000_000, reasonCode: 'AGREED_DEDUCTION', evidenceNote: '파트너와 합의한 차감(합의서 2026-11-18)' };
const requestAdj = (headers: Record<string, string>, body: unknown = BODY, statementId = STATEMENT) =>
  f.svc.http.inject({ method: 'POST', url: `/v1/ops/settlements/${statementId}/adjustments`, headers, payload: JSON.stringify(body) });
const approve = (id: string, headers: Record<string, string>) => f.svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${id}/approvals`, headers });
const reject = (id: string, headers: Record<string, string>, reason: string) => f.svc.http.inject({ method: 'POST', url: `/v1/ops/approval-requests/${id}/rejections`, headers, payload: JSON.stringify({ reason }) });
const facts = (id: string) => f.svc.http.inject({ method: 'GET', url: `/internal/v1/approval-requests/${id}` });
const view = (id: string, headers: Record<string, string>) => f.svc.http.inject({ method: 'GET', url: `/v1/ops/approval-requests/${id}`, headers });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

/** cs_lead 요청 하나를 만들고 그 계정·승인 ID를 돌려준다 */
const requested = async () => {
  const lead = f.headers('cs_lead', { idempotencyKey: randomUUID() });
  const res = await requestAdj(lead);
  expect(res.statusCode, res.payload).toBe(202);
  return { lead, approvalId: json(res).approvalId as string };
};

describe('J-T36 ① 요청', () => {
  test('[ASVS v5.0.0-8.2.1] J-T36 ① cs_lead 요청은 202 승인 업무와 payment 조정 행 하나를 만들고 같은 멱등 키 재요청은 같은 승인 업무다', async () => {
    const key = randomUUID();
    const lead = f.headers('cs_lead', { idempotencyKey: key });
    const res = await requestAdj(lead);
    expect(res.statusCode, res.payload).toBe(202);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = json(res);
    expect(body).toMatchObject({ kind: 'SETTLEMENT_ADJUSTMENT', targetRef: STATEMENT, status: 'PENDING_APPROVAL', requiredApprovals: 2 });
    expect(body.approvalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(f.payments.registered).toEqual([{ statementId: STATEMENT, input: { approvalId: body.approvalId, amount: -1_000_000, reasonCode: 'AGREED_DEDUCTION', evidenceNote: BODY.evidenceNote, requestedBy: lead['x-user-id'] } }]);
    expect(f.store.rows.get(body.approvalId as string)).toMatchObject({ statementId: STATEMENT, amount: -1_000_000, reasonCode: 'AGREED_DEDUCTION', requestedBy: lead['x-user-id'], status: 'PENDING_APPROVAL' });

    const again = await requestAdj(lead);
    expect(again.statusCode).toBe(202);
    expect(json(again).approvalId).toBe(body.approvalId);
    expect(f.store.rows.size).toBe(1);
    expect(f.payments.registered).toHaveLength(1);
  });

  test('J-T36 ① cs_agent·viewer·operator·commander의 요청은 403이고 승인 업무·조정 행이 0이다', async () => {
    for (const role of ['cs_agent', 'viewer', 'operator', 'commander'] as const satisfies readonly OpsRole[]) {
      const res = await requestAdj(f.headers(role, { idempotencyKey: randomUUID() }));
      expect({ role, code: res.statusCode }).toEqual({ role, code: 403 });
    }
    expect(f.store.rows.size).toBe(0);
    expect(f.payments.registered).toEqual([]);
  });

  test('J-T36 ① Idempotency-Key가 없으면 거절하고, payment가 검사에서 거절(422)하면 승인 업무를 만들지 않는다', async () => {
    const noKey = await requestAdj(f.headers('cs_lead'));
    expect(noKey.statusCode).toBeGreaterThanOrEqual(400);
    expect(noKey.statusCode).toBeLessThan(500);
    f.payments.failNext.register = new ProblemError({ type: 'settlement-adjustment-dispute-mismatch', status: 422, title: '그 정산서의 열린 이의가 아닙니다' });
    const refused = await requestAdj(f.headers('cs_lead', { idempotencyKey: randomUUID() }), { amount: 10_000, reasonCode: 'GROSS_AMOUNT', disputeId: randomUUID() });
    expect(refused.statusCode).toBe(422);
    expect(json(refused).type).toContain('settlement-adjustment-dispute-mismatch');
    expect(f.store.rows.size).toBe(0);
    f.payments.failNext.register = new ProblemError({ type: 'settlement-adjustment-not-allowed', status: 409, title: '지금 상태의 정산서는 조정할 수 없습니다' });
    expect((await requestAdj(f.headers('cs_lead', { idempotencyKey: randomUUID() }))).statusCode).toBe(409);
    expect(f.store.rows.size).toBe(0);
  });
});

describe('J-T36 ④ 승인', () => {
  test('[ASVS v5.0.0-2.3.3] J-T36 ④ 요청자 본인·cs_lead·재인증 없는 commander는 403이고 payment 적용이 없다', async () => {
    const { lead, approvalId } = await requested();
    const { 'content-type': _ct, ...leadNoBody } = lead;
    f.reauth.accountOf.set(lead['x-session-id']!, lead['x-user-id']!);
    expect((await approve(approvalId, { ...leadNoBody, 'x-reauth-token': 'approval-token' })).statusCode).toBe(403);
    expect((await approve(approvalId, f.headers('cs_lead', { reauth: true, json: false }))).statusCode).toBe(403);
    const noReauth = await approve(approvalId, f.headers('commander', { json: false }));
    expect(noReauth.statusCode).toBe(403);
    expect(noReauth.payload).toContain('reauth-required');
    for (const role of ['cs_agent', 'viewer', 'operator'] as const) expect({ role, code: (await approve(approvalId, f.headers(role, { reauth: true, json: false }))).statusCode }).toEqual({ role, code: 403 });
    expect(f.payments.applied).toEqual([]);
    expect(f.store.rows.get(approvalId)).toMatchObject({ status: 'PENDING_APPROVAL' });
  });

  test('J-T36 ④ 다른 commander가 재인증 뒤 승인하면 payment 적용을 부르고, payment가 읽는 사실은 EXECUTING·요청자≠승인자·정족수 2·승인 시각이다', async () => {
    const { lead, approvalId } = await requested();
    const commander = f.headers('commander', { reauth: true, json: false });
    const seenDuringApply: Record<string, unknown>[] = [];
    f.payments.onApply = async (id) => {
      const r = await facts(id);
      expect(r.statusCode).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      seenDuringApply.push(json(r));
    };
    const ok = await approve(approvalId, commander);
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(json(ok)).toMatchObject({ status: 'DONE' });
    expect(f.payments.applied).toEqual([approvalId]);
    // 근거 메모·요청자 역할은 싣지 않는다(ADR-0368 결정 8: 사실만)
    expect(seenDuringApply).toEqual([
      {
        approvalId,
        kind: 'SETTLEMENT_ADJUSTMENT',
        targetRef: STATEMENT,
        amount: -1_000_000,
        reasonCode: 'AGREED_DEDUCTION',
        status: 'EXECUTING',
        requiredApprovals: 2,
        requestedBy: lead['x-user-id'],
        approvals: [commander['x-user-id']],
        approvedAt: new Date(NOW).toISOString(),
      },
    ]);
    expect(json(await facts(approvalId))).toMatchObject({ status: 'DONE' });
  });

  test('J-T36 ④ payment가 503이면 승인 업무가 FAILED로 남고 같은 승인을 다시 부르면 다시 적용한다', async () => {
    const { approvalId } = await requested();
    const commander = f.headers('commander', { reauth: true, json: false });
    f.payments.failNext.apply = new ProblemError({ type: 'settlement-dependency-unavailable', status: 503, title: '정산 서비스에 연결하지 못했습니다' });
    expect((await approve(approvalId, commander)).statusCode).toBe(503);
    expect(f.store.rows.get(approvalId)).toMatchObject({ status: 'FAILED' });
    expect(f.payments.applied).toEqual([]);
    const retry = await approve(approvalId, commander);
    expect(retry.statusCode, retry.payload).toBe(200);
    expect(f.payments.applied).toEqual([approvalId]);
    expect(f.store.rows.get(approvalId)).toMatchObject({ status: 'DONE' });
  });

  test('J-T36 ④ payment가 대조 불일치로 409면 409 그대로이고 승인 업무는 FAILED다', async () => {
    const { approvalId } = await requested();
    f.payments.failNext.apply = new ProblemError({ type: 'settlement-adjustment-approval-amount-mismatch', status: 409, title: '승인한 조정 금액과 조정 행이 다릅니다' });
    const res = await approve(approvalId, f.headers('commander', { reauth: true, json: false }));
    expect(res.statusCode).toBe(409);
    expect(json(res).type).toContain('settlement-adjustment-approval-amount-mismatch');
    expect(f.store.rows.get(approvalId)).toMatchObject({ status: 'FAILED' });
  });

  test('J-T36 ⑤ 반려하면 REJECTED이고 payment 조정 행을 VOID로 닫으며 적용하지 않는다', async () => {
    const { approvalId } = await requested();
    const res = await reject(approvalId, f.headers('commander'), '근거 메모가 부족하다');
    expect(res.statusCode, res.payload).toBe(200);
    expect(f.store.rows.get(approvalId)).toMatchObject({ status: 'REJECTED' });
    expect(f.payments.voided).toEqual([approvalId]);
    expect(f.payments.applied).toEqual([]);
    expect(json(await facts(approvalId))).toMatchObject({ status: 'REJECTED' });
  });

  test('J-T36 ④ 내부 사실 경로는 없는 승인에 404·no-store이고, 승인 상세는 요청자와 commander만 본다', async () => {
    const missing = await facts(randomUUID());
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
    const { lead, approvalId } = await requested();
    const { 'content-type': _ct, ...leadNoBody } = lead;
    expect((await view(approvalId, leadNoBody)).statusCode).toBe(200);
    expect((await view(approvalId, f.headers('commander', { json: false }))).statusCode).toBe(200);
    for (const role of ['cs_lead', 'cs_agent', 'operator'] as const) expect({ role, code: (await view(approvalId, f.headers(role, { json: false }))).statusCode }).toEqual({ role, code: 404 });
  });
});

describe('J-T36 ①·④ 검증 보강(한 겹씩)', () => {
  // 검증 1(계획 §9.1)이 놓친 표본: 조정 요청의 역할 가드 두 겹(X-04·X-04c)과, 역할 검사에 가려진 요청자 본인 승인 금지(X-11b).
  test('[ASVS v5.0.0-8.2.1] J-T36 ① 경로 겹: cs_lead 밖 역할의 조정 요청은 경로 가드에서 막혀 유스케이스의 역할 거절까지 가지 않는다', async () => {
    for (const role of ['cs_agent', 'viewer', 'operator', 'commander'] as const satisfies readonly OpsRole[]) {
      const res = await requestAdj(f.headers(role, { idempotencyKey: randomUUID() }));
      expect({ role, code: res.statusCode }).toEqual({ role, code: 403 });
      // 경로 가드(플랫폼 RolesGuard)의 거절은 문제 종류 없는 403(about:blank)이다. 유스케이스 거절이면 approval-role-required가 된다
      expect({ role, type: json(res).type }).toEqual({ role, type: 'about:blank' });
    }
    expect(f.payments.registered).toEqual([]);
    expect(f.store.rows.size).toBe(0);
  });

  test('J-T36 ① 유스케이스 겹: 경로 가드 없이 직접 불러도 cs_lead 밖 역할의 요청은 403 approval-role-required이고 조정 행·승인 업무가 0이다', async () => {
    const adjustments = f.svc.app.get(SettlementAdjustmentApprovals);
    for (const role of ['cs_agent', 'viewer', 'operator', 'commander']) {
      await expect(adjustments.request(STATEMENT, { amount: BODY.amount, reasonCode: BODY.reasonCode, evidenceNote: BODY.evidenceNote }, randomUUID(), { accountId: randomUUID(), sessionId: randomUUID(), role })).rejects.toMatchObject({
        status: 403,
        type: expect.stringContaining('approval-role-required'),
      });
    }
    expect(f.payments.registered).toEqual([]);
    expect(f.store.rows.size).toBe(0);
  });

  test('[ASVS v5.0.0-2.3.3] J-T36 ④ 요청자 본인이 commander 세션으로 재인증해 승인해도 403 approval-self-not-allowed이고 적용이 없다', async () => {
    const { lead, approvalId } = await requested();
    const accountId = lead['x-user-id']!;
    const sessionId = randomUUID();
    f.identity.answers.set(`${accountId}/${sessionId}`, { valid: true, role: 'commander' });
    f.reauth.accountOf.set(sessionId, accountId);
    const res = await approve(approvalId, { 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': 'ops', 'x-user-scope': '', 'x-reauth-token': 'approval-token' });
    expect(res.statusCode).toBe(403);
    expect(json(res).type).toContain('approval-self-not-allowed');
    expect(f.payments.applied).toEqual([]);
    expect(f.store.rows.get(approvalId)).toMatchObject({ status: 'PENDING_APPROVAL' });
  });
});

describe('J-T36 ⑨ 반려·재승인과 적용의 엇갈림(리뷰 RV-04)', () => {
  // 정본 §4.3 '승인'(리뷰 반영으로 더함)·§13 J-T36 ⑨: 적용 응답을 받지 못한 FAILED를 반려할 때는 payment void를 먼저 부른다.
  // 이미 적용됐으면(409 settlement-adjustment-applied) 반려하지 않고 DONE으로 맞춘 뒤 409, payment가 답하지 않으면 503이고 FAILED 그대로다.
  // FAILED·EXECUTING을 다른 commander가 다시 승인하면 새 투표 없이 적용만 다시 부르고 조정 합계는 한 번만 바뀐다.
  const pumpUntil = async (cond: () => boolean) => {
    for (let i = 0; i < 1_000; i += 1) {
      if (cond()) return;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error('기다린 상태가 오지 않았다');
  };
  const votesOf = (id: string) => f.store.votes.filter((v) => v.approvalId === id);

  test('[ASVS v5.0.0-2.3.3] J-T36 ⑨ ① 적용 커밋 뒤 응답이 끊겨 FAILED인 승인을 반려하면 409이고 승인 업무는 DONE·조정 행은 APPLIED 그대로다', async () => {
    const { approvalId } = await requested();
    f.payments.loseNextApplyResponse = true;
    expect((await approve(approvalId, f.headers('commander', { reauth: true, json: false }))).statusCode).toBe(503);
    expect(f.store.rows.get(approvalId)).toMatchObject({ status: 'FAILED' });
    expect(f.payments.rows.get(approvalId)).toBe('APPLIED');
    const res = await reject(approvalId, f.headers('commander'), '근거가 부족하다');
    expect(res.statusCode, res.payload).toBe(409);
    expect(f.store.rows.get(approvalId)).toMatchObject({ status: 'DONE' });
    expect(f.payments.rows.get(approvalId)).toBe('APPLIED');
    expect(f.payments.effects.get(approvalId)).toBe(1);
    expect(JSON.parse((await facts(approvalId)).payload)).toMatchObject({ status: 'DONE' });
  });

  test('J-T36 ⑨ ② 응답이 끊긴 FAILED를 다른 commander가 재인증 뒤 다시 승인하면 투표를 더 쓰지 않고 DONE이며 조정 합계는 한 번만 바뀐다', async () => {
    const { approvalId } = await requested();
    f.payments.loseNextApplyResponse = true;
    expect((await approve(approvalId, f.headers('commander', { reauth: true, json: false }))).statusCode).toBe(503);
    expect(votesOf(approvalId)).toHaveLength(1);
    const retry = await approve(approvalId, f.headers('commander', { reauth: true, json: false }));
    expect(retry.statusCode, retry.payload).toBe(200);
    expect(f.store.rows.get(approvalId)).toMatchObject({ status: 'DONE' });
    expect(votesOf(approvalId)).toHaveLength(1);
    expect(f.payments.effects.get(approvalId)).toBe(1);
  });

  test('J-T36 ⑨ ② 적용 중(EXECUTING)에 다른 commander가 겹쳐 승인해도 새 투표 없이 같은 적용 길을 타고 조정 합계는 한 번이다', async () => {
    const { approvalId } = await requested();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    f.payments.onApply = async () => {
      calls += 1;
      if (calls === 1) await gate;
    };
    const first = approve(approvalId, f.headers('commander', { reauth: true, json: false }));
    await pumpUntil(() => f.store.rows.get(approvalId)?.status === 'EXECUTING' && calls === 1);
    const second = await approve(approvalId, f.headers('commander', { reauth: true, json: false }));
    release();
    await first;
    expect(second.statusCode, second.payload).toBe(200);
    expect(f.store.rows.get(approvalId)).toMatchObject({ status: 'DONE' });
    expect(votesOf(approvalId)).toHaveLength(1);
    expect(f.payments.effects.get(approvalId)).toBe(1);
  });

  test('J-T36 ⑨ ③ payment가 답하지 않으면 FAILED 승인의 반려는 503이고 승인 업무는 FAILED·조정 행은 PENDING 그대로다', async () => {
    const { approvalId } = await requested();
    f.payments.failNext.apply = new ProblemError({ type: 'settlement-dependency-unavailable', status: 503, title: '정산 서비스에 연결하지 못했습니다' });
    expect((await approve(approvalId, f.headers('commander', { reauth: true, json: false }))).statusCode).toBe(503);
    f.payments.failNext.void = new ProblemError({ type: 'settlement-dependency-unavailable', status: 503, title: '정산 서비스에 연결하지 못했습니다' });
    const res = await reject(approvalId, f.headers('commander'), '근거가 부족하다');
    expect(res.statusCode).toBe(503);
    expect(f.store.rows.get(approvalId)).toMatchObject({ status: 'FAILED' });
    expect(f.payments.rows.get(approvalId)).toBe('PENDING');
  });

  test('J-T36 ⑨ ④ 적용되지 않은 FAILED(대조 불일치 409)를 반려하면 REJECTED이고 조정 행은 VOID다', async () => {
    const { approvalId } = await requested();
    f.payments.failNext.apply = new ProblemError({ type: 'settlement-adjustment-approval-amount-mismatch', status: 409, title: '승인한 조정 금액과 조정 행이 다릅니다' });
    expect((await approve(approvalId, f.headers('commander', { reauth: true, json: false }))).statusCode).toBe(409);
    const res = await reject(approvalId, f.headers('commander'), '금액이 다르다');
    expect(res.statusCode, res.payload).toBe(200);
    expect(f.store.rows.get(approvalId)).toMatchObject({ status: 'REJECTED' });
    expect(f.payments.rows.get(approvalId)).toBe('VOID');
    expect(f.payments.effects.get(approvalId) ?? 0).toBe(0);
  });
});

describe('J-T36(어댑터) payment 내부 조정 경로', () => {
  test('J-T36 ① 등록·적용·반려는 payment 내부 경로를 부르고 4xx는 그대로, 5xx·연결 실패는 503이다', async () => {
    const seen: { url: string; body: unknown }[] = [];
    let reply: () => Response | Promise<Response> = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const req = new Request(input, init);
      seen.push({ url: req.url, body: await req.json().catch(() => null) });
      return reply();
    });
    const client = new HttpPayoutPaymentClient('http://payment-svc:8080', 'internal-token');
    const approvalId = randomUUID();
    const requestedBy = randomUUID();
    const row = { adjustmentId: randomUUID(), statementId: STATEMENT, approvalId, reasonCode: 'LEDGER_ERROR', disputeId: null, amount: -5_000, status: 'PENDING' };
    reply = () => new Response(JSON.stringify(row), { status: 201, headers: { 'content-type': 'application/json' } });
    await expect(client.registerAdjustment(STATEMENT, { approvalId, amount: -5_000, reasonCode: 'LEDGER_ERROR', evidenceNote: '원장 정정', requestedBy })).resolves.toMatchObject({ approvalId, status: 'PENDING' });
    reply = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    await client.applyAdjustment(approvalId);
    await client.voidAdjustment(approvalId);
    expect(seen.map((s) => s.url)).toEqual([
      `http://payment-svc:8080/internal/v1/settlements/statements/${STATEMENT}/adjustments`,
      `http://payment-svc:8080/internal/v1/settlements/adjustments/${approvalId}/application`,
      `http://payment-svc:8080/internal/v1/settlements/adjustments/${approvalId}/void`,
    ]);
    expect(seen[0]!.body).toEqual({ approvalId, amount: -5_000, reasonCode: 'LEDGER_ERROR', evidenceNote: '원장 정정', requestedBy });

    reply = () => new Response(JSON.stringify({ type: 'https://peaket.example/problems/settlement-adjustment-pending', status: 409, title: '적용 전 조정' }), { status: 409, headers: { 'content-type': 'application/problem+json' } });
    await expect(client.registerAdjustment(STATEMENT, { approvalId, amount: -5_000, reasonCode: 'LEDGER_ERROR', evidenceNote: '원장 정정', requestedBy })).rejects.toMatchObject({ status: 409 });
    reply = () => new Response('{}', { status: 502 });
    await expect(client.applyAdjustment(approvalId)).rejects.toMatchObject({ status: 503 });
    reply = () => Promise.reject(new TypeError('fetch failed'));
    await expect(client.applyAdjustment(approvalId)).rejects.toMatchObject({ status: 503 });
  });
});
