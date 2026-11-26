// F-04-14 PostgreSQL 통합 시험(동결 로컬, LCH-290·LCH-300, FX-T13·FX-T20).
// 실제 PostgreSQL 18에서 증거 묶음·관리 연속성 사슬·덧붙이기 트리거·내보내기·외부 게시물을 본다.
// Docker가 없으면 건너뛰지 않고 실패한다(계획 §7.5).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import * as inv from '../src/modules/investigations/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-26T00:00:00.000Z');
const id = (n: number) => `0194b241-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const EVENT = id(0x200);
const CASE = id(0x400);

const product = inv as unknown as Record<string, any>;
const sha = (c: string) => c.repeat(64);

let container: PostgresContainer;
let admin: pg.Client;
let db: ReturnType<typeof createDatabase>;
let store: any;

const seedCase = async () => {
  await admin.query(
    `insert into fraud_case (id, event_id, cluster_id, status, reason_category, assignee_id, cancel_deadline_at, version, created_at)
     values ($1, $2, $3, 'ACTIONED', 'MACRO_BOT', $4, $5, 2, $6)
     on conflict (id) do nothing`,
    [CASE, EVENT, id(0x300), id(0x900), new Date(NOW + 7 * DAY), new Date(NOW - DAY)],
  );
};

const bundleOf = (o: Record<string, any> = {}) => ({
  bundleId: id(0x500),
  caseId: CASE,
  eventId: EVENT,
  status: 'BUILDING',
  snapshotHash: sha('a'),
  manifestSha256: null,
  queries: { ruleVersion: 'v1' },
  s3Prefix: `evidence/${CASE}/${id(0x500)}/`,
  holdReason: 'OBJECTION',
  holdEndRequestedBy: null,
  holdEndRequestedAtMs: null,
  holdEndBasis: null,
  holdEndConfirmedBy: null,
  holdEndedAtMs: null,
  createdBy: id(0x900),
  createdAtMs: NOW,
  files: [],
  ...o,
});

const custodyOf = (o: Record<string, any> = {}) => ({
  action: 'CREATED',
  actorId: id(0x900),
  reason: '사건 조치',
  exportKind: null,
  dataRequestId: null,
  occurredAtMs: NOW,
  ...o,
});

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-fraud-evidence-it' });
  const Store = product.DrizzleFraudEvidenceStore;
  if (typeof Store !== 'function') throw new Error('DrizzleFraudEvidenceStore가 없다');
  store = new Store(db);
  await seedCase();
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await db?.close();
  await container?.stop();
});

beforeEach(async () => {
  await admin.query('delete from evidence_custody_log');
  await admin.query('delete from evidence_export');
  await admin.query('delete from evidence_bundle');
  await admin.query('delete from external_post');
});

describe('F-04-14 PostgreSQL', () => {
  test('FX-T13 ⑩ [ASVS v5.0.0-16.4.2] PostgreSQL은 증거 묶음과 관리 연속성 첫 행을 한 트랜잭션에 쓰고 행 해시를 잇는다', async () => {
    const b = bundleOf();
    const created = await store.putBundle(b, custodyOf());
    expect(created.replayed).toBe(false);
    const got = await store.getBundle(b.bundleId);
    expect(got).toMatchObject({ bundleId: b.bundleId, caseId: CASE, status: 'BUILDING', holdReason: 'OBJECTION' });
    let rows = await store.listCustody(b.bundleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 1, action: 'CREATED', prevHash: null });
    const sealed = await store.appendCustody(b.bundleId, custodyOf({ action: 'SEALED', reason: '봉인' }));
    expect(sealed.seq).toBe(2);
    expect(Buffer.from(sealed.prevHash).toString('hex')).toBe(Buffer.from(rows[0].rowHash).toString('hex'));
    expect(Buffer.from(sealed.rowHash).toString('hex')).toMatch(/^[0-9a-f]{64}$/);
    rows = await store.listCustody(b.bundleId);
    expect(rows.map((r: any) => r.action)).toEqual(['CREATED', 'SEALED']);
  });

  test('FX-T13 ⑪ [ASVS v5.0.0-16.4.2] PostgreSQL은 관리 연속성 행의 고치기·지우기를 트리거로 막는다', async () => {
    const b = bundleOf({ bundleId: id(0x501) });
    await store.putBundle(b, custodyOf());
    await expect(admin.query("update evidence_custody_log set reason = '고침' where bundle_id = $1 and seq = 1", [b.bundleId])).rejects.toThrow();
    await expect(admin.query('delete from evidence_custody_log where bundle_id = $1 and seq = 1', [b.bundleId])).rejects.toThrow();
  });

  test('FX-T13 ⑫ PostgreSQL은 파기 상태·보존 이유·확인자 검사를 지키고 내보내기 행을 남긴다', async () => {
    const b = bundleOf({ bundleId: id(0x502), status: 'SEALED', manifestSha256: sha('b') });
    await store.putBundle(b, custodyOf({ action: 'SEALED' }));
    const updated = await store.updateBundle({ ...b, status: 'SEALED', holdReason: 'DISPUTE', holdEndedAtMs: NOW + DAY, holdEndConfirmedBy: id(0x901) }, ['SEALED']);
    expect(updated).toBe(true);
    const got = await store.getBundle(b.bundleId);
    expect(got).toMatchObject({ status: 'SEALED', holdReason: 'DISPUTE' });
    await expect(store.updateBundle({ ...got, holdReason: 'OBJECTION' }, ['SEALED'])).rejects.toThrow();
    await store.putExport(
      { exportId: id(0x600), bundleId: b.bundleId, kind: 'COMPLAINT', dataRequestId: null, documentId: null, sha256: sha('c'), rows: 3, reason: '고소', actorId: id(0x900), createdAtMs: NOW },
      custodyOf({ action: 'EXPORTED', exportKind: 'COMPLAINT', reason: '고소' }),
    );
    const exports = await admin.query('select kind, rows, reason from evidence_export where bundle_id = $1', [b.bundleId]);
    expect(exports.rows).toEqual([{ kind: 'COMPLAINT', rows: 3, reason: '고소' }]);
    const custody = await store.listCustody(b.bundleId);
    expect(custody.map((r: any) => r.action)).toEqual(['SEALED', 'EXPORTED']);
  });

  test('FX-T20 ⑪ PostgreSQL은 외부 게시물의 matched_ticket_ids·scan_status·capture_sha256을 왕복한다', async () => {
    const post = {
      postId: id(0x700),
      eventId: EVENT,
      url: 'https://example.com/post/1',
      site: 'example.com',
      capturedAtMs: NOW,
      postedAtMs: NOW - DAY,
      source: 'REPORT',
      reportCaseId: id(0x910),
      claimedSeats: 'A구역 1열 1번',
      maskRegions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
      captureKey: 'captures/seed/original.png',
      captureSha256: sha('d'),
      scanStatus: 'CLEAN',
      matchedTicketIds: [id(0x2001)],
      registeredBy: id(0x900),
      createdAtMs: NOW,
    };
    const created = await store.putPost(post);
    expect(created.replayed).toBe(false);
    const got = await store.getPost(post.postId);
    expect(got).toMatchObject({ postId: post.postId, source: 'REPORT', scanStatus: 'CLEAN', captureSha256: sha('d') });
    expect(got.matchedTicketIds).toEqual([id(0x2001)]);
    expect(got.maskRegions).toEqual([{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }]);
    const listed = await store.listPosts({ eventId: EVENT, limit: 10 });
    expect(listed.items).toHaveLength(1);
    const pending = await store.listPendingScans(10);
    expect(pending).toHaveLength(0);
    await store.updatePost({ ...got, scanStatus: 'PENDING' });
    expect(await store.listPendingScans(10)).toHaveLength(1);
  });
});
