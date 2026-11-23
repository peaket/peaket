// CS 건 요청 본문의 선택 칸 detail(F-07-7 LCH-120, 계획 §5.1 (타) 결정 2, ADR-0370 결정 7·8).
// payment-svc 정산 일꾼이 '포트원 일괄 지급 실행'·'포트원 원장 불일치' 건에 뺀 정산서·사유·'commander 확인 필요'·'실행 멈춤'을 글로 싣는다.
// POST /internal/v1/cs-cases는 .strict() 본문에 detail(1~2,000자)만 더 받고, 2,001자·빈 글은 400이며 건을 만들지 않는다.
// 처음 연 건에 글을 저장하고, 같은 사건 키를 다시 받으면 글을 바꾸지 않는다. 저장 칸은 ops 마이그레이션(cs_case.detail)이지만 이 시험은 번호에 기대지 않는다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCsCaseStore, ReceiveCaseRequested, type CaseRequested } from '../src/modules/cases/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-12-02T00:00:00.000Z');
let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({ name: 'ops-svc', module: AppModule.register({ memory: true }), env: { PEAKET_ENV: 'ci' }, clock: fakeClock({ now: NOW }), logDestination: quiet(), adminAuthz: new FakeIdentity() });
});
afterAll(async () => {
  await svc?.close();
});

const body = (o: { eventKey?: string; detail?: unknown } = {}) => ({
  eventKey: o.eventKey ?? `portone-execution:${randomUUID()}`,
  kind: 'PORTONE_PAYOUT_EXECUTION',
  sourceId: randomUUID(),
  category: 'SETTLEMENT',
  createdAt: new Date(NOW).toISOString(),
  ...(o.detail === undefined ? {} : { detail: o.detail }),
});
const post = async (b: unknown): Promise<[number, Record<string, unknown>]> => {
  const r = await svc.http.inject({ method: 'POST', url: '/internal/v1/cs-cases', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(b) });
  return [r.statusCode, JSON.parse(r.payload) as Record<string, unknown>];
};

describe('J-T41 ② CS 건 detail 받기', () => {
  test.each([
    ['1자', 'x'],
    ['2,000자', '가'.repeat(2_000)],
    ['뺀 정산서 목록', '뺀 정산서: 0193a7c2-0000-7000-8000-00000000000a(ACCOUNT_CHANGE)'],
  ])('J-T41 ② detail %s는 받아 건을 연다', async (_name, detail) => {
    const [status, out] = await post(body({ detail }));
    expect(status).toBe(202);
    expect(out).toEqual({ accepted: true, caseId: expect.any(String) });
  });

  test.each([
    ['2,001자', '가'.repeat(2_001)],
    ['빈 글', ''],
    ['글이 아님(숫자)', 7],
    ['null', null],
  ])('J-T41 ② detail %s는 400이고 건을 만들지 않는다', async (_name, detail) => {
    const eventKey = `portone-execution:${randomUUID()}`;
    const [status] = await post(body({ eventKey, detail }));
    expect(status).toBe(400);
    // 같은 사건 키를 바른 본문으로 보내면 새 건이 열린다(앞 요청이 건을 남기지 않았다)
    const [again, out] = await post(body({ eventKey }));
    expect([again, out.accepted]).toEqual([202, true]);
  });

  test('J-T41 ② detail 밖의 모르는 칸은 여전히 받지 않는다(.strict, detail만 더함)', async () => {
    const [status, out] = await post({ ...body({ detail: 'x' }), memo: 'y' });
    expect(status === 400 || out.accepted === false).toBe(true);
    expect(out.caseId).toBeUndefined();
  });

  test('J-T41 ② 처음 연 건에 detail을 저장하고, 같은 사건 키를 다른 글로 다시 받아도 글이 그대로다', async () => {
    const store = new MemoryCsCaseStore();
    const receive = new ReceiveCaseRequested(store);
    const batchId = randomUUID();
    const eventKey = `portone-execution:${batchId}`;
    const first: CaseRequested = { eventKey, kind: 'PORTONE_PAYOUT_EXECUTION', sourceId: batchId, category: 'SETTLEMENT', createdAt: new Date(NOW).toISOString(), detail: '뺀 정산서: s-1(ACCOUNT_CHANGE)' };
    const a = await receive.handle(first, NOW);
    expect(a.accepted).toBe(true);
    expect(a.case).toMatchObject({ kind: 'PORTONE_PAYOUT_EXECUTION', targetRef: batchId, detail: '뺀 정산서: s-1(ACCOUNT_CHANGE)' });
    const b = await receive.handle({ ...first, detail: '뺀 정산서: s-2(SALE_SUSPENDED)' }, NOW + 60_000);
    expect(b.case?.caseId).toBe(a.case?.caseId);
    expect(store.cases.get(a.case!.caseId)).toMatchObject({ detail: '뺀 정산서: s-1(ACCOUNT_CHANGE)' });
    // detail 없이 연 건은 null이다
    const c = await receive.handle({ eventKey: `portone-transfer:${randomUUID()}`, kind: 'PORTONE_LEDGER_MISMATCH', sourceId: `tr-${randomUUID()}`, category: 'SETTLEMENT', createdAt: new Date(NOW).toISOString() }, NOW);
    expect(c.case).toMatchObject({ detail: null });
  });
});
