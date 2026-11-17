// BAT-420 웨이브 끝 리뷰 반영 ops-svc 몫(시험 담당, 구현 전에 씀, 계획 §11 보충 4 1a614548): K4 확정 중 끊겨 RUNNING인데 일괄 환불이 없을 때의 다시 확정,
// 되돌리기 저장 실패의 오류 로그·지표, S2 파트너 경로 전용 저장소·commander 요청의 promoter_id·파트너 DB 풀 주소.
// 정본: docs/features/transfer-refund.md §5 '판정·미리보기·확정의 차례'(RUNNING 고착 다시 확정), docs/security/authz-matrix.md §5.3 'ops-svc 구현'.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { partnerDatabaseUrlFromEnv } from '../src/event-cancellation-wiring.js';
import type { EventCancellationRecord, PartnerEventCancellationInput, PartnerEventCancellationStore } from '../src/modules/event-cancellations/index.js';
// 검증 2 M-S2b-app(시험 담당 l3w8-420-surv-test)
import type { DynamicModule } from '@nestjs/common';
import type { Database } from '@peaket/platform';
import { AppModule } from '../src/app.module.js';
import { EventCancellations, EventCancellationsModule, type EventOwnerLookup } from '../src/modules/event-cancellations/index.js';
import { COMMANDER_A, DRY_RUN, EVENT, NOW, OPERATOR_B, PARTNER_ADMIN, TENANT, approveBy, fixture, idemOf, ownEvent, problem, recordOf, requested, tokenFor } from './event-cancellation-fixtures.js';

const HOLD_MS = 259_200_000;
/** 확정 중 끊겨 RUNNING에 머문 요청(판정자 COMMANDER_A, 확정자 OPERATOR_B) */
const stuck = (over: Partial<EventCancellationRecord> = {}) =>
  recordOf({
    status: 'RUNNING',
    fault: 'ORGANIZER',
    judgementReason: '주최 측 귀책',
    fanNoticeReason: '공연이 취소되었습니다',
    judgedBy: COMMANDER_A.accountId,
    judgedAt: new Date(NOW - 30_000),
    approvedBy: OPERATOR_B.accountId,
    approvedAt: new Date(NOW - 20_000),
    dryRun: DRY_RUN,
    version: 3,
    ...over,
  });

describe('RUNNING 고착 다시 확정 [BAT-420 웨이브 끝 리뷰 K4]', () => {
  test('GAT-110 K4 확정 중 끊겨 RUNNING인데 purchase에 일괄 환불이 없으면(job 없음) 다시 확정이 같은 요청 ID로 미룸 늘리기·판매 멈춤·Start를 한 번씩 다시 하고 RUNNING이다', async () => {
    const f = fixture();
    const r = stuck();
    await f.store.insert(r);
    f.behaviour.jobMissing = true;
    const out = await approveBy(f, r.requestId);
    expect(out).toMatchObject({ requestId: r.requestId, status: 'RUNNING' });
    expect(f.jobCalls).toEqual([r.requestId]);
    expect(f.holdCalls).toEqual([{ eventId: EVENT, requestId: r.requestId, held: true, expiresAtMs: NOW + HOLD_MS }]);
    expect(f.stopCalls).toEqual([{ eventId: EVENT, requestId: r.requestId }]);
    expect(f.startCalls.map((c) => c.requestId)).toEqual([r.requestId]);
    expect(f.store.rows.get(r.requestId)!.status).toBe('RUNNING');
  });

  test('GAT-110 K4 일괄 환불이 있으면(job 있음) 409 already-approved이고 바깥 호출이 없다(중복 시작 막기)', async () => {
    const f = fixture();
    const r = stuck();
    await f.store.insert(r);
    await expect(approveBy(f, r.requestId)).rejects.toMatchObject(problem('already-approved', 409));
    expect(f.holdCalls).toEqual([]);
    expect(f.stopCalls).toEqual([]);
    expect(f.startCalls).toEqual([]);
  });

  test('GAT-110 K4 job 읽기가 던지면 없음으로 보지 않고 503이며 바깥 호출이 없다', async () => {
    const f = fixture();
    const r = stuck();
    await f.store.insert(r);
    f.behaviour.jobFails = true;
    await expect(approveBy(f, r.requestId)).rejects.toMatchObject({ status: 503 });
    expect(f.holdCalls).toEqual([]);
    expect(f.stopCalls).toEqual([]);
    expect(f.startCalls).toEqual([]);
    expect(f.store.rows.get(r.requestId)!.status).toBe('RUNNING');
  });

  // 검증 2 X16(시험 담당 l3w8-420-surv-test, 2026-11-17): 진행률 읽기(purchase gRPC reader)가 조립되지 않으면 일괄 환불이 없는지 알 수 없다.
  // 정본 '읽기가 실패하면 503 event-refund-unavailable'(transfer-refund §5 '판정·미리보기·확정의 차례' 예외)과 같게 닫혀야 하고, 확인 없이 다시 확정으로 이어 가면 안 된다
  test('GAT-110 K4 진행률 읽기(reader)가 조립되지 않았으면 일괄 환불이 없는지 확인할 수 없어 503 event-refund-unavailable이고 바깥 호출·저장이 없다', async () => {
    const f = fixture({ without: ['reader'] });
    const r = stuck();
    await f.store.insert(r);
    const before = { ...f.store.rows.get(r.requestId)! };
    await expect(approveBy(f, r.requestId)).rejects.toMatchObject(problem('event-refund-unavailable', 503));
    expect(f.jobCalls).toEqual([]);
    expect(f.holdCalls).toEqual([]);
    expect(f.stopCalls).toEqual([]);
    expect(f.startCalls).toEqual([]);
    expect(f.store.rows.get(r.requestId)).toMatchObject({ status: 'RUNNING', version: before.version, approvedBy: before.approvedBy });
  });

  test('GAT-110 K4 다시 확정도 판정자 본인은 403 approver-ineligible이고 재인증이 틀리면 403이다(job을 묻지 않는다)', async () => {
    const f = fixture();
    const r = stuck();
    await f.store.insert(r);
    f.behaviour.jobMissing = true;
    await expect(f.app.approve(r.requestId, COMMANDER_A, tokenFor(COMMANDER_A.accountId))).rejects.toMatchObject(problem('approver-ineligible', 403));
    await expect(f.app.approve(r.requestId, OPERATOR_B, 'wrong-token')).rejects.toMatchObject({ status: 403 });
    expect(f.startCalls).toEqual([]);
  });

  test('GAT-110 K4 Start가 던지고 되돌리기 저장도 실패하면 원래 오류를 주고 오류 로그 event-cancellation-revert-failed 한 번과 지표 하나를 남긴다', async () => {
    const f = fixture();
    const r = await requested(f);
    await f.app.judge(r.requestId, { fault: 'ORGANIZER', reason: '주최 측 귀책', fanNoticeReason: '공연이 취소되었습니다' }, COMMANDER_A);
    f.behaviour.startFails = true;
    const save = f.store.save.bind(f.store);
    f.store.save = async (rec, audit) => {
      if (rec.status === 'PENDING_APPROVAL' && rec.approvedBy === null && f.startCalls.length > 0) throw new Error('db down on revert');
      return save(rec, audit);
    };
    const err = await approveBy(f, r.requestId).catch((e: unknown) => e);
    expect(String(err)).not.toContain('db down on revert');
    const reverted = f.errors.filter((e) => JSON.stringify(e).includes('event-cancellation-revert-failed'));
    expect(reverted).toHaveLength(1);
    expect(JSON.stringify(reverted[0])).toContain(r.requestId);
    expect(f.revertFailures.n).toBe(1);
  });
});

describe('파트너 경로 전용 저장소·promoter_id [BAT-420 웨이브 끝 리뷰 S2]', () => {
  const CANCEL: PartnerEventCancellationInput = { kind: 'CANCEL', reason: '공연장 대관 취소', evidenceRef: '대관 취소 통지 제2026-118호' };
  const recordingPartnerStore = () => {
    const calls: { insert: [string, EventCancellationRecord][]; latest: [string, string][] } = { insert: [], latest: [] };
    const rows: EventCancellationRecord[] = [];
    const store: PartnerEventCancellationStore = {
      insertAsTenant: async (tenantId, record) => {
        calls.insert.push([tenantId, record]);
        rows.push(record);
      },
      latestForEventAsTenant: async (tenantId, eventId) => {
        calls.latest.push([tenantId, eventId]);
        return rows.filter((x) => x.eventId === eventId && x.promoterId === tenantId).at(-1);
      },
    };
    return { calls, store };
  };

  test('GAT-110 S2 [ASVS v5.0.0-8.4.1] 파트너 요청·상태 조회는 파트너 저장소만 세션 테넌트로 부르고 관제 저장소에는 쓰지도 읽지도 않는다', async () => {
    const p = recordingPartnerStore();
    const f = fixture({ partnerStore: p.store });
    const eventId = ownEvent(f);
    let mainReads = 0;
    const list = f.store.list.bind(f.store);
    f.store.list = async (q) => (mainReads++, list(q));
    const view = await f.app.requestByPartner(eventId, CANCEL, PARTNER_ADMIN, idemOf(PARTNER_ADMIN.accountId, randomUUID(), JSON.stringify(CANCEL), 'CREATE_PARTNER_EVENT_CANCELLATION'));
    expect(p.calls.insert).toHaveLength(1);
    expect(p.calls.insert[0]![0]).toBe(TENANT);
    expect(p.calls.insert[0]![1]).toMatchObject({ requestId: view.requestId, eventId, requestedVia: 'PARTNER', promoterId: TENANT });
    expect(f.store.rows.size).toBe(0);
    await f.app.partnerStatus(eventId, PARTNER_ADMIN.tenantId);
    expect(p.calls.latest).toEqual([[TENANT, eventId]]);
    expect(mainReads).toBe(0);
  });

  test('GAT-110 S2 commander 요청도 회차의 promoterId를 적어 그 파트너의 상태에 보이고, 판매 설정을 못 읽으면 503 authz-unavailable·행 0이다', async () => {
    const f = fixture();
    ownEvent(f, { eventId: EVENT });
    const r = await requested(f);
    expect(f.store.rows.get(r.requestId)).toMatchObject({ requestedVia: 'COMMANDER', promoterId: TENANT });

    const g = fixture();
    g.behaviour.owners.set(EVENT, 'throw');
    g.behaviour.suspended.add(EVENT);
    await expect(g.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER_A, tokenFor(COMMANDER_A.accountId), idemOf(COMMANDER_A.accountId))).rejects.toMatchObject(
      problem('authz-unavailable', 503),
    );
    expect(g.store.rows.size).toBe(0);
  });

  test('GAT-110 S2 파트너 DB 풀 주소는 PEAKET_PARTNER_DATABASE_URL이고, 없으면 local·ci만 관제 주소를 쓰며 운영·스테이징·환경 없음은 시작하지 않는다', () => {
    const main = 'postgres://ops@db/ops';
    expect(partnerDatabaseUrlFromEnv({ PEAKET_ENV: 'production', PEAKET_PARTNER_DATABASE_URL: 'postgres://ops_partner@db/ops' }, main)).toBe('postgres://ops_partner@db/ops');
    for (const PEAKET_ENV of ['local', 'ci']) expect(partnerDatabaseUrlFromEnv({ PEAKET_ENV }, main)).toBe(main);
    for (const env of [{ PEAKET_ENV: 'production' }, { PEAKET_ENV: 'staging' }, {}]) expect(() => partnerDatabaseUrlFromEnv(env, main), JSON.stringify(env)).toThrow();
  });

  // 검증 2 M-S2b-main(시험 담당 l3w8-420-surv-test, 2026-11-17): 옛 시험은 함수 이름이 글에 있는지만 봤다. 이름대로 '받은 주소로 따로 풀을 만들어 AppModule에 넘긴다'를 글에서 본다.
  // 실제로 main.ts를 띄워 넘긴 풀이 다른지 보는 동작 시험은 test/event-cancellation-main-wiring.test.ts다
  test('GAT-110 S2 ops main.ts는 partnerDatabaseUrlFromEnv로 받은 파트너 주소가 관제 주소와 다르면 그 주소로 따로 풀을 만들어 AppModule.register에 partnerDatabase로 넘긴다(글)', () => {
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const urlVar = /const\s+(\w+)\s*=\s*partnerDatabaseUrlFromEnv\(\s*process\.env\s*,\s*url\s*\)/.exec(source)?.[1];
    expect(urlVar, 'partnerDatabaseUrlFromEnv(process.env, url)를 받는 변수').toBeDefined();
    const poolDecl = new RegExp(`const\\s+partnerDatabase\\s*=\\s*${urlVar}\\s*===\\s*url\\s*\\?\\s*database\\s*:\\s*createDatabase\\(\\{\\s*url:\\s*${urlVar}\\b`).exec(source);
    expect(poolDecl, '주소가 같을 때만 관제 풀을 함께 쓰고, 다르면 파트너 주소로 createDatabase').not.toBeNull();
    const register = source.slice(source.indexOf('AppModule.register('), source.indexOf('AppModule.register(') + 600);
    expect(register).toMatch(/\bpartnerDatabase\s*[,}]/);
  });

  // 검증 2 M-S2b-app(시험 담당 l3w8-420-surv-test, 2026-11-17): authz-matrix §5.3 'ops-svc 구현' — 파트너 경로는 PEAKET_PARTNER_DATABASE_URL의 풀(ops_partner)로만 접속한다.
  // AppModule.register가 실제로 조립한 회차 취소 쓰임새를 꺼내 파트너 상태·요청을 부르고, 어느 풀에 SQL이 갔는지 가짜 DB 둘로 센다(관제 풀 0)
  test('GAT-110 S2 [ASVS v5.0.0-8.4.1] AppModule.register({ database, partnerDatabase })가 조립한 파트너 상태·요청은 파트너 풀에만 세션 테넌트로 접속하고 관제 풀에는 SQL을 하나도 보내지 않는다', async () => {
    const fakeDatabase = () => {
      const calls: { kind: string; options?: unknown }[] = [];
      const tx = { execute: async () => (calls.push({ kind: 'tx.execute' }), { rows: [] }) };
      const database = {
        db: { execute: async () => (calls.push({ kind: 'db.execute' }), { rows: [] }) },
        pool: { query: async () => (calls.push({ kind: 'pool.query' }), { rows: [] }) },
        transaction: async <T>(fn: (t: typeof tx) => Promise<T>, options?: unknown) => (calls.push({ kind: 'transaction', options }), fn(tx)),
        close: async () => undefined,
      } as unknown as Database;
      return { database, calls };
    };
    const ops = fakeDatabase();
    const partner = fakeDatabase();
    const startsAtMs = NOW + 10 * 86_400_000;
    const eventId = randomUUID();
    const owners: EventOwnerLookup = { find: async (id) => (id === eventId ? { promoterId: TENANT, startsAtMs, endsAtMs: startsAtMs + 3 * 3_600_000 } : undefined) };
    const mod = AppModule.register({ database: ops.database, partnerDatabase: partner.database, eventCancellations: { owners } });
    const ec = (mod.imports ?? []).find((m) => (m as DynamicModule).module === EventCancellationsModule) as DynamicModule | undefined;
    const provider = ec?.providers?.find((p) => (p as { provide?: unknown }).provide === EventCancellations) as { useFactory: (clock: { now(): number }, logger: object) => EventCancellations } | undefined;
    expect(provider, 'AppModule이 회차 취소 쓰임새를 싣는다').toBeDefined();
    const app = provider!.useFactory({ now: () => NOW }, { warn: () => undefined, error: () => undefined, info: () => undefined });
    // 상태: 파트너 풀의 읽기 전용 트랜잭션 하나(세션 테넌트). 행이 없으면 404
    await expect(app.partnerStatus(eventId, TENANT)).rejects.toMatchObject({ status: 404 });
    expect(partner.calls.filter((c) => c.kind === 'transaction')).toEqual([{ kind: 'transaction', options: { tenantId: TENANT, accessMode: 'read only' } }]);
    // 요청(연기: 미룸을 걸지 않는다): 파트너 풀의 트랜잭션만이고 모두 세션 테넌트를 건다. 가짜 DB가 빈 행을 주므로 끝까지 가지 않아도 된다
    const POSTPONE: PartnerEventCancellationInput = { kind: 'POSTPONE', reason: '공연장 사정', evidenceRef: '대관 변경 통지', newStartsAt: new Date(startsAtMs + 7 * 86_400_000).toISOString() };
    await app.requestByPartner(eventId, POSTPONE, PARTNER_ADMIN, idemOf(PARTNER_ADMIN.accountId, randomUUID(), JSON.stringify(POSTPONE), 'CREATE_PARTNER_EVENT_CANCELLATION')).catch(() => undefined);
    const txs = partner.calls.filter((c) => c.kind === 'transaction');
    expect(txs.length).toBeGreaterThanOrEqual(2);
    for (const t of txs) expect(t.options).toMatchObject({ tenantId: TENANT });
    expect(partner.calls.some((c) => c.kind === 'tx.execute')).toBe(true);
    expect(ops.calls).toEqual([]);
  });
});
