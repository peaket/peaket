// F-06-4 core-svc support 소명 접수·목록·화면 사본 시험(시험 담당 lane2-freeze-F-06-4-reviewfix, 시험 리뷰 TR-03·TR-04·TR-05·TR-13·TR-20·TR-21·TR-22·TR-27 반영).
// 정본: docs/features/transfer-refund.md §7.1, openapi /v1/appeals·/v1/booking-restrictions/me·/v1/fraud-appeal-requests, docs/data.md appeal·sup:rst·sup:far.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ACTIVE_VIEW, FRAUD_VIEW, NOW_MS, problemType, submit, supportHarness, type SupportHarness } from './support-appeal-support.js';

let h: SupportHarness;
const items = (b: Record<string, unknown>): Array<Record<string, unknown>> => b.items as Array<Record<string, unknown>>;
beforeEach(async () => {
  h = await supportHarness();
});
afterEach(async () => {
  await h?.close();
});

describe('R-T32 소명 접수', () => {
  test('R-T32 ① 예매 제한 소명은 appeal 행·support.cases-requested 한 건(category RESTRICTION)을 남기고 본문·계정·제한 ID는 Outbox에 싣지 않는다', async () => {
    const accountId = randomUUID();
    const restrictionId = randomUUID();
    const r = await submit(h, { accountId, kind: 'RESTRICTION', targetId: restrictionId });
    expect(r.body).toMatchObject({ kind: 'RESTRICTION', targetId: restrictionId, status: 'SUBMITTED' });
    expect(r.location).toBe(`/v1/appeals/${String(r.body.appealId)}`);

    const rows = h.kit().outbox.rows().filter((x) => x.sourceId === r.body.appealId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'APPEAL', category: 'RESTRICTION', eventKey: r.body.appealId });
    for (const leak of ['body', 'accountId', 'targetId', 'restrictionId', 'email', 'phone']) expect(rows[0]).not.toHaveProperty(leak);

    const internal = await h.internalGet(String(r.body.appealId));
    expect(internal.status).toBe(200);
    expect(internal.body).toMatchObject({ accountId, kind: 'RESTRICTION', targetId: restrictionId, status: 'SUBMITTED' });
    expect(String(internal.body.body)).toContain('사정을 설명합니다');
  });

  test('R-T32 ① 부정 예매 사건 소명은 category FRAUD_CASE로 한 건을 남긴다', async () => {
    const accountId = randomUUID();
    const caseId = randomUUID();
    const dueAtMs = NOW_MS + 2 * 86_400_000;
    await h.kit().views.fraud.apply(FRAUD_VIEW({ accountId, caseId, dueAtMs }));
    const r = await submit(h, { accountId, kind: 'FRAUD_CASE', targetId: caseId });
    expect(r.body).toMatchObject({ kind: 'FRAUD_CASE', status: 'SUBMITTED' });
    const row = h.kit().outbox.rows().find((x) => x.sourceId === r.body.appealId);
    expect(row).toMatchObject({ kind: 'APPEAL', category: 'FRAUD_CASE' });
    // IR-08: CS 건 기한은 사건의 소명 기한(dueAt)에서 센다
    expect(row?.dueBaseAt).toBe(new Date(dueAtMs).toISOString());
    expect(row).not.toHaveProperty('body');
  });

  test('R-T32 ② 부정 예매 입구가 403이면 대상 아님으로 닫고 팬에게 한 번 알린다(다시 보내도 0)', async () => {
    const accountId = randomUUID();
    const caseId = randomUUID();
    await h.kit().views.fraud.apply(FRAUD_VIEW({ accountId, caseId, party: 'PAYER' }));
    const r = await submit(h, { accountId, kind: 'FRAUD_CASE', targetId: caseId });
    h.answer({ status: 403 });
    await h.dispatch();
    const entrance = h.calls.filter((c) => c.path === `/internal/v1/fraud-cases/${caseId}/appeals`);
    expect(entrance).toHaveLength(1);
    expect(entrance[0]).toMatchObject({ method: 'POST' });
    expect(entrance[0]!.md['x-peaket-caller']).toBe('core-svc');
    expect(entrance[0]!.md['x-peaket-internal-token']).toBe('support-internal-token-000000');
    expect(entrance[0]!.body).toMatchObject({ appealId: r.body.appealId, accountId, party: 'PAYER' });
    // IR-07: 대상 아님으로 닫힌 소명은 ops CS 건·보류도 닫게 알린다
    const invalid = h.calls.filter((c) => c.path === `/internal/v1/cs-cases/appeals/${String(r.body.appealId)}/invalid`);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.body).toMatchObject({ reason: '대상 아님' });

    const mine = await h.myAppeals(h.fanHeaders(accountId));
    expect(items(mine.body)[0]).toMatchObject({ appealId: r.body.appealId, status: 'INVALID' });
    expect(h.notices.filter((n) => n.appealId === r.body.appealId)).toEqual([expect.objectContaining({ event: 'INVALID', accountId })]);
    await h.dispatch();
    expect(h.calls.filter((c) => c.path === `/internal/v1/fraud-cases/${caseId}/appeals`)).toHaveLength(1);
    expect(h.calls.filter((c) => c.path === `/internal/v1/cs-cases/appeals/${String(r.body.appealId)}/invalid`)).toHaveLength(1);
  });

  test('R-T32 ② 부정 예매 입구가 404여도 대상 아님으로 닫는다', async () => {
    const accountId = randomUUID();
    const caseId = randomUUID();
    await h.kit().views.fraud.apply(FRAUD_VIEW({ accountId, caseId }));
    const r = await submit(h, { accountId, kind: 'FRAUD_CASE', targetId: caseId });
    h.answer({ status: 404 });
    await h.dispatch();
    expect(items((await h.myAppeals(h.fanHeaders(accountId))).body)[0]).toMatchObject({ appealId: r.body.appealId, status: 'INVALID' });
    expect(h.notices.filter((n) => n.appealId === r.body.appealId)).toHaveLength(1);
  });

  test('R-T32 ③ 부정 예매 입구가 200 {result:EXPIRED}면 기한 경과로 닫고 알린다', async () => {
    const accountId = randomUUID();
    const caseId = randomUUID();
    await h.kit().views.fraud.apply(FRAUD_VIEW({ accountId, caseId }));
    const r = await submit(h, { accountId, kind: 'FRAUD_CASE', targetId: caseId });
    h.answer({ status: 200, body: { result: 'EXPIRED' } });
    await h.dispatch();
    expect(items((await h.myAppeals(h.fanHeaders(accountId))).body)[0]).toMatchObject({ appealId: r.body.appealId, status: 'INVALID' });
    expect(h.notices.filter((n) => n.appealId === r.body.appealId)).toEqual([expect.objectContaining({ event: 'INVALID' })]);
  });

  test('R-T32 ③ 입구가 503이면 1분 전에는 다시 보내지 않고 1분 뒤에 한 번, 실패가 이어지면 10분 뒤에 다시 보낸다', async () => {
    const accountId = randomUUID();
    const caseId = randomUUID();
    await h.kit().views.fraud.apply(FRAUD_VIEW({ accountId, caseId }));
    const r = await submit(h, { accountId, kind: 'FRAUD_CASE', targetId: caseId });
    h.answer({ status: 503 });
    await h.dispatch();
    expect(h.calls).toHaveLength(1);
    expect(items((await h.myAppeals(h.fanHeaders(accountId))).body)[0]).toMatchObject({ appealId: r.body.appealId, status: 'SUBMITTED' });

    h.clock.advance(60_000 - 1);
    await h.dispatch();
    expect(h.calls).toHaveLength(1);
    h.clock.advance(1);
    await h.dispatch();
    expect(h.calls).toHaveLength(2);

    // 두 번째 실패 뒤 다음은 10분이다
    h.clock.advance(600_000 - 1);
    await h.dispatch();
    expect(h.calls).toHaveLength(2);
    h.clock.advance(1);
    await h.dispatch();
    expect(h.calls).toHaveLength(3);
    expect(items((await h.myAppeals(h.fanHeaders(accountId))).body)[0]).toMatchObject({ appealId: r.body.appealId, status: 'SUBMITTED' });
  });

  test('R-T32 ③ 토큰이 틀린 입구는 401이고 SUBMITTED로 남아 1분 뒤 다시 보낸다', async () => {
    const wrong = await supportHarness({ token: 'wrong-token' });
    try {
      const accountId = randomUUID();
      const caseId = randomUUID();
      await wrong.kit().views.fraud.apply(FRAUD_VIEW({ accountId, caseId }));
      const r = await submit(wrong, { accountId, kind: 'FRAUD_CASE', targetId: caseId });
      await wrong.dispatch();
      expect(wrong.calls).toHaveLength(1);
      expect(wrong.calls[0]!.md['x-peaket-internal-token']).toBe('wrong-token');
      expect(items((await wrong.myAppeals(wrong.fanHeaders(accountId))).body)[0]).toMatchObject({ appealId: r.body.appealId, status: 'SUBMITTED' });
      wrong.clock.advance(60_000);
      await wrong.dispatch();
      expect(wrong.calls).toHaveLength(2);
    } finally {
      await wrong.close();
    }
  });

  test('R-T32 ⑦ 받은 사람(HOLDER) 사본에는 사유 범주·잠금·우선 구매·이의 칸이 없고 가진 표만 있다', async () => {
    const accountId = randomUUID();
    const caseId = randomUUID();
    const held = [randomUUID(), randomUUID()];
    await h.kit().views.fraud.apply(FRAUD_VIEW({ accountId, caseId, party: 'HOLDER', heldTicketIds: held }));
    const r = await h.fraudAppeals(h.fanHeaders(accountId));
    expect(r.status).toBe(200);
    expect(items(r.body)).toEqual([
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

  test('ASVS v5.0.0-8.2.2·15.3.1 소명 목록은 내 것만 최근 제출 순으로 주고 본문·CS 건·담당은 싣지 않는다', async () => {
    const me = randomUUID();
    const other = randomUUID();
    const a = await submit(h, { accountId: me, kind: 'RESTRICTION', targetId: randomUUID(), body: '내 첫 소명-시험7734' });
    h.clock.advance(1_000);
    const b = await submit(h, { accountId: me, kind: 'FRAUD_CASE', targetId: randomUUID(), body: '내 둘째 소명-시험7735' });
    await submit(h, { accountId: other, kind: 'RESTRICTION', targetId: randomUUID() });
    const r = await h.myAppeals(h.fanHeaders(me));
    expect(r.status).toBe(200);
    expect(items(r.body).map((x) => x.appealId)).toEqual([b.body.appealId, a.body.appealId]);
    const one = items(r.body)[0]!;
    for (const leak of ['body', 'caseId', 'assignee']) expect(one).not.toHaveProperty(leak);
    expect(one.resultNote).toBeNull();
    expect(JSON.stringify(r.body)).not.toContain('내 첫 소명');
    expect(r.headers['cache-control']).toBe('private, no-store');

    // 결정 결과의 이유는 팬에게 보이는 값이라 결정 뒤에만 실린다
    await h.internalResult(String(a.body.appealId), { status: 'DECIDED', result: 'LIFTED', resultNote: '사정이 확인되었습니다-시험7736' });
    const decided = items((await h.myAppeals(h.fanHeaders(me))).body).find((x) => x.appealId === a.body.appealId);
    expect(decided).toMatchObject({ status: 'DECIDED', result: 'LIFTED', resultNote: '사정이 확인되었습니다-시험7736' });
  });
});

describe('ASVS 경계', () => {
  test('ASVS v5.0.0-2.2.1·2.2.2 받지 않는 종류·빈 글·2,001자·모르는 칸·targetId 없음은 400·422이고 2,000자는 201이다', async () => {
    const accountId = randomUUID();
    const hdrs = h.fanHeaders(accountId);
    const wrongKind = await h.post(hdrs, { kind: 'RECLAIM', targetId: randomUUID(), body: '사정-시험7736' });
    expect([wrongKind.status, problemType(wrongKind.body)]).toEqual([422, 'appeal-kind-not-supported']);
    const empty = await h.post(hdrs, { kind: 'RESTRICTION', targetId: randomUUID(), body: '' });
    expect(empty.status).toBe(400);
    const long = await h.post(hdrs, { kind: 'RESTRICTION', targetId: randomUUID(), body: '가'.repeat(2_001) });
    expect(long.status).toBe(400);
    const exact = await h.post(hdrs, { kind: 'RESTRICTION', targetId: randomUUID(), body: '가'.repeat(2_000) });
    expect(exact.status).toBe(201);
    const extra = await h.post(hdrs, { kind: 'RESTRICTION', targetId: randomUUID(), body: '사정-시험7737', accountId: randomUUID() });
    expect(extra.status).toBe(400);
    const noTarget = await h.post(hdrs, { kind: 'RESTRICTION', body: '사정-시험7738' });
    expect(noTarget.status).toBe(400);
  });

  test('ASVS v5.0.0-3.5.3 소명 접수·결과는 POST만 받고 GET·PUT은 만들지 않는다', async () => {
    const accountId = randomUUID();
    const hdrs = h.fanHeaders(accountId);
    const beforeRes = await h.myAppeals(hdrs);
    expect(beforeRes.status).toBe(200);
    expect(Array.isArray(beforeRes.body.items)).toBe(true);
    const before = items(beforeRes.body).length;
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const r = await h.svc.http.inject({ method, url: '/v1/appeals', headers: { ...hdrs, 'content-type': 'application/json' }, payload: JSON.stringify({ kind: 'RESTRICTION', targetId: randomUUID(), body: '사정-시험7739' }) });
      expect([404, 405]).toContain(r.statusCode);
    }
    const sameRes = await h.myAppeals(hdrs);
    expect(sameRes.status).toBe(200);
    expect(Array.isArray(sameRes.body.items)).toBe(true);
    expect(items(sameRes.body)).toHaveLength(before);
    const created = await submit(h, { accountId, kind: 'RESTRICTION', targetId: randomUUID() });
    const afterRes = await h.myAppeals(hdrs);
    expect(afterRes.status).toBe(200);
    const after = items(afterRes.body);
    expect(after).toHaveLength(before + 1);
    expect(after[0]!.appealId).toBe(created.body.appealId);
  });

  test('ASVS v5.0.0-2.3.3 소명 저장이 실패하면 Outbox도 남지 않고(한 트랜잭션), 결과 저장 실패는 상태를 바꾸지 않는다', async () => {
    const accountId = randomUUID();
    h.kit().failNext('saveAppeal');
    const failed = await h.post(h.fanHeaders(accountId), { kind: 'RESTRICTION', targetId: randomUUID(), body: '사정-시험7740' });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(h.kit().outbox.rows()).toEqual([]);

    const ok = await submit(h, { accountId, kind: 'RESTRICTION', targetId: randomUUID() });
    h.kit().failNext('saveResult');
    const failedResult = await h.internalResult(String(ok.body.appealId), { status: 'DECIDED', result: 'LIFTED', resultNote: '해제-시험7741' });
    expect(failedResult.status).toBeGreaterThanOrEqual(500);
    expect((await h.internalGet(String(ok.body.appealId))).body.status).toBe('SUBMITTED');
  });

  test('ASVS v5.0.0-14.3.2 예매 제한·부정 예매 사본 조회도 private, no-store다', async () => {
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
    expect(String(r.body.type)).toContain('not-found');
    expect(h.logs.text()).toContain('404');
  });
});
