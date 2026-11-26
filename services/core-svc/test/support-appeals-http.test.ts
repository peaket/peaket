// F-06-4 core-svc support 소명 접수·목록·화면 사본 시험(시험 담당, 2026-11-26).
// 정본: docs/features/transfer-refund.md §7.1, openapi /v1/appeals·/v1/booking-restrictions/me·/v1/fraud-appeal-requests, docs/data.md appeal·sup:rst·sup:far.
// 값은 정본에서 가져오고 코드 상수와 같게 고르지 않는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { ACTIVE_VIEW, FRAUD_VIEW, NOW_MS, problemType, submit, supportHarness, type SupportHarness } from './support-appeal-support.js';

let h: SupportHarness;
const items = (b: Record<string, unknown>): Array<Record<string, unknown>> => b.items as Array<Record<string, unknown>>;
beforeAll(async () => {
  h = await supportHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  h.calls.length = 0;
  h.notices.length = 0;
  h.answer({ status: 200, body: { result: 'OBJECTED' } });
});

describe('R-T32 소명 접수', () => {
  test('R-T32 ① 예매 제한 소명은 appeal 행·support.cases-requested 한 건(category RESTRICTION)을 남긴다', async () => {
    const accountId = randomUUID();
    const restrictionId = randomUUID();
    const r = await submit(h, { accountId, kind: 'RESTRICTION', targetId: restrictionId });
    expect(r.body).toMatchObject({ kind: 'RESTRICTION', targetId: restrictionId, status: 'SUBMITTED' });
    expect(r.location).toBe(`/v1/appeals/${String(r.body.appealId)}`);

    const rows = h.kit().outbox.rows();
    expect(rows.filter((x) => x.sourceId === r.body.appealId)).toHaveLength(1);
    expect(rows.find((x) => x.sourceId === r.body.appealId)).toMatchObject({ kind: 'APPEAL', category: 'RESTRICTION', eventKey: r.body.appealId });

    const internal = await h.internalGet(String(r.body.appealId));
    expect(internal.status).toBe(200);
    expect(internal.body).toMatchObject({ accountId, kind: 'RESTRICTION', targetId: restrictionId, status: 'SUBMITTED' });
    expect(String(internal.body.body)).toContain('사정을 설명합니다');
  });

  test('R-T32 ① 부정 예매 사건 소명은 category FRAUD_CASE로 한 건을 남긴다', async () => {
    const r = await submit(h, { accountId: randomUUID(), kind: 'FRAUD_CASE', targetId: randomUUID() });
    expect(r.body).toMatchObject({ kind: 'FRAUD_CASE', status: 'SUBMITTED' });
    expect(h.kit().outbox.rows().find((x) => x.sourceId === r.body.appealId)).toMatchObject({ kind: 'APPEAL', category: 'FRAUD_CASE' });
  });

  test('R-T32 ② 부정 예매 입구가 403이면 대상 아님으로 닫고 팬에게 한 번 알린다(다시 보내도 0)', async () => {
    const accountId = randomUUID();
    const caseId = randomUUID();
    await h.kit().views.fraud.apply(FRAUD_VIEW({ accountId, caseId, party: 'PAYER' }));
    const r = await submit(h, { accountId, kind: 'FRAUD_CASE', targetId: caseId });
    h.answer({ status: 403 });
    await h.dispatch();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ method: 'POST', path: `/internal/v1/fraud-cases/${caseId}/appeals` });
    expect(h.calls[0]!.md['x-peaket-caller']).toBe('core-svc');
    expect(h.calls[0]!.body).toMatchObject({ appealId: r.body.appealId, accountId, party: 'PAYER' });

    const mine = await h.myAppeals(h.fanHeaders(accountId));
    expect(mine.body.items).toEqual([expect.objectContaining({ appealId: r.body.appealId, status: 'INVALID' })]);
    expect(h.notices.filter((n) => n.appealId === r.body.appealId)).toEqual([expect.objectContaining({ event: 'INVALID', accountId })]);
    await h.dispatch();
    expect(h.calls).toHaveLength(1);
  });

  test('R-T32 ③ 부정 예매 입구가 200 {result:EXPIRED}면 기한 경과로 닫고 알린다', async () => {
    const accountId = randomUUID();
    const caseId = randomUUID();
    await h.kit().views.fraud.apply(FRAUD_VIEW({ accountId, caseId }));
    const r = await submit(h, { accountId, kind: 'FRAUD_CASE', targetId: caseId });
    h.answer({ status: 200, body: { result: 'EXPIRED' } });
    await h.dispatch();
    const mine = await h.myAppeals(h.fanHeaders(accountId));
    expect(items(mine.body)[0]).toMatchObject({ appealId: r.body.appealId, status: 'INVALID' });
    expect(h.notices.filter((n) => n.appealId === r.body.appealId)).toEqual([expect.objectContaining({ event: 'INVALID' })]);
  });

  test('R-T32 ③ 입구가 503이면 SUBMITTED로 두고 다음 바퀴 다시 보낸다(성공하면 그대로 SUBMITTED)', async () => {
    const accountId = randomUUID();
    const caseId = randomUUID();
    await h.kit().views.fraud.apply(FRAUD_VIEW({ accountId, caseId }));
    const r = await submit(h, { accountId, kind: 'FRAUD_CASE', targetId: caseId });
    h.answer({ status: 503 });
    await h.dispatch();
    expect(items((await h.myAppeals(h.fanHeaders(accountId))).body)[0]).toMatchObject({ appealId: r.body.appealId, status: 'SUBMITTED' });
    h.answer({ status: 200, body: { result: 'OBJECTED' } });
    await h.dispatch();
    expect(h.calls).toHaveLength(2);
    expect(items((await h.myAppeals(h.fanHeaders(accountId))).body)[0]).toMatchObject({ appealId: r.body.appealId, status: 'SUBMITTED' });
  });

  test('R-T32 ⑦ 받은 사람(HOLDER) 사본에는 사유 범주·잠금·우선 구매·이의 칸이 없고 가진 표만 있다', async () => {
    const accountId = randomUUID();
    const caseId = randomUUID();
    const held = [randomUUID(), randomUUID()];
    await h.kit().views.fraud.apply(FRAUD_VIEW({ accountId, caseId, party: 'HOLDER', heldTicketIds: held }));
    const r = await h.fraudAppeals(h.fanHeaders(accountId));
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([
      expect.objectContaining({
        caseId,
        party: 'HOLDER',
        heldTicketIds: held,
        reasonCategories: [],
        lockActive: false,
        lockExpiresAt: null,
        objectionDueAt: null,
        objectionStatus: 'NONE',
        priorityPurchases: [],
        actionResult: null,
      }),
    ]);
  });

  test('R-T32 ⑥ 받은 사람 표시가 있는 사건 소명은 입구로 party HOLDER를 보낸다', async () => {
    const accountId = randomUUID();
    const caseId = randomUUID();
    await h.kit().views.fraud.apply(FRAUD_VIEW({ accountId, caseId, party: 'HOLDER' }));
    await submit(h, { accountId, kind: 'FRAUD_CASE', targetId: caseId });
    await h.dispatch();
    expect(h.calls[0]!.body).toMatchObject({ party: 'HOLDER' });
  });

  test('R-T32 ① 예매 제한 화면 사본의 소명 기한이 지났으면 409 appeal-deadline-passed다', async () => {
    const accountId = randomUUID();
    const restrictionId = randomUUID();
    await h.kit().views.restriction.apply({ ...ACTIVE_VIEW({ accountId, restrictionId }), appealDueAtMs: NOW_MS - 1 });
    const r = await h.post(h.fanHeaders(accountId), { kind: 'RESTRICTION', targetId: restrictionId, body: '늦게 냈습니다-시험7733' });
    expect(r.status).toBe(409);
    expect(problemType(r.body)).toBe('appeal-deadline-passed');
  });
});

describe('내 예매 제한·사본 조회', () => {
  test('R-T13 GET /v1/booking-restrictions/me는 없으면 NONE, 있으면 코드·기한·ID를 주고 LIFTED면 NONE이다', async () => {
    const accountId = randomUUID();
    const hdrs = h.fanHeaders(accountId);
    expect((await h.restriction(hdrs)).body).toEqual({ status: 'NONE' });

    const view = ACTIVE_VIEW({ accountId });
    await h.kit().views.restriction.apply(view);
    const active = await h.restriction(hdrs);
    expect(active.status).toBe(200);
    expect(active.headers['cache-control']).toBe('private, no-store');
    expect(active.body).toMatchObject({ status: 'ACTIVE', restrictionId: view.restrictionId, reasonCode: 'ABUSE_CANCEL' });
    expect(active.body.appealDueAt).toBe(new Date(view.appealDueAtMs).toISOString());

    await h.kit().views.restriction.apply({ ...view, state: 'LIFTED', version: 2 });
    expect((await h.restriction(hdrs)).body).toEqual({ status: 'NONE' });
  });

  test('ASVS v5.0.0-8.2.2 소명 목록은 내 것만 최근 제출 순으로 주고 본문은 싣지 않는다', async () => {
    const me = randomUUID();
    const other = randomUUID();
    const a = await submit(h, { accountId: me, kind: 'RESTRICTION', targetId: randomUUID(), body: '내 첫 소명-시험7734' });
    h.clock.advance(1_000);
    const b = await submit(h, { accountId: me, kind: 'FRAUD_CASE', targetId: randomUUID(), body: '내 둘째 소명-시험7735' });
    await submit(h, { accountId: other, kind: 'RESTRICTION', targetId: randomUUID() });
    const r = await h.myAppeals(h.fanHeaders(me));
    expect(r.status).toBe(200);
    expect(items(r.body).map((x) => x.appealId)).toEqual([b.body.appealId, a.body.appealId]);
    expect(JSON.stringify(r.body)).not.toContain('내 첫 소명');
    expect(r.headers['cache-control']).toBe('private, no-store');
  });
});

describe('ASVS 경계', () => {
  test('ASVS v5.0.0-2.2.1·2.2.2 받지 않는 종류·빈 글·2,001자·모르는 칸·남의 targetId는 400·422다', async () => {
    const accountId = randomUUID();
    const hdrs = h.fanHeaders(accountId);
    const wrongKind = await h.post(hdrs, { kind: 'RECLAIM', targetId: randomUUID(), body: '사정-시험7736' });
    expect([wrongKind.status, problemType(wrongKind.body)]).toEqual([422, 'appeal-kind-not-supported']);
    const empty = await h.post(hdrs, { kind: 'RESTRICTION', targetId: randomUUID(), body: '' });
    expect(empty.status).toBe(400);
    const long = await h.post(hdrs, { kind: 'RESTRICTION', targetId: randomUUID(), body: '가'.repeat(2_001) });
    expect(long.status).toBe(400);
    const extra = await h.post(hdrs, { kind: 'RESTRICTION', targetId: randomUUID(), body: '사정-시험7737', accountId: randomUUID() });
    expect(extra.status).toBe(400);
    const noTarget = await h.post(hdrs, { kind: 'RESTRICTION', body: '사정-시험7738' });
    expect(noTarget.status).toBe(400);
  });

  test('ASVS v5.0.0-14.2.1·14.2.2 예매 제한·부정 예매 사본 조회도 private, no-store다', async () => {
    const accountId = randomUUID();
    await h.kit().views.fraud.apply(FRAUD_VIEW({ accountId }));
    expect((await h.fraudAppeals(h.fanHeaders(accountId))).headers['cache-control']).toBe('private, no-store');
    expect((await h.restriction(h.fanHeaders(accountId))).headers['cache-control']).toBe('private, no-store');
  });

  test('ASVS v5.0.0-8.2.1·8.3.1 내부 소명·결과 경로는 내부 토큰이 없거나 틀리면 401이다', async () => {
    const r = await submit(h, { accountId: randomUUID(), kind: 'RESTRICTION', targetId: randomUUID() });
    for (const token of [null, 'wrong-token']) {
      expect((await h.internalGet(String(r.body.appealId), token)).status).toBe(401);
      expect((await h.internalResult(String(r.body.appealId), { status: 'INVALID' }, token)).status).toBe(401);
    }
  });

  test('ASVS v5.0.0-15.4.2 같은 결과를 다시 쓰면 같은 답, 다른 결과는 409 appeal-result-conflict다', async () => {
    const r = await submit(h, { accountId: randomUUID(), kind: 'RESTRICTION', targetId: randomUUID() });
    const first = await h.internalResult(String(r.body.appealId), { status: 'INVALID', reason: 'NOT_TARGET' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'INVALID' });
    expect((await h.internalResult(String(r.body.appealId), { status: 'INVALID', reason: 'NOT_TARGET' })).status).toBe(200);
    const conflict = await h.internalResult(String(r.body.appealId), { status: 'DECIDED', result: 'LIFTED' });
    expect([conflict.status, problemType(conflict.body)]).toEqual([409, 'appeal-result-conflict']);
  });

  test('ASVS v5.0.0-16.3.2·16.5.3 없는 소명은 404 Problem 모양이고 요청 로그에 남는다', async () => {
    await submit(h, { accountId: randomUUID(), kind: 'RESTRICTION', targetId: randomUUID() });
    const r = await h.internalGet(randomUUID());
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ status: 404, title: expect.any(String) });
    expect(h.logs.text()).toContain('404');
  });
});
