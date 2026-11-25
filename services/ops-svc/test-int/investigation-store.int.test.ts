// F-04-12 ops DB 저장소 통합 시험(동결 로컬, LCH-260, FX-T12).
// 실제 PostgreSQL 18 컨테이너에 마이그레이션 0035를 적용하고 저장소의 판 조건부 갱신·덧붙이기·제약·검증 칸을 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { DrizzleInvestigationStore } from '../src/modules/investigations/index.js';
import type { FraudCaseRecord, FraudClusterMemberRecord, FraudClusterRecord, FraudRunRecord, FraudSnapshotRecord } from '../src/modules/investigations/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-25T00:00:00.000Z');
const SHOW = Date.parse('2026-12-02T10:00:00.000Z');
const CANCEL = SHOW - 26 * HOUR;
const EVENT = '0194b210-0000-7000-8000-000000000001';
const CLUSTER = '0194b210-0000-7000-8000-000000000101';
const CLUSTER2 = '0194b210-0000-7000-8000-000000000102';
const CASE = '0194b210-0000-7000-8000-000000000201';
const ACTOR = '0194b210-0000-7000-8000-000000000301';
const ACC = (n: number) => `0194b210-0000-7000-8000-${String(0x1000 + n).padStart(12, '0')}`;
const hex = (c: string) => c.repeat(64);

let container: PostgresContainer | undefined;
let db: Database;
let raw: pg.Client;
let store: DrizzleInvestigationStore;

const member = (accountId: string, o: Partial<FraudClusterMemberRecord> = {}): FraudClusterMemberRecord => ({
  accountId,
  ticketCount: 9,
  signals: ['LINK_GRAPH'],
  addedBy: 'SYSTEM',
  removedAtMs: null,
  appealResult: 'NOT_REQUESTED',
  appealDueAtMs: null,
  lockExpiresAtMs: null,
  ...o,
});

const cluster = (clusterId: string, accounts: readonly string[], o: Partial<FraudClusterRecord> = {}): FraudClusterRecord => ({
  clusterId,
  eventId: EVENT,
  generation: 1,
  scoreBand: 'HIGH',
  accountCount: accounts.length,
  purchaseCount: accounts.length * 9,
  limitPerPerson: 4,
  sharedAttributes: ['PAYMENT_METHOD'],
  signals: ['LINK_GRAPH'],
  snapshotVersion: 1,
  createdAtMs: NOW - HOUR,
  members: accounts.map((a) => member(a)),
  ...o,
});

const run = (o: Partial<FraudRunRecord> = {}): FraudRunRecord => ({
  eventId: EVENT,
  generation: 1,
  attempt: 1,
  trigger: 'SCHEDULED',
  snapshotVersion: 1,
  ruleVersion: 'fraud-rules-v1',
  status: 'DONE',
  failureReason: null,
  resultFingerprint: hex('c'),
  clusterCount: 2,
  startedAtMs: NOW - 2 * HOUR,
  finishedAtMs: NOW - HOUR,
  ...o,
});

const snapshot = (o: Partial<FraudSnapshotRecord> = {}): FraudSnapshotRecord => ({
  eventId: EVENT,
  version: 1,
  frozenAtMs: NOW - HOUR,
  invHash: hex('b'),
  prevHash: null,
  tableHashes: { inv_request: hex('1'), inv_step: hex('2'), inv_behavior: hex('3'), inv_link: hex('4') },
  rowCounts: { inv_request: 10, inv_step: 20, inv_behavior: 30, inv_link: 40 },
  rangeFromMs: null,
  late: false,
  verifyStatus: null,
  verifiedAtMs: null,
  ...o,
});

const caseRecord = (o: Partial<FraudCaseRecord> = {}): FraudCaseRecord => ({
  caseId: CASE,
  eventId: EVENT,
  clusterId: CLUSTER,
  status: 'INVESTIGATING',
  reasonCategory: 'MACRO_BOT',
  assigneeId: ACTOR,
  cancelDeadlineAtMs: CANCEL,
  appealDueAtMs: null,
  approvalId: null,
  investigatorOpinion: null,
  outcomeLabel: null,
  version: 1,
  createdAtMs: NOW - HOUR,
  closedAtMs: null,
  members: [member(ACC(1)), member(ACC(2))],
  events: [{ seq: 1, kind: 'CREATED', actorId: ACTOR, note: null, detail: { reason: '시드' }, occurredAtMs: NOW - HOUR }],
  ...o,
});

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-investigations-it' });
  raw = new pg.Client({ connectionString: container.url });
  await raw.connect();
  store = new DrizzleInvestigationStore(db);
}, 180_000);

afterAll(async () => {
  await raw?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  container?.stop();
});

describe('F-04-12 ops DB 저장소(PostgreSQL)', () => {
  test('FX-T12 ㉓ Postgres 저장소는 사건 판을 조건부로 올리고 사건 기록을 덧붙이기만 한다', async () => {
    await store.putCase(caseRecord());
    const first = await store.getCase(CASE);
    expect(first).toMatchObject({ caseId: CASE, version: 1, status: 'INVESTIGATING' });
    expect(first!.events.map((e: { kind: string }) => e.kind)).toEqual(['CREATED']);
    const next = caseRecord({ version: 2 });
    // 사건 기록은 덧붙이기만 한다: 두 번째 사건 기록과 판 올리기가 함께 성공한다
    const ok = await store.updateCase(
      { ...next, investigatorOpinion: '의견' },
      1,
      [{ seq: 2, kind: 'NOTE', actorId: ACTOR, note: '메모', detail: { reason: '확인' }, occurredAtMs: NOW }],
    );
    expect(ok).toBe(true);
    const second = await store.getCase(CASE);
    expect(second!.version).toBe(2);
    expect(second!.investigatorOpinion).toBe('의견');
    expect(second!.events.map((e: { kind: string }) => e.kind)).toEqual(['CREATED', 'NOTE']);
    // 같은 판으로 늦게 온 갱신은 실패한다
    expect(await store.updateCase({ ...next, version: 3 }, 1, [])).toBe(false);
    // 사건 기록을 고치거나 지우는 것은 트리거가 막는다
    await expect(raw.query("UPDATE fraud_case_event SET kind = 'CLEARED' WHERE case_id = $1 AND seq = 1", [CASE])).rejects.toThrow();
    await expect(raw.query('DELETE FROM fraud_case_event WHERE case_id = $1 AND seq = 1', [CASE])).rejects.toThrow();
  });

  test('FX-T12 ㉔ 같은 묶음에 사건은 하나이고 후보 계산 시도는 (회차, 판, 시도)로 남는다', async () => {
    for (const attempt of [1, 2, 3, 4]) await store.putRun(run({ attempt, status: 'FAILED', failureReason: 'TIMEOUT' }));
    const runs = await store.listRuns(EVENT);
    expect(runs.map((r: { attempt: number }) => r.attempt)).toEqual([1, 2, 3, 4]);
    await expect(store.putRun(run({ attempt: 1 }))).rejects.toThrow();
    // 같은 묶음에 사건을 하나 더 만들 수 없다
    await expect(store.putCase(caseRecord({ caseId: randomUUID() }))).rejects.toThrow();
  });

  test('FX-T12 ㉕ 후보 결과와 기록 고정 판을 저장하면 머리·목록·상세에 보인다', async () => {
    await store.putSnapshot(snapshot());
    expect(await store.latestSnapshot(EVENT)).toMatchObject({ version: 1, invHash: hex('b'), verifyStatus: null });
    await store.putClusters(EVENT, 1, [
      cluster(CLUSTER, [ACC(1), ACC(2)], { purchaseCount: 18 }),
      cluster(CLUSTER2, [ACC(3)], { scoreBand: 'LOW', purchaseCount: 1 }),
    ]);
    const list = await store.listClusters({ eventId: EVENT, generation: 1, sort: 'SCORE_DESC', limit: 10 });
    expect(list.items.map((c: { clusterId: string }) => c.clusterId)).toEqual([CLUSTER, CLUSTER2]);
    const detail = await store.getCluster(CLUSTER);
    expect(detail!.members.map((m: { accountId: string }) => m.accountId)).toEqual([ACC(1), ACC(2)]);
    expect(detail!.purchaseCount).toBe(18);
    expect(await store.findCaseByCluster(CLUSTER)).toMatchObject({ caseId: CASE });
    const counts = await store.countCases(EVENT);
    expect(counts.total).toBe(1);
    expect(counts.byStatus.INVESTIGATING).toBe(1);
  });

  test('FX-T12 ㉖ 하루 검증 상태와 내보내기 차단 칸이 저장된다', async () => {
    expect(await store.isSnapshotExportBlocked(EVENT, 1)).toBe(false);
    await store.verifySnapshot(EVENT, 1, 'MISMATCH', NOW);
    expect((await store.latestSnapshot(EVENT))!.verifyStatus).toBe('MISMATCH');
    expect((await store.latestSnapshot(EVENT))!.verifiedAtMs).toBe(NOW);
    expect(await store.isSnapshotExportBlocked(EVENT, 1)).toBe(true);
    await store.verifySnapshot(EVENT, 1, 'OK', NOW + DAY);
    expect(await store.isSnapshotExportBlocked(EVENT, 1)).toBe(false);
  });
});
