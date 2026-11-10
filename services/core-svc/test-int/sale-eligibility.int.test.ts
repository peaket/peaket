// 판매 자격 명단 올리기·잠금·파기 정비·사본 넘기기 통합 시험(BUILD_ORDER HOT-250, ADR-0261 결정 6~9, Q-T36 ④⑤⑥, docs/data.md §5 경합 줄).
// 실제 PostgreSQL 18 컨테이너, 실제 core-svc HTTP 앱(운영과 같은 권한의 DB 사용자), 실제 gRPC 클라이언트 어댑터를 잇는다. identity 경계만 시험용 gRPC 서버
// (MemberCodeService·AdminAuthzService 대역)다. 정비 일은 relay 프로세스와 같은 함수로 정비 역할 연결(시험은 관리자 연결)에서 직접 돌린다.
// 시계는 시험이 옮긴다. 단언 값은 정본의 글(잠금 = 그 키를 쓰는 규칙의 판매 시작 − 24시간, 파기 = 판매 기간 끝 + 1일, 경계 포함)로 적는다.
import 'reflect-metadata';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { type Clock, createDatabase, createService, type Database, ensureOutboxPartitions, LogPseudonymizer, systemClock } from '@peaket/platform';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { event, place, production, promoter, saleEligibilityList, saleEligibilityMember } from '../src/modules/catalog/adapters/db/schema.js';
import { DrizzleSaleMaintenanceStore, GrpcMemberCodeDirectory, MemorySaleEligibilityCopy, SaleEligibilityMetrics, saleEligibilityMaintenanceTasks, UnwiredSaleEligibilityCopy } from '../src/modules/catalog/index.js';
import { FakeIdentity, testMedia } from '../test/support.js';
import { buildDist, freePort, logSink, multipart, SERVICE_DIR, until } from './media-support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

type Svc = Awaited<ReturnType<typeof createService>>;

/** identity 경계 대역: 회원 코드 → 계정, 호출 수, n번째 호출 실패, 답하기 전에 끼워 넣을 일 */
const accounts = new Map<string, string>();
const calls: number[] = [];
let failAt: number | undefined;
let beforeAnswer: (() => Promise<void> | void) | undefined;
const authz = new Map<string, { valid: boolean; role: string; tenant_id: string }>();
let identityServer: grpc.Server;
let identityAddress = '';

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let svc: Svc;
let directory: GrpcMemberCodeDirectory;
const logs = logSink();
const identity = new FakeIdentity();
const copy = new MemorySaleEligibilityCopy();
/** 서비스와 정비 일이 함께 쓰는 지표 묶음(시험은 서비스 등록부에 단다) */
const metrics = new SaleEligibilityMetrics();
/** 감사 줄의 로그 가명(시험 키) */
const pseudonym = new LogPseudonymizer(Buffer.alloc(32, 9));
let now = Date.parse('2026-11-05T00:00:00Z');
const clock: Clock = { now: () => now, monotonicMs: () => performance.now() };
const A = randomUUID();
const B = randomUUID();
const PLACE = randomUUID();
const P = 'https://peaket.example/problems/';
const KEY = 'lumen-fanclub-2026';
const H = 3_600_000;
const DAY = 24 * H;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** i번째 회원 코드(XXX-XXXX, Crockford base32) */
const code = (i: number) => {
  const d = (k: number) => ALPHABET[Math.floor(i / 32 ** k) % 32];
  return `${d(6)}${d(5)}${d(4)}-${d(3)}${d(2)}${d(1)}${d(0)}`;
};

beforeAll(async () => {
  const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, grpc.ServiceClientConstructor> } } }).peaket.identity.v1;
  identityServer = new grpc.Server();
  identityServer.addService(pkg.MemberCodeService!.service, {
    ResolveMemberCodes: async (call: grpc.ServerUnaryCall<{ member_codes: string[] }, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      calls.push(call.request.member_codes.length);
      if (beforeAnswer) await beforeAnswer();
      if (failAt !== undefined && calls.length === failAt) return cb({ code: grpc.status.UNAVAILABLE, details: '시험이 넣음' } as grpc.ServiceError);
      cb(null, { resolved: call.request.member_codes.filter((c) => accounts.has(c)).map((c) => ({ member_code: c, account_id: accounts.get(c)! })) });
    },
  });
  identityServer.addService(pkg.AdminAuthzService!.service, {
    GetAdminAuthz: (call: grpc.ServerUnaryCall<Record<string, string>, unknown>, cb: grpc.sendUnaryData<unknown>) => cb(null, authz.get(`${call.request.admin_account_id}/${call.request.session_id}`) ?? { valid: false, role: '', tenant_id: '' }),
  });
  const port = await new Promise<number>((res, rej) => identityServer.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  identityAddress = `127.0.0.1:${port}`;
  directory = new GrpcMemberCodeDirectory(identityAddress);

  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-test', max: 6 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 6);
  await admin.db.insert(promoter).values([
    { id: A, legalName: '(주)에이' },
    { id: B, legalName: '(주)비' },
  ]);
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, media: testMedia({ memberCodes: directory, eligibilityCopy: copy, pseudonym, eligibilityMetrics: metrics }) }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' },
    clock,
    logDestination: logs.stream,
    adminAuthz: identity,
  });
  metrics.register(svc.metrics.registry);
}, 180_000);

afterAll(async () => {
  await svc?.close();
  directory?.close();
  identityServer?.forceShutdown();
  await appDb?.close();
  await partnerDb?.close();
  await admin?.close();
  pg?.stop();
});

beforeEach(() => {
  calls.length = 0;
  failAt = undefined;
  beforeAnswer = undefined;
  copy.failing = false;
  copy.puts.length = 0;
  copy.drops.length = 0;
  now = Date.parse('2026-11-05T00:00:00Z');
});

/** 공연과 회차(관리자 연결). 회차 시작은 2026-12-24 10:00Z부터 하루씩, 취소된 회차를 더할 수 있다 */
async function makeProduction(o: { tenant?: string; rounds?: number; cancelledLast?: boolean; rules?: unknown[]; approved?: boolean } = {}): Promise<{ id: string; events: string[] }> {
  const tenant = o.tenant ?? A;
  const id = randomUUID();
  await admin.db.insert(production).values({ id, promoterId: tenant, placeId: PLACE, title: '겨울 콘서트', genre: '콘서트', saleReview: o.approved ? 'APPROVED' : 'DRAFT', saleApprovedAt: o.approved ? new Date('2026-11-01T00:00:00Z') : null, ...(o.rules ? { salePolicy: o.rules } : {}) });
  const n = o.rounds ?? 1;
  const events = Array.from({ length: n }, () => randomUUID());
  await admin.db.insert(event).values(
    events.map((e, i) => ({
      id: e,
      productionId: id,
      promoterId: tenant,
      venueId: null,
      openAt: new Date('2026-11-20T11:00:00Z'),
      startsAt: new Date(Date.parse('2026-12-24T10:00:00Z') + i * DAY),
      endsAt: new Date(Date.parse('2026-12-24T12:30:00Z') + i * DAY),
      status: o.cancelledLast && i === n - 1 ? 'CANCELLED' : 'SCHEDULED',
    })),
  );
  return { id, events };
}

/** 그 키를 쓰는 선예매 규칙(판매 시작 from) */
const presale = (from = '2026-11-20T20:00:00+09:00', rounds: unknown = 'ALL') => ({ version: 1, name: '팬클럽 선예매', rounds, during: { from }, rule: { if: { fact: 'buyer.lists', has: KEY }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } } });

const adminOf = (t = A) => identity.partner(t, 'partner_admin');
const url = (id: string) => `/v1/partner/productions/${id}/sale-eligibility-lists`;
async function upload(id: string, text: string, o: { key?: string; headers?: Record<string, string> } = {}) {
  const { payload, contentType } = await multipart({ key: o.key ?? KEY, name: 'LUMEN 팬클럽 2026' }, [{ name: 'list.csv', type: 'text/csv', bytes: new TextEncoder().encode(text) }]);
  return svc.http.inject({ method: 'POST', url: url(id), headers: { ...(o.headers ?? adminOf()), 'content-type': contentType, 'x-requested-with': 'peaket-partner' }, payload });
}
const remove = (id: string, key = KEY, h = adminOf()) => svc.http.inject({ method: 'DELETE', url: `${url(id)}/${key}`, headers: { ...h, 'x-requested-with': 'peaket-partner' } });
const problem = (r: { payload: string }) => JSON.parse(r.payload) as { type: string; detail?: string };
const lists = (productionId: string) => admin.db.select().from(saleEligibilityList).where(eq(saleEligibilityList.productionId, productionId));
const members = async (listId: string) => (await admin.db.select({ a: saleEligibilityMember.accountId }).from(saleEligibilityMember).where(eq(saleEligibilityMember.listId, listId))).map((r) => r.a).sort();
const known = (n: number, from = 0) => Array.from({ length: n }, (_, i) => {
  const c = code(from + i);
  if (!accounts.has(c)) accounts.set(c, randomUUID());
  return c;
});
const tasks = () => saleEligibilityMaintenanceTasks(new DrizzleSaleMaintenanceStore(admin), copy, clock, undefined, metrics);
const run = (name: string) => tasks().find((t) => t.name === name)!.run();

// 파기 정비는 맨 앞에 둔다(뒤 시험이 만든 명단이 같은 파기 시각에 함께 걸리지 않게)
describe('판매 자격 명단 파기 정비와 사본(Q-T36 ④)', () => {
  test('Q-T36 ④ 파기 시각 1ms 전 정비는 지우지 않고 그 시각 뒤 정비는 구성원·명단을 지우며 사본 수명은 파기 시각이다 [ASVS v5.0.0-14.2.4] [ASVS v5.0.0-14.2.7]', async () => {
    // 회차 셋(마지막은 취소): 파기 = 취소되지 않은 회차 가운데 가장 늦은 판매 종료(2026-12-25T10:00Z − 24시간) + 1일
    const m = await makeProduction({ rounds: 3, cancelledLast: true, rules: [presale()] });
    const keep = await makeProduction({ rounds: 1, rules: [presale()] });
    await admin.db.update(event).set({ startsAt: new Date('2027-01-10T10:00:00Z'), endsAt: new Date('2027-01-10T12:00:00Z') }).where(eq(event.productionId, keep.id));
    const cs = known(3, 500);
    expect((await upload(m.id, cs.join('\n'))).statusCode).toBe(200);
    expect((await upload(m.id, `${cs[0]}\n`, { key: 'other-list' })).statusCode).toBe(200);
    expect((await upload(keep.id, cs.join('\n'))).statusCode).toBe(200);
    const due = Date.parse('2026-12-25T10:00:00Z');
    const mine = await lists(m.id);
    expect(mine.map((l) => l.destroyDueAt.toISOString())).toEqual(['2026-12-25T10:00:00.000Z', '2026-12-25T10:00:00.000Z']);
    // 사본 수명은 파기 시각이고 회차는 취소되지 않은 둘이다
    expect(copy.puts[0]).toMatchObject({ productionId: m.id, eventIds: m.events.slice(0, 2), listKey: KEY, expiresAt: new Date(due) });
    const keepList = (await lists(keep.id))[0]!;
    now = due - 1;
    expect(await run('sale-eligibility-purge')).toMatchObject({ purged: 0, dropFailed: 0 });
    expect((await lists(m.id)).length).toBe(2);
    now = due;
    expect(await run('sale-eligibility-purge')).toMatchObject({ purged: 2, dropFailed: 0 });
    expect(await lists(m.id)).toEqual([]);
    for (const l of mine) expect(await members(l.id)).toEqual([]);
    // 다른 공연의 명단과 구성원은 그대로다
    expect([(await lists(keep.id)).length, (await members(keepList.id)).length]).toEqual([1, 3]);
    // 사본 지우기는 그 공연의 회차 모두(취소된 회차 포함)에 판(지운 기록의 copy_seq)을 실어 넘긴다(리뷰 S1)
    expect(copy.drops.sort((a, b) => (a.listKey < b.listKey ? -1 : 1)).map((d) => ({ ...d, version: typeof d.version }))).toEqual([
      { eventIds: m.events, listKey: KEY, version: 'number' },
      { eventIds: m.events, listKey: 'other-list', version: 'number' },
    ]);
    // 다시 돌려도 지울 것이 없다
    expect(await run('sale-eligibility-purge')).toMatchObject({ purged: 0, dropFailed: 0 });
  });

  test('사본 넘기기가 실패해도 올리기는 200이고 copied_version이 그대로이며 정비 일이 다시 넘긴다', async () => {
    const m = await makeProduction({ rules: [presale()] });
    const [c1] = known(1, 600);
    copy.failing = true;
    expect((await upload(m.id, `${c1}\n`)).statusCode).toBe(200);
    expect((await lists(m.id))[0]!.copiedSeq).toBeNull();
    expect(logs.lines().some((x) => x.event === 'sale_eligibility_copy_failed' && x.productionId === m.id)).toBe(true);
    // 정비 일도 실패하면 일을 실패로 끝낸다(정비 실패 지표에 남는다)
    await expect(run('sale-eligibility-copy')).rejects.toThrow(/넘기지 못했다/);
    copy.failing = false;
    expect(await run('sale-eligibility-copy')).toMatchObject({ copied: expect.any(Number) });
    expect((await lists(m.id))[0]!.copiedSeq).toBe((await lists(m.id))[0]!.copySeq);
    expect(copy.puts.filter((p) => p.productionId === m.id)).toEqual([{ productionId: m.id, eventIds: m.events, listKey: KEY, version: (await lists(m.id))[0]!.copySeq, accountIds: [accounts.get(c1)], expiresAt: new Date('2026-12-24T10:00:00Z') }]);
    // 운영 조립의 쓰는 쪽 없는 어댑터: 구성원을 읽지 않고 넘길 명단 수만 센다(리뷰 C1·D5, 아래 C1 시험이 지표를 본다)
    await admin.db.update(saleEligibilityList).set({ copiedSeq: null }).where(eq(saleEligibilityList.productionId, m.id));
    const task = saleEligibilityMaintenanceTasks(new DrizzleSaleMaintenanceStore(admin), new UnwiredSaleEligibilityCopy(), clock).find((t) => t.name === 'sale-eligibility-copy')!;
    expect(await task.run()).toMatchObject({ unwired: true, pending: expect.any(Number) });
  });

  test('회차 더하기는 명단 파기 시각을 다시 계산한다(승인 이력이 없는 공연)', async () => {
    const m = await makeProduction({ rules: [presale()] });
    const [c1] = known(1, 700);
    expect((await upload(m.id, `${c1}\n`)).statusCode).toBe(200);
    const r = await svc.http.inject({
      method: 'POST',
      url: `/v1/partner/productions/${m.id}/events`,
      headers: { ...adminOf(), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      payload: JSON.stringify({ openAt: '2026-11-21T11:00:00Z', startsAt: '2026-12-30T10:00:00Z', endsAt: '2026-12-30T12:00:00Z' }),
    });
    expect(r.statusCode).toBe(201);
    expect((await lists(m.id))[0]!.destroyDueAt.toISOString()).toBe('2026-12-30T10:00:00.000Z');
  });
});

describe('판매 자격 명단 잠금(Q-T36 ⑤)', () => {
  test('Q-T36 ⑤ 잠금 1ms 전 올리기는 200이고 잠금 시각의 올리기·지우기는 409이며 구성원·판이 그대로다 [ASVS v5.0.0-2.3.2] [ASVS v5.0.0-16.3.3]', async () => {
    const m = await makeProduction({ rules: [presale()] });
    const [c1, c2] = known(2, 100);
    // 판매 시작 2026-11-20T20:00+09:00(11:00Z) − 24시간 = 2026-11-19T11:00Z
    const lockAt = Date.parse('2026-11-19T11:00:00Z');
    now = lockAt - 1;
    const r = await upload(m.id, `${c1}\n`);
    expect(r.statusCode).toBe(200);
    const [l] = await lists(m.id);
    expect([l!.version, l!.lockedAt?.toISOString(), await members(l!.id)]).toEqual([1, '2026-11-19T11:00:00.000Z', [accounts.get(c1)]]);
    now = lockAt;
    calls.length = 0;
    const again = await upload(m.id, `${c2}\n`);
    expect([again.statusCode, problem(again).type]).toEqual([409, `${P}sale-eligibility-list-locked`]);
    const del = await remove(m.id);
    expect([del.statusCode, problem(del).type]).toEqual([409, `${P}sale-eligibility-list-locked`]);
    // 잠긴 명단을 바꾸려 한 것은 보안 사건이고 변환을 부르지 않았다. 명단은 그대로다
    expect(calls).toEqual([]);
    expect(logs.lines().filter((x) => x.event === 'sale_eligibility_locked_attempt' && x.productionId === m.id && x.kind === 'security')).toHaveLength(2);
    const [after] = await lists(m.id);
    expect([after!.version, after!.memberCount, await members(after!.id)]).toEqual([1, 1, [accounts.get(c1)]]);
  });

  test('Q-T36 ⑤ 해석과 트랜잭션 사이에 잠금 시각이 지나면 409다(트랜잭션 안에서 다시 본다)', async () => {
    const m = await makeProduction({ rules: [presale()] });
    const [c1] = known(1, 200);
    const lockAt = Date.parse('2026-11-19T11:00:00Z');
    now = lockAt - 1;
    // 앞 확인은 잠금 전에 지났고, 변환하는 사이에 잠금 시각이 된다
    beforeAnswer = () => {
      now = lockAt;
    };
    const r = await upload(m.id, `${c1}\n`);
    expect([r.statusCode, problem(r).type, calls]).toEqual([409, `${P}sale-eligibility-list-locked`, [1]]);
    expect(await lists(m.id)).toEqual([]);
  });

  test('공연당 명단 11번째 새 키는 409·50만 1줄은 422이고, 변환하는 사이에 다른 올리기가 10번째를 채워도 트랜잭션 안에서 막는다 [ASVS v5.0.0-2.3.2]', async () => {
    const m = await makeProduction();
    const [c] = known(1, 300);
    for (let i = 0; i < 9; i++) expect((await upload(m.id, `${c}\n`, { key: `list-${i}` })).statusCode).toBe(200);
    // list-9를 올리는 동안(변환 중) list-10이 먼저 끝나면 list-9는 11번째 새 키다
    let inner: Promise<{ statusCode: number }> | undefined;
    beforeAnswer = async () => {
      if (inner) return;
      beforeAnswer = undefined;
      inner = upload(m.id, `${c}\n`, { key: 'list-10' });
      expect((await inner).statusCode).toBe(200);
    };
    const r = await upload(m.id, `${c}\n`, { key: 'list-9' });
    expect([r.statusCode, problem(r).type]).toEqual([409, `${P}sale-eligibility-list-limit`]);
    expect((await lists(m.id)).map((l) => l.key).sort()).toEqual([...Array.from({ length: 9 }, (_, i) => `list-${i}`), 'list-10'].sort());
    calls.length = 0;
    expect(problem(await upload(m.id, `${c}\n`, { key: 'list-11' })).type).toBe(`${P}sale-eligibility-list-limit`);
    expect(calls).toEqual([]);
    const over = await upload(m.id, 'x\n'.repeat(500_001), { key: 'list-0' });
    expect([over.statusCode, problem(over).detail]).toEqual([422, '50만 줄을 넘었다']);
  }, 60_000);
});

describe('판매 자격 명단 올리기 결과와 기록(Q-T36 ⑥)', () => {
  test('Q-T36 ⑥ 결과는 반영 수·오류 줄 번호·SHA-256뿐이고 파일·회원 코드가 DB와 로그에 없으며 감사 줄 칸이 정해진 것뿐이다 [ASVS v5.0.0-14.1.1] [ASVS v5.0.0-14.1.2] [ASVS v5.0.0-14.2.4] [ASVS v5.0.0-16.2.5]', async () => {
    const m = await makeProduction({ rounds: 2, rules: [presale()] });
    const [c1, c2] = known(2, 400);
    const missing = code(450);
    const text = `${c1}\n"${c2.toLowerCase()}"\r\nbad line\n\n${missing}\n${c1}\n`;
    const who = adminOf();
    const r = await upload(m.id, text, { headers: who });
    expect(r.statusCode).toBe(200);
    const sha = createHash('sha256').update(text).digest('hex');
    expect(JSON.parse(r.payload)).toEqual({ listKey: KEY, version: 1, applied: 2, invalidLineCount: 1, invalidLines: [3], unknownLineCount: 1, unknownLines: [5], fileSha256: sha });
    const [l] = await lists(m.id);
    expect([Buffer.from(l!.fileSha256).toString('hex'), l!.memberCount, l!.uploadedBy, await members(l!.id)]).toEqual([sha, 2, who['x-user-id'], [accounts.get(c1), accounts.get(c2)].sort()]);
    // DB 전체 글 검색: 회원 코드와 파일 글은 어느 표에도 없다
    const tables = (await admin.db.execute(sql`select tablename from pg_tables where schemaname = 'public'`)).rows as { tablename: string }[];
    let dump = '';
    for (const t of tables) dump += JSON.stringify((await admin.db.execute(sql.raw(`select row_to_json(whole_row)::text as j from "${t.tablename}" whole_row`))).rows);
    for (const needle of [c1, c2, missing, c2.toLowerCase(), 'bad line']) expect(dump).not.toContain(needle);
    // 로그에는 회원 코드·구성원 계정 ID가 없다
    for (const needle of [c1, c2, missing, accounts.get(c1)!, accounts.get(c2)!]) expect(logs.text()).not.toContain(needle);
    // 감사 줄: 올린 계정(로그 가명 accountRef, ADR-0053 결정 1)·공연·명단 키·시각·건수·파일 SHA-256(과 판)만
    const audit = logs.lines().filter((x) => x.event === 'sale_eligibility.uploaded' && x.productionId === m.id);
    expect(audit).toHaveLength(1);
    const own = Object.fromEntries(Object.entries(audit[0]!).filter(([k]) => ['kind', 'event', 'accountRef', 'productionId', 'listKey', 'at', 'version', 'applied', 'invalidLineCount', 'unknownLineCount', 'fileSha256'].includes(k)));
    expect(own).toEqual({ kind: 'security', event: 'sale_eligibility.uploaded', accountRef: pseudonym.ref(who['x-user-id']!), productionId: m.id, listKey: KEY, at: new Date(now).toISOString(), version: 1, applied: 2, invalidLineCount: 1, unknownLineCount: 1, fileSha256: sha });
    // 감사 줄에는 정한 칸 말고 플랫폼 공통 칸(시각·수준·서비스·추적 등)만 더 있다
    const extra = Object.keys(audit[0]!).filter((k) => !(k in own));
    for (const k of extra) expect(['level', 'time', 'service', 'env', 'version', 'msg', 'traceId', 'spanId', 'requestId', 'route', 'method', 'hostname', 'pid', 'pod', 'az', 'ts', 'severity', 'logger']).toContain(k);
    // 사본: 회차 둘·명단 키·판·계정 ID·수명(파기 시각)
    expect(copy.puts).toEqual([{ productionId: m.id, eventIds: m.events, listKey: KEY, version: (await lists(m.id))[0]!.copySeq, accountIds: [accounts.get(c1), accounts.get(c2)], expiresAt: new Date('2026-12-25T10:00:00Z') }]);
    expect((await lists(m.id))[0]!.copiedSeq).toBe((await lists(m.id))[0]!.copySeq);
    // 같은 키 다시 올리기는 옛 구성원이 하나도 남지 않는다. 이번에는 사본 넘기기가 실패해도(올리기·정비 일의 경고 줄) 기록에 회원 코드·계정 ID가 없다(틀린 구현 검사 BAT-157)
    const [c3] = known(1, 460);
    copy.failing = true;
    expect(JSON.parse((await upload(m.id, `${c3}\n`)).payload)).toMatchObject({ version: 2, applied: 1 });
    expect(await members(l!.id)).toEqual([accounts.get(c3)]);
    const maint: Record<string, unknown>[] = [];
    const retry = saleEligibilityMaintenanceTasks(new DrizzleSaleMaintenanceStore(admin), copy, clock, { warn: (o) => maint.push(o as Record<string, unknown>) }, metrics).find((t) => t.name === 'sale-eligibility-copy')!;
    await expect(retry.run()).rejects.toThrow(/넘기지 못했다/);
    expect(logs.lines().some((x) => x.event === 'sale_eligibility_copy_failed' && x.productionId === m.id)).toBe(true);
    expect(maint.some((x) => x.event === 'sale_eligibility_copy_failed' && x.productionId === m.id)).toBe(true);
    for (const needle of [c3, accounts.get(c3)!]) expect(logs.text() + JSON.stringify(maint)).not.toContain(needle);
  });

  test('구성원 넣기 도중(두 번째 5,000행 묶음) DB가 실패하면 되돌려 옛 구성원·판이 그대로다', async () => {
    const m = await makeProduction();
    const first = known(2, 2_000_000);
    expect((await upload(m.id, `${first.join('\n')}\n`)).statusCode).toBe(200);
    const [before] = await lists(m.id);
    const next = known(5_001, 2_100_000);
    const poison = accounts.get(next[5_000]!)!;
    // 5,001번째 계정을 넣을 때 실패하는 방아쇠(첫 묶음 5,000행은 이미 들어간 뒤다)
    await admin.db.execute(
      sql.raw(`create function poison_member() returns trigger language plpgsql as $$ begin if new.account_id = '${poison}' then raise exception '시험이 넣은 실패'; end if; return new; end $$;
        create trigger poison_member before insert on sale_eligibility_member for each row execute function poison_member();`),
    );
    try {
      const r = await upload(m.id, `${next.join('\n')}\n`);
      expect(r.statusCode).toBe(500);
    } finally {
      await admin.db.execute(sql.raw('drop trigger poison_member on sale_eligibility_member; drop function poison_member();'));
    }
    const [after] = await lists(m.id);
    expect([after!.version, after!.memberCount, await members(after!.id)]).toEqual([before!.version, 2, first.map((c) => accounts.get(c)).sort()]);
    // 사본에도 실패한 판을 넘기지 않았다
    expect(copy.puts.filter((p) => p.productionId === m.id).map((p) => p.version)).toEqual([before!.copySeq]);
  }, 60_000);

  test('identity 변환 50번 가운데 마지막 호출만 실패하면 503이고 아무것도 저장하지 않으며, 50만 줄 명단은 요청 시한 안에 올린다', async () => {
    const m = await makeProduction();
    const codes = known(500_000, 1_000_000);
    const text = `${codes.join('\n')}\n`;
    failAt = 50;
    const t0 = Date.now();
    const failed = await upload(m.id, text);
    expect([failed.statusCode, problem(failed).type, failed.headers['retry-after'], calls.length]).toEqual([503, `${P}member-code-lookup-unavailable`, '10', 50]);
    expect(calls.every((n) => n === 10_000)).toBe(true);
    expect(await lists(m.id)).toEqual([]);
    failAt = undefined;
    calls.length = 0;
    // 힙은 올리기 동안 50ms마다 재서 가장 큰 값과 시작 값의 차이를 본다(시험 프로세스 전체라 어림이다)
    const heap0 = process.memoryUsage().heapUsed;
    let peak = heap0;
    const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed)), 50);
    const t1 = Date.now();
    const ok = await upload(m.id, text);
    const ms = Date.now() - t1;
    clearInterval(sampler);
    const mb = (n: number) => Math.round(n / 1024 / 1024);
    expect([ok.statusCode, JSON.parse(ok.payload).applied, calls.length]).toEqual([200, 500_000, 50]);
    const [l] = await lists(m.id);
    expect((await admin.db.execute(sql`select count(*)::int as n from sale_eligibility_member where list_id = ${l!.id}`)).rows).toEqual([{ n: 500_000 }]);
    console.log(`판매 자격 명단 50만 줄: 실패 경로 ${t1 - t0}ms, 올리기 ${ms}ms, 힙 시작 ${mb(heap0)}MB·최대 ${mb(peak)}MB(시험 프로세스 전체, 서버와 identity 대역 포함)`);
    // 요청 시한 100초의 80%(80초)를 넘으면 비동기 올리기를 검토한다(ADR-0261 되돌릴 조건). CI가 이 PC보다 느려 상한만 둔다
    expect(ms).toBeLessThan(80_000);
  }, 300_000);
});

describe('판매 자격 명단 권한', () => {
  test('실무자의 명단 올리기·지우기는 403이고 다른 파트너 공연의 명단은 404이며 파트너 역할 행 보안은 남의 명단·구성원을 0건으로 본다 [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-16.3.2]', async () => {
    const m = await makeProduction();
    const theirs = await makeProduction({ tenant: B });
    const [c1] = known(1, 800);
    const member = identity.partner(A, 'partner_member');
    expect(problem(await upload(m.id, `${c1}\n`, { headers: member })).type).toBe(`${P}partner-admin-required`);
    expect(problem(await remove(m.id, KEY, member)).type).toBe(`${P}partner-admin-required`);
    expect(problem(await upload(theirs.id, `${c1}\n`)).type).toBe(`${P}not-found`);
    expect((await upload(theirs.id, `${c1}\n`, { headers: adminOf(B) })).statusCode).toBe(200);
    expect(problem(await remove(theirs.id)).type).toBe(`${P}not-found`);
    expect(problem(await svc.http.inject({ method: 'GET', url: url(theirs.id), headers: adminOf() })).type).toBe(`${P}not-found`);
    expect(calls).toEqual([1]);
    const denied = logs.lines().filter((x) => x.event === 'partner_production_denied' && x.route === 'sale_eligibility' && (x.productionId === m.id || x.productionId === theirs.id));
    expect(denied.map((x) => [x.action, x.reason ?? null])).toEqual([
      ['upload', 'partner_admin_required'],
      ['delete', 'partner_admin_required'],
      ['upload', null],
      ['delete', null],
      ['list', null],
    ]);
    // 행 보안: A의 테넌트로는 조건 없이 읽어도 B의 명단·구성원이 0건이다(B의 행은 있다)
    const [bList] = await lists(theirs.id);
    expect(await members(bList!.id)).toHaveLength(1);
    const seen = await partnerDb.transaction(async (tx) => ({ l: await tx.select().from(saleEligibilityList), m: await tx.select().from(saleEligibilityMember) }), { tenantId: A });
    expect(seen.l.filter((l) => l.promoterId === B)).toEqual([]);
    expect(seen.m.filter((x) => x.promoterId === B || x.listId === bList!.id)).toEqual([]);
  });
});

// ---------- 리뷰 재현(2026-11-10) ----------

describe('리뷰 재현: 사본 판(copy_seq)과 다시 넘기기(H1·S1)', () => {
  const copiedOf = async (productionId: string) => (await lists(productionId)).map((l) => [l.key, l.copySeq, l.copiedSeq]);
  const putsOf = (productionId: string) => copy.puts.filter((p) => p.productionId === productionId);

  test('H1 명단을 먼저 올리고 규칙을 저장하면 정비가 바뀐 회차 목록을 더 큰 판으로 다시 넘긴다', async () => {
    const m = await makeProduction({ rounds: 2 });
    const [c1] = known(1, 3_000_000);
    expect((await upload(m.id, `${c1}\n`)).statusCode).toBe(200);
    const first = putsOf(m.id)[0]!;
    expect(first.eventIds).toEqual([]);
    const r = await svc.http.inject({ method: 'PUT', url: `/v1/partner/productions/${m.id}/sale-policy`, headers: { ...adminOf(), 'content-type': 'application/json', 'if-match': '"1"' }, payload: JSON.stringify({ rules: [presale('2026-11-20T20:00:00+09:00', 'ALL')] }) });
    expect(r.statusCode).toBe(200);
    copy.puts.length = 0;
    await run('sale-eligibility-copy');
    const again = putsOf(m.id);
    expect(again.map((p) => [p.eventIds, p.listKey, p.expiresAt.toISOString()])).toEqual([[m.events, KEY, '2026-12-25T10:00:00.000Z']]);
    expect(again[0]!.version).toBeGreaterThan(first.version);
    const [[, seq, copied]] = (await copiedOf(m.id)) as [string, number, number][];
    expect(copied).toBe(seq);
  });

  test('H1 회차 더하기는 정비가 그 회차를 넣고 늦어진 수명으로 다시 넘기게 한다', async () => {
    const m = await makeProduction({ rules: [presale()] });
    const [c1] = known(1, 3_100_000);
    expect((await upload(m.id, `${c1}\n`)).statusCode).toBe(200);
    const before = putsOf(m.id)[0]!;
    const add = await svc.http.inject({
      method: 'POST',
      url: `/v1/partner/productions/${m.id}/events`,
      headers: { ...adminOf(), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      payload: JSON.stringify({ openAt: '2026-11-21T11:00:00Z', startsAt: '2026-12-30T10:00:00Z', endsAt: '2026-12-30T12:00:00Z' }),
    });
    expect(add.statusCode).toBe(201);
    const newEvent = JSON.parse(add.payload).eventId as string;
    copy.puts.length = 0;
    await run('sale-eligibility-copy');
    const [p] = putsOf(m.id);
    expect([p?.eventIds, p?.expiresAt.toISOString()]).toEqual([[...m.events, newEvent], '2026-12-30T10:00:00.000Z']);
    expect(p!.version).toBeGreaterThan(before.version);
  });

  test('H1 회차 시작을 늦추면 정비가 늦어진 수명으로 다시 넘긴다', async () => {
    const m = await makeProduction({ rules: [presale()] });
    const [c1] = known(1, 3_200_000);
    expect((await upload(m.id, `${c1}\n`)).statusCode).toBe(200);
    const r = await svc.http.inject({ method: 'PATCH', url: `/v1/partner/events/${m.events[0]}`, headers: { ...adminOf(), 'content-type': 'application/json', 'if-match': '"1"' }, payload: JSON.stringify({ startsAt: '2026-12-28T10:00:00Z', endsAt: '2026-12-28T12:00:00Z' }) });
    expect(r.statusCode).toBe(200);
    copy.puts.length = 0;
    await run('sale-eligibility-copy');
    expect(putsOf(m.id).map((p) => p.expiresAt.toISOString())).toEqual(['2026-12-28T10:00:00.000Z']);
  });

  test('H1 지웠다 같은 키로 다시 올려도 사본 판은 계속 커진다', async () => {
    const m = await makeProduction({ rules: [presale()] });
    const [c1] = known(1, 3_300_000);
    expect((await upload(m.id, `${c1}\n`)).statusCode).toBe(200);
    expect((await remove(m.id)).statusCode).toBe(204);
    expect((await upload(m.id, `${c1}\n`)).statusCode).toBe(200);
    const versions = putsOf(m.id).map((p) => p.version);
    const drops = copy.drops.filter((d) => d.listKey === KEY).map((d) => (d as { version?: number }).version);
    expect(versions).toHaveLength(2);
    expect(versions[1]!).toBeGreaterThan(drops.at(-1)!);
    expect(drops.at(-1)!).toBeGreaterThan(versions[0]!);
  });

  test('S1 지우기의 사본 지우기가 실패하면 지운 기록을 두고 정비가 성공할 때까지 판을 실어 다시 지우며, 파기 정비는 지우기 실패를 실패로 끝낸다', async () => {
    const m = await makeProduction({ rules: [presale()] });
    const [c1] = known(1, 3_400_000);
    expect((await upload(m.id, `${c1}\n`)).statusCode).toBe(200);
    copy.failing = true;
    expect((await remove(m.id)).statusCode).toBe(204);
    await expect(run('sale-eligibility-copy')).rejects.toThrow(/넘기지 못했다/);
    copy.failing = false;
    copy.drops.length = 0;
    await run('sale-eligibility-copy');
    expect(copy.drops.map((d) => [d.listKey, d.eventIds, typeof (d as { version?: number }).version])).toEqual([[KEY, m.events, 'number']]);
    copy.drops.length = 0;
    await run('sale-eligibility-copy');
    expect(copy.drops).toEqual([]);
    // 파기 정비: 사본 지우기가 실패하면 일을 실패로 끝낸다(기록은 남아 다음 정비가 다시 지운다)
    const p = await makeProduction({ rules: [presale()] });
    expect((await upload(p.id, `${c1}\n`)).statusCode).toBe(200);
    copy.failing = true;
    now = Date.parse('2026-12-24T10:00:00Z');
    await expect(run('sale-eligibility-purge')).rejects.toThrow();
    expect(await lists(p.id)).toEqual([]);
    copy.failing = false;
    copy.drops.length = 0;
    await run('sale-eligibility-copy');
    expect(copy.drops.some((d) => d.listKey === KEY && d.eventIds.includes(p.events[0]!))).toBe(true);
  });
});

describe('리뷰 재현: 잠금·횟수·운영 조립(S2·S5·S7·C1·C2)', () => {
  test('S2 창이 없는 규칙만 쓰는 명단은 그 규칙이 걸리는 회차 가운데 가장 이른 오픈 − 24시간에 잠긴다', async () => {
    const noWindow = { version: 1, name: '명단만', rounds: 'ALL', rule: { if: { fact: 'buyer.lists', has: KEY }, then: { limitPerPerson: 2 } } };
    const m = await makeProduction({ rounds: 2, rules: [noWindow] });
    await admin.db.update(event).set({ openAt: new Date('2026-11-18T11:00:00Z') }).where(eq(event.id, m.events[1]!));
    const [c1] = known(1, 3_500_000);
    const lockAt = Date.parse('2026-11-17T11:00:00Z');
    now = lockAt - 1;
    expect((await upload(m.id, `${c1}\n`)).statusCode).toBe(200);
    expect((await lists(m.id))[0]!.lockedAt?.toISOString()).toBe('2026-11-17T11:00:00.000Z');
    now = lockAt;
    expect(problem(await upload(m.id, `${c1}\n`)).type).toBe(`${P}sale-eligibility-list-locked`);
  });

  test('S5 한 시간에 21번째 올리기는 429 sale-eligibility-upload-limited이고 변환을 부르지 않는다(실제 DB) [ASVS v5.0.0-2.3.2]', async () => {
    const m = await makeProduction();
    const [c1] = known(1, 3_600_000);
    for (let i = 0; i < 20; i++) expect((await upload(m.id, `${c1}\n`)).statusCode).toBe(200);
    calls.length = 0;
    const r = await upload(m.id, `${c1}\n`);
    expect([r.statusCode, problem(r).type, r.headers['retry-after']]).toEqual([429, `${P}sale-eligibility-upload-limited`, '3600']);
    expect(calls).toEqual([]);
  });

  test('S7 정비 일은 정비 역할(core_maintenance) 연결로 파기·사본 다시 넘기기를 한다', async () => {
    const maint = await loginFor(admin, pg, 'core_maintenance_login', 'core_maintenance' as never, 2);
    try {
      const m = await makeProduction({ rules: [presale()] });
      const [c1] = known(1, 3_700_000);
      copy.failing = true;
      expect((await upload(m.id, `${c1}\n`)).statusCode).toBe(200);
      copy.failing = false;
      const t = saleEligibilityMaintenanceTasks(new DrizzleSaleMaintenanceStore(maint), copy, clock);
      await t.find((x) => x.name === 'sale-eligibility-copy')!.run();
      now = Date.parse('2026-12-24T10:00:00Z');
      await t.find((x) => x.name === 'sale-eligibility-purge')!.run();
      expect(await lists(m.id)).toEqual([]);
    } finally {
      await maint.close();
    }
  });

  test('C1·C2 사본을 쓰는 쪽이 없으면 정비는 구성원을 읽지 않고 넘길 명단 수만 지표로 내고, 올리기·사본 결과도 지표로 센다', async () => {
    const m = await makeProduction({ rules: [presale()] });
    const [c1] = known(1, 3_800_000);
    copy.failing = true;
    expect((await upload(m.id, `${c1}\n`)).statusCode).toBe(200);
    copy.failing = false;
    // 사본 넘기기 성공(다른 공연)과 잠금 시각의 올리기(locked 지표)도 이 시험 안에서 낸다(앞 시험에 기대지 않는다, 틀린 구현 검사 BAT-157)
    expect((await upload((await makeProduction({ rules: [presale()] })).id, `${c1}\n`)).statusCode).toBe(200);
    now = Date.parse('2026-11-19T11:00:00Z');
    expect((await upload(m.id, `${c1}\n`)).statusCode).toBe(409);
    now = Date.parse('2026-11-05T00:00:00Z');
    class Counting extends DrizzleSaleMaintenanceStore {
      reads = 0;
      override async copyData(l: Parameters<DrizzleSaleMaintenanceStore['copyData']>[0]) {
        this.reads++;
        return super.copyData(l);
      }
    }
    const store = new Counting(admin);
    const unwired = new UnwiredSaleEligibilityCopy();
    const out = await saleEligibilityMaintenanceTasks(store, unwired, clock, undefined, metrics).find((x) => x.name === 'sale-eligibility-copy')!.run();
    expect(store.reads).toBe(0);
    expect(out).toMatchObject({ unwired: true });
    // 서비스 쪽 지표(올리기 결과·사본 넘기기 결과)와 정비가 낸 넘길 명단 수(시험은 같은 지표 묶음을 서비스 등록부에 단다)
    const svcText = await svc.metrics.registry.metrics();
    expect(svcText).toMatch(/sale_eligibility_copy_pending [1-9]/);
    expect(svcText).toMatch(/sale_eligibility_upload_total\{result="ok"\} [1-9]/);
    expect(svcText).toMatch(/sale_eligibility_upload_total\{result="locked"\} [1-9]/);
    expect(svcText).toMatch(/sale_eligibility_copy_total\{result="failed"\} [1-9]/);
    expect(svcText).toMatch(/sale_eligibility_copy_total\{result="ok"\} [1-9]/);
  });
});

describe('리뷰 재현: 경합(C5, data.md §5 경합 줄)', () => {
  test('C5 같은 키의 두 올리기가 겹치면 나중에 커밋한 쪽이 이기고 사본도 나중 판이다', async () => {
    const m = await makeProduction({ rules: [presale()] });
    const [a, b] = known(2, 3_900_000);
    let inner: Promise<{ statusCode: number }> | undefined;
    beforeAnswer = async () => {
      if (inner) return;
      beforeAnswer = undefined;
      inner = upload(m.id, `${b}\n`);
      expect((await inner).statusCode).toBe(200);
    };
    expect((await upload(m.id, `${a}\n`)).statusCode).toBe(200);
    const [l] = await lists(m.id);
    expect([l!.version, await members(l!.id)]).toEqual([2, [accounts.get(a)]]);
    const puts = copy.puts.filter((p) => p.productionId === m.id);
    expect(puts.map((p) => p.accountIds)).toEqual([[accounts.get(b)], [accounts.get(a)]]);
    expect(puts[1]!.version).toBeGreaterThan(puts[0]!.version);
  });

  test('C5 변환하는 사이에 규칙이 저장되면 사본은 커밋 때의 규칙으로 회차를 고르고, 판매 중지되면 409다(잠금 안 다시 보기)', async () => {
    const m = await makeProduction({ rounds: 2 });
    const [a] = known(1, 4_000_000);
    beforeAnswer = async () => {
      beforeAnswer = undefined;
      const r = await svc.http.inject({ method: 'PUT', url: `/v1/partner/productions/${m.id}/sale-policy`, headers: { ...adminOf(), 'content-type': 'application/json', 'if-match': '"1"' }, payload: JSON.stringify({ rules: [presale('2026-11-20T20:00:00+09:00', [m.events[1]])] }) });
      expect(r.statusCode).toBe(200);
    };
    expect((await upload(m.id, `${a}\n`)).statusCode).toBe(200);
    expect(copy.puts.filter((p) => p.productionId === m.id).map((p) => p.eventIds)).toEqual([[m.events[1]]]);
    const s = await makeProduction({ approved: true });
    beforeAnswer = async () => {
      beforeAnswer = undefined;
      await admin.db.update(production).set({ saleReview: 'SUSPENDED' }).where(eq(production.id, s.id));
    };
    const r = await upload(s.id, `${a}\n`);
    expect([r.statusCode, problem(r).type]).toEqual([409, `${P}production-suspended`]);
    expect(await lists(s.id)).toEqual([]);
  });

  test('C5 파기 정비가 명단을 고른 뒤 회차 더하기·다시 올리기가 파기 시각을 늦추면 그 명단을 지우지 않는다', async () => {
    const m = await makeProduction({ rules: [presale()] });
    const [a] = known(1, 4_100_000);
    expect((await upload(m.id, `${a}\n`)).statusCode).toBe(200);
    const store = new DrizzleSaleMaintenanceStore(admin);
    now = Date.parse('2026-12-24T10:00:00Z');
    const due = (await store.dueForPurge(new Date(now), 1_000)).filter((l) => l.productionId === m.id);
    expect(due).toHaveLength(1);
    // 고른 뒤 회차를 더해 파기 시각이 2026-12-30T10:00Z로 늦어진다(승인 이력이 없는 공연)
    await admin.db.insert(event).values({ id: randomUUID(), productionId: m.id, promoterId: A, venueId: null, openAt: new Date('2026-12-20T11:00:00Z'), startsAt: new Date('2026-12-30T10:00:00Z'), endsAt: new Date('2026-12-30T12:00:00Z') });
    await admin.db.update(saleEligibilityList).set({ destroyDueAt: new Date('2026-12-30T10:00:00Z') }).where(eq(saleEligibilityList.productionId, m.id));
    expect(await store.purge(due[0]!, new Date(now), 5_000)).toBeUndefined();
    expect((await lists(m.id)).length).toBe(1);
    expect((await members((await lists(m.id))[0]!.id)).length).toBe(1);
  });
});

// ---------- 시작 파일 조립 ----------

describe('시작 파일(main.ts)과 relay 정비 일 조립', () => {
  test('운영 시작 파일로 띄운 앱이 명단 경로에 답하고 회원 코드 변환은 PEAKET_IDENTITY_GRPC_URL의 MemberCodeService를 부르며 사본은 늘 실패하는 어댑터이고, 빌드한 정비 일 조립이 일 둘을 낸다', async () => {
    buildDist();
    // 서비스가 쓰는 @peaket/validation/sale-policy는 빌드한 dist(default 조건)다
    execFileSync(process.execPath, [join(SERVICE_DIR, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: join(SERVICE_DIR, '../../packages/validation'), stdio: ['ignore', 'pipe', 'pipe'] });
    const [port, mgmt] = [await freePort(), await freePort()];
    const dir = await mkdtemp(join(tmpdir(), 'peaket-main-'));
    const base: Record<string, string> = {};
    for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[k]) base[k] = process.env[k]!;
    const env = {
      ...base,
      PEAKET_ENV: 'local',
      PORT: String(port),
      PEAKET_MANAGEMENT_PORT: String(mgmt),
      PEAKET_DATABASE_URL: pg.urlFor('core_app_login', 'peaket-test'),
      PEAKET_PARTNER_DATABASE_URL: pg.urlFor('core_partner_login', 'peaket-test'),
      PEAKET_IDENTITY_GRPC_URL: identityAddress,
      PEAKET_IMAGE_GRPC_URL: '127.0.0.1:1',
      PEAKET_SEATMAP_GRPC_URL: '127.0.0.1:1',
      PEAKET_IMAGE_BASE_URL: 'http://127.0.0.1:1',
      PEAKET_IMAGE_STORE_DIR: dir,
      PEAKET_PUBLIC_FILE_DIR: join(dir, 'public-files'),
    };
    const child: ChildProcess = spawn(process.execPath, ['dist/main.js'], { cwd: SERVICE_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout!.on('data', (d) => (text += String(d)));
    child.stderr!.on('data', (d) => (text += String(d)));
    const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
    try {
      await until(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${mgmt}/ready`)).status === 200;
        } catch {
          return false;
        }
      }, `core-svc 준비: ${text.slice(-500)}`, 30_000, 200);
      const m = await makeProduction({ rules: [presale()] });
      const [c1] = known(1, 900);
      const account = randomUUID();
      const session = randomUUID();
      authz.set(`${account}/${session}`, { valid: true, role: 'partner_admin', tenant_id: A });
      const { payload, contentType } = await multipart({ key: KEY, name: '명단' }, [{ name: 'l.csv', type: 'text/csv', bytes: new TextEncoder().encode(`${c1}\n`) }]);
      const r = await fetch(`http://127.0.0.1:${port}/v1/partner/productions/${m.id}/sale-eligibility-lists`, {
        method: 'POST',
        headers: { 'x-user-id': account, 'x-session-id': session, 'x-user-aud': 'partner', 'x-user-scope': '', 'content-type': contentType, 'x-requested-with': 'peaket-partner' },
        body: payload,
      });
      expect([r.status, r.headers.get('cache-control'), ((await r.json()) as { applied: number }).applied]).toEqual([200, 'no-store', 1]);
      expect(calls).toEqual([1]);
      // 사본을 쓰는 쪽이 정해지지 않아 넘기지 못했고(올리기는 200), 경고 지표가 올랐다
      expect((await lists(m.id))[0]!.copiedSeq).toBeNull();
      const metrics = await (await fetch(`http://127.0.0.1:${mgmt}/metrics`)).text();
      expect(metrics).toMatch(/sale_eligibility_copy_unwired_total\{op="put"\} 1/);
      const policy = await fetch(`http://127.0.0.1:${port}/v1/partner/productions/${m.id}/sale-policy`, { headers: { 'x-user-id': account, 'x-session-id': session, 'x-user-aud': 'partner', 'x-user-scope': '' } });
      expect([policy.status, policy.headers.get('etag')]).toEqual([200, '"1"']);
    } finally {
      child.kill();
      await exited;
      await rm(dir, { recursive: true, force: true });
    }
    // relay(dist/relay.js)는 Kafka·Lease가 있어야 떠서 여기서는 빌드한 정비 일 조립(dist/maintenance-tasks.js)을 따로 띄워 이름·주기와 실제 DB 실행을 본다
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { coreMaintenanceTasks } from './dist/maintenance-tasks.js'; import { createDatabase, systemClock } from '@peaket/platform';
         const db = createDatabase({ url: process.env.URL, applicationName: 'core-svc-maintenance-test', max: 1 });
         const { tasks } = coreMaintenanceTasks(db, systemClock, { PEAKET_ENV: 'local' });
         const purge = await tasks.find((t) => t.name === 'sale-eligibility-purge').run();
         console.log(JSON.stringify({ tasks: tasks.map((t) => [t.name, t.when]), purge }));
         await db.close();`,
      ],
      { cwd: SERVICE_DIR, env: { ...base, URL: pg.url }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const line = out.split('\n').find((l) => l.startsWith('{"tasks"'))!;
    expect(JSON.parse(line)).toMatchObject({ tasks: [['sale-eligibility-purge', 'daily'], ['sale-eligibility-copy', 'daily']], purge: { purged: 0, dropFailed: 0 } });
  }, 180_000);
});
