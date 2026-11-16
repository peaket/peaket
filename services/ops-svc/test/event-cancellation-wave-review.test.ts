// BAT-420 웨이브 끝 리뷰 반영 ops-svc 몫(시험 담당, 구현 전에 씀, 계획 §11 보충 4 1a614548): K4 확정 중 끊겨 RUNNING인데 일괄 환불이 없을 때의 다시 확정,
// 되돌리기 저장 실패의 오류 로그·지표, S2 파트너 경로 전용 저장소·commander 요청의 promoter_id·파트너 DB 풀 주소.
// 정본: docs/features/transfer-refund.md §5 '판정·미리보기·확정의 차례'(RUNNING 고착 다시 확정), docs/security/authz-matrix.md §5.3 'ops-svc 구현'.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { partnerDatabaseUrlFromEnv } from '../src/event-cancellation-wiring.js';
import type { EventCancellationRecord, PartnerEventCancellationInput, PartnerEventCancellationStore } from '../src/modules/event-cancellations/index.js';
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

  test('GAT-110 S2 ops main.ts는 파트너 DB 풀 주소를 partnerDatabaseUrlFromEnv로 받아 조립한다', () => {
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    expect(source).toContain('partnerDatabaseUrlFromEnv(');
  });
});
