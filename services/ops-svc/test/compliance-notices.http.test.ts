// 법정 통보 접수·목록·상세·차단·철회 HTTP 경계(F-07-11, LCH-160, POL-024, control-tower §9, openapi /v1/ops/compliance/notices*).
// 정본: openapi ComplianceNoticeCreate(1618~1629행)·ComplianceNotice(1733~1751행)·notices 경로(5967~5977행),
// docs/security/authz-matrix.md §4.1 '기관 요청'(CS는 SUMMARY, operator·commander는 FULL, viewer 403), guidelines §3~§4.
// 단언 값은 정본에서 온다: 기한 24시간·10시간, reviewIds 1~100, agencyName 1~100, summary 0~2,000, 사유 1~2,000.
// core 호출은 대역이다. 이 시험은 구현 전 트리에서 경로가 없어 404로 실패한다(모듈 import 실패가 아니다).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-26T03:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const identity = new FakeIdentity();

interface ApplyInput {
  noticeId: string;
  reviewIds: readonly string[];
  receivedAt: string;
  deadline: 'H24' | 'H10';
  reason: string;
}
interface WithdrawInput {
  noticeId: string;
  reason: string;
}
interface AuditInput {
  readonly action: 'NOTICE_CREATED' | 'NOTICE_VIEWED' | 'NOTICE_TAKEN_DOWN' | 'NOTICE_WITHDRAWN';
  readonly noticeId: string;
  readonly actorId: string;
  readonly role: string;
  readonly atMs: number;
}
const audit = {
  calls: [] as AuditInput[],
  async record(input: AuditInput) {
    this.calls.push(input);
  },
};
const core = {
  applyCalls: [] as ApplyInput[],
  withdrawCalls: [] as WithdrawInput[],
  failNext: false,
  async applyNotice(input: ApplyInput) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('core down');
    }
    this.applyCalls.push(input);
    const h = input.deadline === 'H24' ? 24 : 10;
    return { applied: input.reviewIds.length, skipped: 0, deadlineAt: new Date(Date.parse(input.receivedAt) + h * HOUR).toISOString() };
  },
  async withdrawNotice(input: WithdrawInput) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('core down');
    }
    this.withdrawCalls.push(input);
    return { restored: 1, sameContentRestored: 1, fingerprintsCleared: 1 };
  },
};

let svc: Awaited<ReturnType<typeof createService>>;
const opened: Awaited<ReturnType<typeof createService>>[] = [];
afterAll(async () => {
  for (const s of opened.splice(0)) await s.close();
});

async function harness(): Promise<{ clock: ReturnType<typeof fakeClock> }> {
  const clock = fakeClock({ now: NOW });
  svc = await createService({
    name: 'ops-svc',
    // compliance 옵션은 이 기능이 더한다. 기준 트리에서는 AppModule이 모르는 칸을 무시해 경로가 404다
    module: AppModule.register({ memory: true, compliance: { core, audit } } as never),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  opened.push(svc);
  core.applyCalls.length = 0;
  core.withdrawCalls.length = 0;
  core.failNext = false;
  audit.calls.length = 0;
  return { clock };
}

interface CreateBody {
  readonly requester: string;
  readonly agencyName: string;
  readonly receivedAt: string;
  readonly deadline: string;
  readonly reviewIds: string[];
  readonly summary: string;
}
const createBody = (o: Partial<CreateBody> = {}): CreateBody => ({
  requester: 'AGENCY',
  agencyName: '한국콘텐츠진흥원',
  receivedAt: new Date(NOW - HOUR).toISOString(),
  deadline: 'H24',
  reviewIds: [randomUUID()],
  summary: '불법 거래 게시물 통보',
  ...o,
});

const post = (url: string, who: Record<string, string>, body: unknown, key: string | null = randomUUID()) =>
  svc.http.inject({
    method: 'POST',
    url,
    headers: { ...who, 'content-type': 'application/json', ...(key === null ? {} : { 'idempotency-key': key }) },
    payload: JSON.stringify(body),
  });
const get = (url: string, who: Record<string, string>) => svc.http.inject({ method: 'GET', url, headers: who });
const created = (r: { payload: string }) => JSON.parse(r.payload) as { noticeId: string; dueAt: string };
const noticeIds = async (who: Record<string, string>): Promise<string[]> => {
  const r = await get('/v1/ops/compliance/notices?limit=100', who);
  return (JSON.parse(r.payload) as { items: { noticeId: string }[] }).items.map((x) => x.noticeId);
};

describe('/v1/ops/compliance/notices', () => {
  test('CMP-01 [ASVS v5.0.0-2.2.3] operator가 통보를 등록하면 접수 시각 기준 24시간·10시간 기한과 OPEN을 준다', async () => {
    await harness();
    const operator = identity.ops('operator');
    const body = createBody();
    const r = await post('/v1/ops/compliance/notices', operator, body);
    expect(r.statusCode).toBe(201);
    const out = created(r);
    expect(out.dueAt).toBe(new Date(Date.parse(body.receivedAt) + DAY).toISOString());
    expect(r.headers.location).toBe(`/v1/ops/compliance/notices/${out.noticeId}`);

    const detail = await get(`/v1/ops/compliance/notices/${out.noticeId}`, operator);
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload)).toMatchObject({ view: 'FULL', noticeId: out.noticeId, status: 'OPEN', requester: 'AGENCY', agencyName: '한국콘텐츠진흥원', reviewIds: body.reviewIds });

    const ministry = createBody({ deadline: 'H10' });
    const r10 = await post('/v1/ops/compliance/notices', identity.ops('commander'), ministry);
    expect(r10.statusCode).toBe(201);
    expect(created(r10).dueAt).toBe(new Date(Date.parse(ministry.receivedAt) + 10 * HOUR).toISOString());

    expect((await post('/v1/ops/compliance/notices', identity.ops('cs_agent'), createBody())).statusCode).toBe(403);
    expect((await post('/v1/ops/compliance/notices', identity.ops('cs_lead'), createBody())).statusCode).toBe(403);
    expect((await post('/v1/ops/compliance/notices', identity.ops('viewer'), createBody())).statusCode).toBe(403);
  });

  test('CMP-02 [ASVS v5.0.0-1.3.3] 등록 본문의 길이·개수·정규화 경계를 지킨다', async () => {
    await harness();
    const operator = identity.ops('operator');
    for (const agencyName of ['가', '가'.repeat(100)]) expect((await post('/v1/ops/compliance/notices', operator, createBody({ agencyName }))).statusCode).toBe(201);
    expect((await post('/v1/ops/compliance/notices', operator, createBody({ agencyName: '' }))).statusCode).toBe(400);
    expect((await post('/v1/ops/compliance/notices', operator, createBody({ agencyName: '가'.repeat(101) }))).statusCode).toBe(400);
    for (const summary of ['', '가'.repeat(2_000)]) expect((await post('/v1/ops/compliance/notices', operator, createBody({ summary }))).statusCode).toBe(201);
    expect((await post('/v1/ops/compliance/notices', operator, createBody({ summary: '가'.repeat(2_001) }))).statusCode).toBe(400);
    expect((await post('/v1/ops/compliance/notices', operator, createBody({ reviewIds: [] }))).statusCode).toBe(400);
    expect((await post('/v1/ops/compliance/notices', operator, createBody({ reviewIds: Array.from({ length: 100 }, () => randomUUID()) }))).statusCode).toBe(201);
    expect((await post('/v1/ops/compliance/notices', operator, createBody({ reviewIds: Array.from({ length: 101 }, () => randomUUID()) }))).statusCode).toBe(400);
    const id = randomUUID();
    expect((await post('/v1/ops/compliance/notices', operator, createBody({ reviewIds: [id, id] }))).statusCode).toBe(400);
    expect((await post('/v1/ops/compliance/notices', operator, createBody({ deadline: 'H1' }))).statusCode).toBe(400);
    expect((await post('/v1/ops/compliance/notices', operator, createBody({ requester: 'ETC' }))).statusCode).toBe(400);

    // 요약의 제어·양방향 제어 문자는 저장 전에 지운다(1.3.3)
    const r = await post('/v1/ops/compliance/notices', operator, createBody({ summary: '통\u202e보\u0007 요약' }));
    expect(r.statusCode).toBe(201);
    const detail = JSON.parse((await get(`/v1/ops/compliance/notices/${created(r).noticeId}`, operator)).payload) as { summary: string };
    expect(detail.summary).toBe('통보 요약');
  });

  test('CMP-03 [ASVS v5.0.0-2.4.1] 등록은 Idempotency-Key(UUID v4)를 요구하고, 같은 키·같은 본문은 같은 통보, 같은 키·다른 본문은 422다', async () => {
    await harness();
    const operator = identity.ops('operator');
    const body = createBody();
    const key = randomUUID();
    expect((await post('/v1/ops/compliance/notices', operator, body, null)).statusCode).toBe(400);
    expect((await post('/v1/ops/compliance/notices', operator, body, 'not-a-uuid')).statusCode).toBe(400);
    const first = await post('/v1/ops/compliance/notices', operator, body, key);
    expect(first.statusCode).toBe(201);
    const replay = await post('/v1/ops/compliance/notices', operator, body, key);
    expect(replay.statusCode).toBe(201);
    expect(created(replay)).toEqual(created(first));
    const reused = await post('/v1/ops/compliance/notices', operator, createBody({ summary: '다른 통보' }), key);
    expect(reused.statusCode).toBe(422);
    expect(JSON.parse(reused.payload)).toMatchObject({ type: 'https://peaket.example/problems/idempotency-key-reused' });
    expect(await noticeIds(operator)).toHaveLength(1);
    // 멱등 범위는 부른 계정이다: 다른 운영자가 같은 키를 써도 새 통보다
    const other = identity.ops('operator');
    const otherCreated = created(await post('/v1/ops/compliance/notices', other, createBody({ summary: '다른 운영자 통보' }), key));
    expect(otherCreated.noticeId).not.toBe(created(first).noticeId);
  });

  test('CMP-04 [ASVS v5.0.0-8.2.3] 목록·상세는 CS에 SUMMARY만, operator·commander에 FULL을 주고 커서·상태·정렬·no-store를 지킨다', async () => {
    const { clock } = await harness();
    const operator = identity.ops('operator');
    const early = createBody({ receivedAt: new Date(NOW - 2 * HOUR).toISOString(), summary: '먼저 온 통보' });
    clock.advance(1_000);
    const a = created(await post('/v1/ops/compliance/notices', operator, early));
    clock.advance(1_000);
    const late = createBody({ receivedAt: new Date(NOW - HOUR).toISOString(), summary: '나중 온 통보' });
    const b = created(await post('/v1/ops/compliance/notices', operator, late));

    const cs = identity.ops('cs_agent');
    const list = await get('/v1/ops/compliance/notices?sort=DUE_ASC&limit=100', cs);
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toContain('private');
    expect(list.headers['cache-control']).toContain('no-store');
    const page = JSON.parse(list.payload) as { items: Record<string, unknown>[]; nextCursor: string | null };
    expect(page.items.map((x) => x.noticeId)).toEqual([a.noticeId, b.noticeId]);
    expect(page.items[0]).toMatchObject({ view: 'SUMMARY', requester: 'AGENCY', agencyName: '한국콘텐츠진흥원', status: 'OPEN' });
    for (const k of ['receivedAt', 'deadline', 'reviewIds', 'summary', 'documents', 'takenDownAt', 'withdrawnAt']) expect(Object.hasOwn(page.items[0]!, k)).toBe(false);

    // CS 상세도 SUMMARY만이고 private, no-store다
    const csDetail = await get(`/v1/ops/compliance/notices/${a.noticeId}`, cs);
    expect(csDetail.statusCode).toBe(200);
    expect(csDetail.headers['cache-control']).toContain('private');
    expect(csDetail.headers['cache-control']).toContain('no-store');
    const csOne = JSON.parse(csDetail.payload) as Record<string, unknown>;
    expect(csOne).toMatchObject({ view: 'SUMMARY', noticeId: a.noticeId });
    for (const k of ['receivedAt', 'deadline', 'reviewIds', 'summary', 'documents', 'takenDownAt', 'withdrawnAt']) expect(Object.hasOwn(csOne, k)).toBe(false);

    const full = JSON.parse((await get('/v1/ops/compliance/notices?sort=LATEST&limit=100', operator)).payload) as { items: Record<string, unknown>[] };
    expect(full.items.map((x) => x.noticeId)).toEqual([b.noticeId, a.noticeId]);
    expect(full.items.every((x) => x.view === 'FULL')).toBe(true);
    expect(full.items.find((x) => x.noticeId === b.noticeId)).toMatchObject({ summary: '나중 온 통보', receivedAt: late.receivedAt, deadline: 'H24' });
    const fullDetail = await get(`/v1/ops/compliance/notices/${a.noticeId}`, operator);
    expect(fullDetail.headers['cache-control']).toContain('no-store');

    const firstPage = JSON.parse((await get('/v1/ops/compliance/notices?limit=1', operator)).payload) as { items: { noticeId: string }[]; nextCursor: string | null };
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = JSON.parse((await get(`/v1/ops/compliance/notices?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`, operator)).payload) as { items: { noticeId: string }[] };
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]!.noticeId).not.toBe(firstPage.items[0]!.noticeId);

    // 상태 거르기: 하나를 차단하면 OPEN에는 다른 하나만, TAKEN_DOWN에는 그 하나만 남는다
    expect((await post(`/v1/ops/compliance/notices/${a.noticeId}/takedown`, operator, { reason: '차단' }, randomUUID())).statusCode).toBe(200);
    const openList = JSON.parse((await get('/v1/ops/compliance/notices?status=OPEN', operator)).payload) as { items: { noticeId: string }[] };
    const takenList = JSON.parse((await get('/v1/ops/compliance/notices?status=TAKEN_DOWN', operator)).payload) as { items: { noticeId: string }[] };
    expect(openList.items.map((x) => x.noticeId)).toEqual([b.noticeId]);
    expect(takenList.items.map((x) => x.noticeId)).toEqual([a.noticeId]);

    expect((await get('/v1/ops/compliance/notices?status=CLOSED', operator)).statusCode).toBe(400);
    expect((await get('/v1/ops/compliance/notices?sort=OLDEST', operator)).statusCode).toBe(400);
    expect((await get('/v1/ops/compliance/notices?limit=0', operator)).statusCode).toBe(400);
    expect((await get('/v1/ops/compliance/notices?limit=101', operator)).statusCode).toBe(400);
    expect((await get('/v1/ops/compliance/notices', identity.ops('viewer'))).statusCode).toBe(403);
    expect((await get(`/v1/ops/compliance/notices/${randomUUID()}`, operator)).statusCode).toBe(404);
  });

  test('CMP-05 [ASVS v5.0.0-2.3.3] 차단은 core에 한 번 보내고 상태를 TAKEN_DOWN으로 바꾸며, 실패하면 상태를 바꾸지 않는다', async () => {
    await harness();
    const operator = identity.ops('operator');
    const body = createBody({ reviewIds: [randomUUID(), randomUUID()] });
    const n = created(await post('/v1/ops/compliance/notices', operator, body));
    // 키 없음·형식 틀림은 400이다
    expect((await post(`/v1/ops/compliance/notices/${n.noticeId}/takedown`, operator, { reason: '차단' }, null)).statusCode).toBe(400);
    expect((await post(`/v1/ops/compliance/notices/${n.noticeId}/takedown`, operator, { reason: '차단' }, 'not-a-uuid')).statusCode).toBe(400);
    const key = randomUUID();
    const first = await post(`/v1/ops/compliance/notices/${n.noticeId}/takedown`, operator, { reason: '통보에 따른 노출 차단' }, key);
    expect(first.statusCode).toBe(200);
    expect(core.applyCalls).toHaveLength(1);
    expect(core.applyCalls[0]).toMatchObject({ noticeId: n.noticeId, reviewIds: body.reviewIds, receivedAt: body.receivedAt, deadline: 'H24', reason: '통보에 따른 노출 차단' });
    const detail = JSON.parse((await get(`/v1/ops/compliance/notices/${n.noticeId}`, operator)).payload) as { status: string; takenDownAt: string | null };
    expect(detail.status).toBe('TAKEN_DOWN');
    expect(typeof detail.takenDownAt).toBe('string');

    // 같은 키는 core를 다시 부르지 않고 같은 200, 같은 키·다른 본문은 422, 다른 키는 409
    expect((await post(`/v1/ops/compliance/notices/${n.noticeId}/takedown`, operator, { reason: '통보에 따른 노출 차단' }, key)).statusCode).toBe(200);
    expect(core.applyCalls).toHaveLength(1);
    const reused = await post(`/v1/ops/compliance/notices/${n.noticeId}/takedown`, operator, { reason: '다른 사유' }, key);
    expect(reused.statusCode).toBe(422);
    expect(JSON.parse(reused.payload)).toMatchObject({ type: 'https://peaket.example/problems/idempotency-key-reused' });
    expect((await post(`/v1/ops/compliance/notices/${n.noticeId}/takedown`, operator, { reason: '다시 차단' }, randomUUID())).statusCode).toBe(409);

    // 사유는 1~2,000자다
    const one = created(await post('/v1/ops/compliance/notices', operator, createBody()));
    expect((await post(`/v1/ops/compliance/notices/${one.noticeId}/takedown`, operator, { reason: '가' }, randomUUID())).statusCode).toBe(200);
    const long = created(await post('/v1/ops/compliance/notices', operator, createBody()));
    expect((await post(`/v1/ops/compliance/notices/${long.noticeId}/takedown`, operator, { reason: '가'.repeat(2_000) }, randomUUID())).statusCode).toBe(200);
    const tooLong = created(await post('/v1/ops/compliance/notices', operator, createBody()));
    expect((await post(`/v1/ops/compliance/notices/${tooLong.noticeId}/takedown`, operator, { reason: '가'.repeat(2_001) }, randomUUID())).statusCode).toBe(400);
    expect((await post(`/v1/ops/compliance/notices/${tooLong.noticeId}/takedown`, operator, { reason: '' }, randomUUID())).statusCode).toBe(400);

    // 멱등 범위는 부른 계정이다: 다른 operator가 같은 키를 써도 그 통보에 처리한다
    const another = identity.ops('operator');
    const nOther = created(await post('/v1/ops/compliance/notices', another, createBody()));
    expect((await post(`/v1/ops/compliance/notices/${nOther.noticeId}/takedown`, another, { reason: '다른 운영자 차단' }, key)).statusCode).toBe(200);

    // core 장애는 저장하지 않으므로 같은 키로 다시 보내면 처리한다
    const n2 = created(await post('/v1/ops/compliance/notices', operator, createBody()));
    const retryKey = randomUUID();
    core.failNext = true;
    const failed = await post(`/v1/ops/compliance/notices/${n2.noticeId}/takedown`, operator, { reason: '통보 차단' }, retryKey);
    expect(failed.statusCode).toBe(503);
    expect(JSON.parse(failed.payload)).toMatchObject({ type: 'https://peaket.example/problems/compliance-core-unavailable' });
    expect((JSON.parse((await get(`/v1/ops/compliance/notices/${n2.noticeId}`, operator)).payload) as { status: string }).status).toBe('OPEN');
    expect((await post(`/v1/ops/compliance/notices/${n2.noticeId}/takedown`, operator, { reason: '통보 차단' }, retryKey)).statusCode).toBe(200);
  });

  test('CMP-06 [ASVS v5.0.0-2.3.3] 철회는 TAKEN_DOWN만 받고 core 복구 뒤 WITHDRAWN이 되며, 실패하면 상태를 바꾸지 않는다', async () => {
    await harness();
    const operator = identity.ops('operator');
    const n = created(await post('/v1/ops/compliance/notices', operator, createBody()));
    expect((await post(`/v1/ops/compliance/notices/${n.noticeId}/withdrawal`, operator, { reason: '철회' }, randomUUID())).statusCode).toBe(409);
    expect((await post(`/v1/ops/compliance/notices/${n.noticeId}/takedown`, operator, { reason: '차단' }, randomUUID())).statusCode).toBe(200);
    // 키 없음·형식 틀림 400, 사유 2,001자 400
    expect((await post(`/v1/ops/compliance/notices/${n.noticeId}/withdrawal`, operator, { reason: '철회' }, null)).statusCode).toBe(400);
    expect((await post(`/v1/ops/compliance/notices/${n.noticeId}/withdrawal`, operator, { reason: '철회' }, 'not-a-uuid')).statusCode).toBe(400);
    expect((await post(`/v1/ops/compliance/notices/${n.noticeId}/withdrawal`, operator, { reason: '가'.repeat(2_001) }, randomUUID())).statusCode).toBe(400);
    const key = randomUUID();
    const out = await post(`/v1/ops/compliance/notices/${n.noticeId}/withdrawal`, operator, { reason: '통보 철회' }, key);
    expect(out.statusCode).toBe(200);
    expect(core.withdrawCalls[0]).toMatchObject({ noticeId: n.noticeId, reason: '통보 철회' });
    const detail = JSON.parse((await get(`/v1/ops/compliance/notices/${n.noticeId}`, operator)).payload) as { status: string; withdrawnAt: string | null };
    expect(detail.status).toBe('WITHDRAWN');
    expect(typeof detail.withdrawnAt).toBe('string');
    expect((await post(`/v1/ops/compliance/notices/${n.noticeId}/withdrawal`, operator, { reason: '통보 철회' }, key)).statusCode).toBe(200);
    expect(core.withdrawCalls).toHaveLength(1);
    const reused = await post(`/v1/ops/compliance/notices/${n.noticeId}/withdrawal`, operator, { reason: '다른 사유' }, key);
    expect(reused.statusCode).toBe(422);
    expect(JSON.parse(reused.payload)).toMatchObject({ type: 'https://peaket.example/problems/idempotency-key-reused' });
    expect((await post(`/v1/ops/compliance/notices/${n.noticeId}/withdrawal`, operator, { reason: '다시 철회' }, randomUUID())).statusCode).toBe(409);

    const n2 = created(await post('/v1/ops/compliance/notices', operator, createBody()));
    expect((await post(`/v1/ops/compliance/notices/${n2.noticeId}/takedown`, operator, { reason: '차단' }, randomUUID())).statusCode).toBe(200);
    const retryKey = randomUUID();
    core.failNext = true;
    const failed = await post(`/v1/ops/compliance/notices/${n2.noticeId}/withdrawal`, operator, { reason: '통보 철회' }, retryKey);
    expect(failed.statusCode).toBe(503);
    expect((JSON.parse((await get(`/v1/ops/compliance/notices/${n2.noticeId}`, operator)).payload) as { status: string }).status).toBe('TAKEN_DOWN');
    expect((await post(`/v1/ops/compliance/notices/${n2.noticeId}/withdrawal`, operator, { reason: '통보 철회' }, retryKey)).statusCode).toBe(200);
  });

  test('CMP-07 [ASVS v5.0.0-14.2.6] 응답과 오류에 신고자·작성자 계정·주문·팬 이름·후기 본문을 싣지 않는다', async () => {
    await harness();
    const operator = identity.ops('operator');
    const reviewId = randomUUID();
    const n = created(await post('/v1/ops/compliance/notices', operator, createBody({ reviewIds: [reviewId] })));
    const detail = JSON.parse((await get(`/v1/ops/compliance/notices/${n.noticeId}`, operator)).payload) as Record<string, unknown>;
    const allowed = new Set(['view', 'noticeId', 'requester', 'agencyName', 'dueAt', 'status', 'receivedAt', 'deadline', 'reviewIds', 'summary', 'documents', 'takenDownAt', 'withdrawnAt']);
    for (const k of Object.keys(detail)) expect({ k, allowed: allowed.has(k) }).toEqual({ k, allowed: true });
    for (const k of ['reporterAccountId', 'accountId', 'basisOrderId', 'payerName', 'authorDisplay', 'body']) expect(Object.hasOwn(detail, k)).toBe(false);
    // 행위자 계정과 후기 ID는 CS SUMMARY에 새지 않는다
    const text = (await get(`/v1/ops/compliance/notices/${n.noticeId}`, identity.ops('cs_agent'))).payload;
    expect(text).not.toContain(operator['x-user-id']);
    expect(text).not.toContain(reviewId);
    const bad = await post('/v1/ops/compliance/notices', operator, createBody({ reviewIds: ['not-a-uuid'] }));
    expect(bad.statusCode).toBe(400);
    expect((bad.payload)).not.toContain('not-a-uuid');
  });

  test('CMP-09 [ASVS v5.0.0-8.3.1] 통보 등록·열람·차단·철회는 행위자·대상과 함께 감사 기록에 남는다', async () => {
    await harness();
    const operator = identity.ops('operator');
    const n = created(await post('/v1/ops/compliance/notices', operator, createBody()));
    expect((await get(`/v1/ops/compliance/notices/${n.noticeId}`, operator)).statusCode).toBe(200);
    expect((await post(`/v1/ops/compliance/notices/${n.noticeId}/takedown`, operator, { reason: '차단' }, randomUUID())).statusCode).toBe(200);
    expect((await post(`/v1/ops/compliance/notices/${n.noticeId}/withdrawal`, operator, { reason: '철회' }, randomUUID())).statusCode).toBe(200);
    expect(audit.calls.map((c) => c.action)).toEqual(['NOTICE_CREATED', 'NOTICE_VIEWED', 'NOTICE_TAKEN_DOWN', 'NOTICE_WITHDRAWN']);
    for (const c of audit.calls) {
      expect(c).toMatchObject({ noticeId: n.noticeId, actorId: operator['x-user-id'], role: 'operator' });
      expect(typeof c.atMs).toBe('number');
    }
  });

  test('CMP-08 [ASVS v5.0.0-2.2.3] 없는 통보·모양이 틀린 ID는 404이고 쓰기 역할이 아니면 403이다', async () => {
    await harness();
    const operator = identity.ops('operator');
    const n = created(await post('/v1/ops/compliance/notices', operator, createBody()));
    expect((await post(`/v1/ops/compliance/notices/${randomUUID()}/takedown`, operator, { reason: '차단' }, randomUUID())).statusCode).toBe(404);
    expect((await post(`/v1/ops/compliance/notices/${randomUUID()}/withdrawal`, operator, { reason: '철회' }, randomUUID())).statusCode).toBe(404);
    expect((await post('/v1/ops/compliance/notices/not-a-uuid/takedown', operator, { reason: '차단' }, randomUUID())).statusCode).toBe(404);
    expect((await get('/v1/ops/compliance/notices/not-a-uuid', operator)).statusCode).toBe(404);
    expect((await post(`/v1/ops/compliance/notices/${n.noticeId}/takedown`, identity.ops('cs_agent'), { reason: '차단' }, randomUUID())).statusCode).toBe(403);
    expect((await post(`/v1/ops/compliance/notices/${n.noticeId}/takedown`, identity.ops('viewer'), { reason: '차단' }, randomUUID())).statusCode).toBe(403);
    expect((await get(`/v1/ops/compliance/notices/${n.noticeId}`, identity.ops('viewer'))).statusCode).toBe(403);
  });
});
