// 받는 층: 관제 파트너사·계약(openapi /v1/ops/promoters*, BAT-615 LCH-070, ADR-0320).
// J-T29 ①~⑤·⑦~⑨의 core 쪽 판정을 메모리 저장소로 본다. 2인 승인·재인증 판정은 ops-svc 시험이 맡고,
// 여기서는 ops가 승인·반려·철회 뒤 부르는 내부 적용·취소 경로와 core의 계약 기간·현재 값·대기 표시를 확인한다.
import 'reflect-metadata';
import { createService, fakeClock, ProblemError } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import { MemoryCatalogRepository as Repository } from '../src/modules/catalog/index.js';
import type { OpsApprovalClient } from '../src/modules/catalog/index.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';

/** ops 승인 업무 생성 대역. 실제 ops-svc 시험은 contract-approval.test.ts가 맡는다 */
class RecordingOpsApprovals implements OpsApprovalClient {
  readonly requests: Parameters<OpsApprovalClient['createContractTermsChange']>[0][] = [];
  failNext = 0;

  async createContractTermsChange(input: Parameters<OpsApprovalClient['createContractTermsChange']>[0]) {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: 'ops를 부를 수 없습니다' });
    }
    this.requests.push(input);
    return { approvalId: input.approvalId, status: 'PENDING_APPROVAL', requestedAt: new Date(NOW_MS).toISOString() };
  }
}

const identity = new FakeIdentity();
const ops = new RecordingOpsApprovals();
let repo: MemoryCatalogRepository;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  repo = new Repository();
  svc = await createService({
    name: 'core-svc-ops-promoter',
    module: AppModule.register({ memory: true, catalog: repo, opsApprovals: ops }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});
beforeEach(() => {
  repo.promoters.clear();
  repo.promoterContracts.clear();
  repo.sellerNames.clear();
  ops.requests.length = 0;
  ops.failNext = 0;
});

const headers = (role: 'viewer' | 'operator' | 'commander' | 'cs_agent' | 'cs_lead' = 'operator', extra: Record<string, string> = {}) => ({
  ...identity.ops(role),
  ...(extra['idempotency-key'] ? {} : {}),
  ...extra,
});
const withJson = (h: Record<string, string>, idem = randomUUID()): Record<string, string> => ({ ...h, 'content-type': 'application/json', 'idempotency-key': idem });
const withoutBody = (h: Record<string, string>): Record<string, string> => {
  const copy = { ...h };
  delete copy['content-type'];
  return copy;
};

const BODY = { legalName: '별밤컴퍼니', commissionRateBp: 875, guaranteeRateBp: 700, guaranteeKind: 'PERFORMANCE_BOND' as const };

const create = (h = headers('operator'), body: Record<string, unknown> = BODY, idem = randomUUID()) =>
  svc.http.inject({ method: 'POST', url: '/v1/ops/promoters', headers: withJson(h, idem), payload: JSON.stringify(body) });
const list = (role: Parameters<typeof headers>[0] = 'operator', qs = '') => svc.http.inject({ method: 'GET', url: `/v1/ops/promoters${qs}`, headers: withoutBody(headers(role)) });
const detail = (promoterId: string, role: Parameters<typeof headers>[0] = 'operator') => svc.http.inject({ method: 'GET', url: `/v1/ops/promoters/${promoterId}`, headers: withoutBody(headers(role)) });
const terms = (promoterId: string, role: Parameters<typeof headers>[0] = 'operator', qs = '') =>
  svc.http.inject({ method: 'GET', url: `/v1/ops/promoters/${promoterId}/contract-terms${qs}`, headers: withoutBody(headers(role)) });
const change = (promoterId: string, body: Record<string, unknown>, role: Parameters<typeof headers>[0] = 'operator', idem = randomUUID()) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/promoters/${promoterId}/contract-term-changes`, headers: withJson(headers(role), idem), payload: JSON.stringify(body) });
const apply = (promoterId: string, approvalId: string, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: `/internal/v1/promoters/${promoterId}/contract-approvals/${approvalId}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const cancel = (promoterId: string, approvalId: string) =>
  svc.http.inject({ method: 'POST', url: `/internal/v1/promoters/${promoterId}/contract-approvals/${approvalId}/cancellations`, headers: { 'content-type': 'application/json' }, payload: '{}' });

async function created(): Promise<{ promoterId: string; approvalId?: string }> {
  const r = await create();
  expect(r.statusCode).toBe(201);
  return JSON.parse(r.payload) as { promoterId: string; approvalId?: string };
}

const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const text = (r: { payload: string }) => r.payload;

/** 응답 어디에도 결제사 내부 ID·계좌 원문이 없어야 한다(J-T29 ⑧, ASVS 8.2.3) */
const leaking = (payload: string): string[] =>
  ['accountNumber', 'bankAccount', 'tossSellerId', 'portonePartnerId', 'sellerId', 'accountHolder', '사업자등록번호', '계좌번호'].filter((needle) => payload.includes(needle));

const APPROVED_AT = new Date(NOW_MS + 90 * 60_000).toISOString();

describe('J-T29 ① 파트너 등록과 첫 계약', () => {
  test('J-T29 ①_등록은_첫_계약을_만들고_목록·상세·이력이_같은_값을_준다', async () => {
    const r = await create();
    expect(r.statusCode).toBe(201);
    const body = json(r);
    expect(body).toMatchObject({
      legalName: '별밤컴퍼니',
      pendingContractApprovalId: null,
      seller: null,
      verifiedAt: null,
      payoutAccount: null,
      pgRegistration: { tossSellers: [], portonePartnerRegistered: false },
      contract: { commissionRateBp: 875, guaranteeRateBp: 700, guaranteeKind: 'PERFORMANCE_BOND', validFrom: new Date(NOW_MS).toISOString(), validUntil: null, approvalId: null },
    });
    const promoterId = body.promoterId as string;

    const listed = await list();
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(json(listed).items).toEqual([{ promoterId, legalName: '별밤컴퍼니', commissionRateBp: 875, guaranteeRateBp: 700, contractChangePending: false }]);

    const one = await detail(promoterId);
    expect(one.statusCode).toBe(200);
    expect(one.headers['cache-control']).toBe('no-store');
    expect(json(one).contract).toEqual(body.contract);

    const history = await terms(promoterId);
    expect(history.statusCode).toBe(200);
    expect(history.headers['cache-control']).toBe('no-store');
    expect(json(history)).toEqual({ items: [body.contract], nextCursor: null });
  });

  test('J-T29 ①_같은_Idempotency_Key_재요청은_파트너를_두_번_만들지_않는다', async () => {
    const key = randomUUID();
    const operator = headers('operator');
    const first = await create(operator, BODY, key);
    const second = await create(operator, BODY, key);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const a = json(first);
    const b = json(second);
    expect(b.promoterId).toBe(a.promoterId);
    expect(json(await list()).items).toHaveLength(1);
    expect(repo.promoterContracts.get(a.promoterId as string)).toHaveLength(1);
  });

  test('J-T29 ①_같은_키에_다른_본문을_보내면_422이고_파트너는_하나다', async () => {
    const key = randomUUID();
    const operator = headers('operator');
    expect((await create(operator, BODY, key)).statusCode).toBe(201);
    const different = await create(operator, { ...BODY, legalName: '다른회사' }, key);
    expect(different.statusCode).toBe(422);
    expect(json(different).type).toContain('idempotency-key-reused');
    expect(json(await list()).items).toHaveLength(1);
  });

  test('J-T29 ①_등록_본문도_닫힌_스키마와_bp_경계를_지킨다', async () => {
    for (const body of [
      { ...BODY, legalName: '' },
      { ...BODY, commissionRateBp: 10_001 },
      { ...BODY, guaranteeRateBp: -1 },
      { ...BODY, guaranteeKind: 'CASH' },
      { ...BODY, unknown: true },
    ]) {
      expect((await create(headers('operator'), body)).statusCode).toBe(400);
    }
    expect(json(await list()).items).toHaveLength(0);
  });
});

describe('J-T29 ② 계약 변경 요청과 core 적용', () => {
  test('[ASVS v5.0.0-2.3.3] J-T29 ②_변경_요청은_202이고_승인_적용은_새_기간과_현재_값을_남긴다', async () => {
    const { promoterId } = await created();
    const asked = await change(promoterId, { commissionRateBp: 900, guaranteeRateBp: 650, reason: '계약 갱신' });
    expect(asked.statusCode).toBe(202);
    const approval = json(asked);
    expect(approval).toMatchObject({
      kind: 'CONTRACT_TERMS_CHANGE',
      targetRef: promoterId,
      reasonText: '계약 갱신',
      requiredApprovals: 2,
      status: 'PENDING_APPROVAL',
      canApprove: false,
      requestedBy: { role: 'operator' },
      contractTerms: {
        current: { commissionRateBp: 875, guaranteeRateBp: 700, guaranteeKind: 'PERFORMANCE_BOND', validFrom: new Date(NOW_MS).toISOString() },
        requestedCommissionRateBp: 900,
        requestedGuaranteeRateBp: 650,
        requestedGuaranteeKind: 'PERFORMANCE_BOND',
      },
    });
    const approvalId = approval.approvalId as string;
    expect(ops.requests).toHaveLength(1);
    expect(ops.requests[0]).toMatchObject({ approvalId, promoterId, requested: { commissionRateBp: 900, guaranteeRateBp: 650, guaranteeKind: 'PERFORMANCE_BOND' } });

    expect(json(await detail(promoterId))).toMatchObject({ pendingContractApprovalId: approvalId, contract: { commissionRateBp: 875, validUntil: null } });
    expect(json(await list()).items).toEqual([expect.objectContaining({ contractChangePending: true })]);

    const applied = await apply(promoterId, approvalId, { commissionRateBp: 900, guaranteeRateBp: 650, approvedAt: APPROVED_AT, approverId: randomUUID() });
    expect(applied.statusCode).toBe(200);
    expect(json(applied)).toEqual({ applied: true, validFrom: APPROVED_AT });

    const now = json(await detail(promoterId));
    expect(now).toMatchObject({
      pendingContractApprovalId: null,
      contract: { commissionRateBp: 900, guaranteeRateBp: 650, guaranteeKind: 'PERFORMANCE_BOND', validFrom: APPROVED_AT, validUntil: null, approvalId },
    });
    expect(json(await list()).items).toEqual([expect.objectContaining({ commissionRateBp: 900, guaranteeRateBp: 650, contractChangePending: false })]);

    const periods = json(await terms(promoterId)).items as Record<string, unknown>[];
    expect(periods).toHaveLength(2);
    expect(periods[0]).toMatchObject({ commissionRateBp: 900, guaranteeRateBp: 650, validFrom: APPROVED_AT, validUntil: null, approvalId });
    expect(periods[1]).toMatchObject({ commissionRateBp: 875, guaranteeRateBp: 700, validFrom: new Date(NOW_MS).toISOString(), validUntil: APPROVED_AT, approvalId: null });
    expect(periods[1]!.validUntil).toBe(periods[0]!.validFrom);
  });

  test('[ASVS v5.0.0-2.3.3] J-T29 ⑨_같은_승인_ID를_다시_적용해도_기간이_두_번_생기지_않는다', async () => {
    const { promoterId } = await created();
    const approvalId = json(await change(promoterId, { commissionRateBp: 900, reason: '멱등 확인' })).approvalId as string;
    const body = { commissionRateBp: 900, approvedAt: APPROVED_AT, approverId: randomUUID() };
    expect((await apply(promoterId, approvalId, body)).statusCode).toBe(200);
    const again = await apply(promoterId, approvalId, body);
    expect(again.statusCode).toBe(200);
    expect(json(again)).toEqual({ applied: true, validFrom: APPROVED_AT });
    expect((json(await terms(promoterId)).items as unknown[]).length).toBe(2);
    expect(json(await detail(promoterId)).contract).toMatchObject({ commissionRateBp: 900, approvalId });
  });

  test('J-T29 ②_승인_시각이_옛_기간_끝과_새_기간_시작에_정확히_같다', async () => {
    const { promoterId } = await created();
    const asked = await change(promoterId, { guaranteeRateBp: 0, reason: '보증 0bp 경계' }, 'operator');
    expect(asked.statusCode).toBe(202);
    const approvalId = json(asked).approvalId as string;
    const boundary = new Date(NOW_MS + 1).toISOString();
    expect((await apply(promoterId, approvalId, { guaranteeRateBp: 0, approvedAt: boundary, approverId: randomUUID() })).statusCode).toBe(200);
    const [current, previous] = json(await terms(promoterId)).items as Record<string, unknown>[];
    expect(previous!.validUntil).toBe(boundary);
    expect(current!.validFrom).toBe(boundary);
    expect(current!.guaranteeRateBp).toBe(0);
  });
});

describe('J-T29 ② RV-03 계약 변경 요청의 Idempotency-Key', () => {
  test('J-T29 ②_RV-03_키가_없거나_UUID가_아니면_400이고_예약·승인_업무를_만들지_않는다', async () => {
    const { promoterId } = await created();
    const payload = JSON.stringify({ commissionRateBp: 900, reason: '키 없음' });
    for (const h of [
      { ...identity.ops('operator'), 'content-type': 'application/json' },
      { ...identity.ops('operator'), 'content-type': 'application/json', 'idempotency-key': 'not-a-uuid' },
    ]) {
      const r = await svc.http.inject({ method: 'POST', url: `/v1/ops/promoters/${promoterId}/contract-term-changes`, headers: h, payload });
      expect(r.statusCode, r.payload).toBe(400);
      expect(json(r).type).toContain('idempotency-key-invalid');
    }
    expect(ops.requests).toHaveLength(0);
    expect(json(await detail(promoterId))).toMatchObject({ pendingContractApprovalId: null });
    expect((json(await terms(promoterId)).items as unknown[]).length).toBe(1);
  });

  test('J-T29 ②_RV-03_같은_키_같은_본문_재요청은_같은_202와_같은_답이고_새_변경_행이_없다', async () => {
    const { promoterId } = await created();
    const key = randomUUID();
    const body = { commissionRateBp: 900, reason: '같은 키 재시도' };
    const first = await change(promoterId, body, 'operator', key);
    const second = await change(promoterId, body, 'operator', key);
    expect(first.statusCode, first.payload).toBe(202);
    expect(second.statusCode, second.payload).toBe(202);
    expect(json(second).approvalId).toBe(json(first).approvalId);
    expect(json(second)).toEqual(json(first));
    expect(ops.requests).toHaveLength(1);
    expect(json(await detail(promoterId))).toMatchObject({ pendingContractApprovalId: json(first).approvalId });
    expect((json(await terms(promoterId)).items as unknown[]).length).toBe(1);
  });

  test('J-T29 ②_RV-03_같은_키에_다른_본문은_422이고_새_업무를_만들지_않는다', async () => {
    const { promoterId } = await created();
    const key = randomUUID();
    expect((await change(promoterId, { commissionRateBp: 900, reason: '첫 본문' }, 'operator', key)).statusCode).toBe(202);
    const different = await change(promoterId, { commissionRateBp: 925, reason: '다른 본문' }, 'operator', key);
    expect(different.statusCode, different.payload).toBe(422);
    expect(json(different).type).toContain('idempotency-key-reused');
    expect(ops.requests).toHaveLength(1);
  });
});

describe('J-T29 ③ 열린 변경 하나와 취소', () => {
  test('[ASVS v5.0.0-2.3.4] J-T29 ④_같은_파트너의_두_번째_변경_요청은_409다', async () => {
    const { promoterId } = await created();
    expect((await change(promoterId, { commissionRateBp: 900, reason: '첫 요청' })).statusCode).toBe(202);
    const second = await change(promoterId, { commissionRateBp: 950, reason: '두 번째 요청' });
    expect(second.statusCode).toBe(409);
    expect(json(second).type).toContain('contract-change-pending');
    expect(ops.requests).toHaveLength(1);
  });

  test('J-T29 ③_반려·철회로_취소하면_계약은_그대로이고_새_요청을_받는다', async () => {
    const { promoterId } = await created();
    const approvalId = json(await change(promoterId, { commissionRateBp: 900, reason: '반려될 요청' })).approvalId as string;
    expect((await cancel(promoterId, approvalId)).statusCode).toBe(200);
    expect(json(await detail(promoterId))).toMatchObject({ pendingContractApprovalId: null, contract: { commissionRateBp: 875, validUntil: null } });
    expect((json(await terms(promoterId)).items as unknown[]).length).toBe(1);
    // 같은 승인 ID로 다시 취소해도 성공한다(ops가 반려·철회를 두 번 보내도 같다)
    expect((await cancel(promoterId, approvalId)).statusCode).toBe(200);

    const again = await change(promoterId, { commissionRateBp: 925, reason: '다시 요청' });
    expect(again.statusCode).toBe(202);
    expect(json(again).approvalId).not.toBe(approvalId);
  });

  test('J-T29 ③_ops를_부르지_못하면_503이고_대기_표시를_남기지_않는다', async () => {
    const { promoterId } = await created();
    ops.failNext = 1;
    const failed = await change(promoterId, { commissionRateBp: 900, reason: 'ops 장애' });
    expect(failed.statusCode).toBe(503);
    expect(json(failed).type).toContain('dependency-unavailable');
    expect(json(await detail(promoterId))).toMatchObject({ pendingContractApprovalId: null, contract: { commissionRateBp: 875 } });
    expect((await change(promoterId, { commissionRateBp: 900, reason: '다시 요청' })).statusCode).toBe(202);
  });
});

describe('J-T29 ⑤ 변경 요청 입력 검증', () => {
  test('J-T29 ⑤_바꿀_칸이_없거나_범위_밖·사유가_틀리면_400이나_422이고_행이_남지_않는다', async () => {
    const { promoterId } = await created();
    const bad: [Record<string, unknown>, number][] = [
      [{ reason: '바꿀 칸 없음' }, 422],
      [{ commissionRateBp: 875, guaranteeRateBp: 700, guaranteeKind: 'PERFORMANCE_BOND', reason: '지금과 같음' }, 422],
      [{ commissionRateBp: 10_001, reason: '위쪽 경계 밖' }, 400],
      [{ commissionRateBp: -1, reason: '아래쪽 경계 밖' }, 400],
      [{ guaranteeRateBp: 10_001, reason: '보증 위쪽 경계 밖' }, 400],
      [{ guaranteeKind: 'BOND', reason: '보증 종류 밖' }, 400],
      [{ commissionRateBp: 900 }, 400],
      [{ commissionRateBp: 900, reason: '가'.repeat(2_001) }, 400],
      [{ commissionRateBp: 900, reason: '모르는 칸', surprise: true }, 400],
    ];
    for (const [body, status] of bad) {
      const r = await change(promoterId, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(status);
    }
    expect(ops.requests).toHaveLength(0);
    expect(json(await detail(promoterId))).toMatchObject({ pendingContractApprovalId: null, contract: { commissionRateBp: 875 } });
    expect((json(await terms(promoterId)).items as unknown[]).length).toBe(1);
  });

  test('J-T29 ⑤_bp_경계_0과_10000은_받는다', async () => {
    const a = await created();
    expect((await change(a.promoterId, { commissionRateBp: 0, reason: '0bp 경계' })).statusCode).toBe(202);
    const b = await created();
    expect((await change(b.promoterId, { guaranteeRateBp: 10_000, reason: '10000bp 경계' })).statusCode).toBe(202);
    const c = await created();
    const zero = await change(c.promoterId, { commissionRateBp: 0, reason: '0bp 적용' });
    expect((await apply(c.promoterId, json(zero).approvalId as string, { commissionRateBp: 0, approvedAt: APPROVED_AT, approverId: randomUUID() })).statusCode).toBe(200);
    expect(json(await detail(c.promoterId)).contract).toMatchObject({ commissionRateBp: 0 });
  });

  test('J-T29 ⑤_검색어_101자와_limit_경계_밖은_400이다', async () => {
    await created();
    expect((await list('operator', `?q=${'가'.repeat(101)}`)).statusCode).toBe(400);
    expect((await list('operator', '?limit=101')).statusCode).toBe(400);
    expect((await list('operator', '?limit=0')).statusCode).toBe(400);
    expect((await list('operator', '?limit=1')).statusCode).toBe(200);
  });
});

describe('J-T29 ⑧ 역할과 응답 노출', () => {
  test('[ASVS v5.0.0-8.2.2] J-T29 ⑧_viewer는_목록·상세·이력·변경_요청에서_403이다', async () => {
    const { promoterId } = await created();
    expect((await list('viewer')).statusCode).toBe(403);
    expect((await detail(promoterId, 'viewer')).statusCode).toBe(403);
    expect((await terms(promoterId, 'viewer')).statusCode).toBe(403);
    expect((await change(promoterId, { commissionRateBp: 900, reason: 'viewer' }, 'viewer')).statusCode).toBe(403);
    expect((await create(headers('viewer'))).statusCode).toBe(403);
  });

  test('[ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.2.3] J-T29 ⑧_CS는_읽기_200이고_payoutAccount가_null이며_민감_원문이_없다', async () => {
    const { promoterId } = await created();
    for (const role of ['cs_agent', 'cs_lead'] as const) {
      const listed = await list(role);
      const one = await detail(promoterId, role);
      const history = await terms(promoterId, role);
      expect(listed.statusCode).toBe(200);
      expect(one.statusCode).toBe(200);
      expect(history.statusCode).toBe(200);
      expect(one.headers['cache-control']).toBe('no-store');
      expect(history.headers['cache-control']).toBe('no-store');
      expect(json(one).payoutAccount).toBeNull();
      expect(json(one).pgRegistration).toEqual({ tossSellers: [], portonePartnerRegistered: false });
      for (const r of [listed, one, history]) expect(leaking(text(r))).toEqual([]);
      // CS는 변경 요청을 할 수 없다(읽기 전용)
      expect((await change(promoterId, { commissionRateBp: 900, reason: 'CS' }, role)).statusCode).toBe(403);
    }
  });

  test('J-T29 ⑧_없는_파트너는_403이나_500이_아니라_404다', async () => {
    const missing = randomUUID();
    expect((await detail(missing)).statusCode).toBe(404);
    expect((await terms(missing)).statusCode).toBe(404);
    const changed = await change(missing, { commissionRateBp: 900, reason: '없는 파트너' });
    expect(changed.statusCode).toBe(404);
    expect(json(changed).type).toContain('not-found');
  });

  test('J-T29 ⑧_신원이_없으면_401이다', async () => {
    const { promoterId } = await created();
    expect((await svc.http.inject({ method: 'GET', url: '/v1/ops/promoters' })).statusCode).toBe(401);
    expect((await svc.http.inject({ method: 'GET', url: `/v1/ops/promoters/${promoterId}` })).statusCode).toBe(401);
  });
});

describe('J-T29 ② commander 변경 요청', () => {
  test('J-T29 ②_commander도_변경을_요청할_수_있다', async () => {
    const { promoterId } = await created();
    const r = await change(promoterId, { commissionRateBp: 900, reason: 'commander 요청' }, 'commander');
    expect(r.statusCode).toBe(202);
    expect(json(r).requestedBy).toMatchObject({ role: 'commander' });
  });
});

describe('J-T33 지금 계약 조건 내부 조회(BAT-630)', () => {
  test('J-T33 payment-svc가 부르는 내부 경로가 보증 비율·종류를 주고 없는 파트너는 404다', async () => {
    const { promoterId } = await created();
    const r = await svc.http.inject({ method: 'GET', url: `/internal/v1/promoters/${promoterId}/contract` });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ commissionRateBp: 875, guaranteeRateBp: 700, guaranteeKind: 'PERFORMANCE_BOND' });
    const missing = await svc.http.inject({ method: 'GET', url: `/internal/v1/promoters/${randomUUID()}/contract` });
    expect(missing.statusCode).toBe(404);
  });
});
