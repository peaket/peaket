// FX-T11·FX-T14 실제 ClickHouse 시험. F-04-10 inv 표에 F-04-9 생성기 시드를 넣고 해시 사슬·후보를 본다.
// Docker 엔진이 없으면 건너뛰지 않고 실패한다(기존 통합 시험과 같다).
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { buildInvSeed, writeInvSeed } from '../../../apps/forensics/scripts/seed-inv.mjs';
import { migrateInv } from '../../inv-ingest/src/migrate.js';
import { ClickHouseReader, loadClusterInput, loadSnapshotTables } from '../src/clickhouse.js';
import { computeClusters } from '../src/cluster.js';
import { buildSnapshot, verifySnapshot } from '../src/snapshot.js';
import { CH_PASSWORD, CH_USER, startClickHouse, type ClickHouseContainer } from './clickhouse.js';

const EVENT_ID = '11111111-1111-7111-8111-111111111111';
const SALE_START = Date.parse('2026-11-28T09:00:00.000Z');
const SEED_INGESTED = Date.parse('2026-12-01T09:00:00.000Z');
const FROZEN1 = Date.parse('2026-12-01T10:00:00.000Z');
const V2_INGESTED = Date.parse('2026-12-01T10:30:00.000Z');
const FROZEN2 = Date.parse('2026-12-01T11:00:00.000Z');
const TAMPER_INGESTED = Date.parse('2026-12-01T08:59:00.000Z');
const MAX_U64 = 18_446_744_073_709_551_615n;
const rank = (ms: number) => String(MAX_U64 - BigInt(ms));

let ch: ClickHouseContainer;
let reader: ClickHouseReader;
let seed: ReturnType<typeof buildInvSeed>;
let originalV1: ReturnType<typeof buildSnapshot> | null = null;

const insertStep = async (row: Record<string, unknown>) => {
  await ch.query(
    `INSERT INTO inv.inv_step SETTINGS date_time_input_format = 'best_effort' FORMAT JSONEachRow\n` +
      `${JSON.stringify(row)}\n`,
  );
};

beforeAll(async () => {
  ch = await startClickHouse();
  await migrateInv((sql) => ch.query(sql), fileURLToPath(new URL('../../../data/clickhouse/inv', import.meta.url)), 'single');
  seed = buildInvSeed({ eventId: EVENT_ID, performanceDate: '2026-12-01' });
  await writeInvSeed(seed, { url: ch.url, user: CH_USER, password: CH_PASSWORD });
  reader = new ClickHouseReader({ baseUrl: ch.url, user: CH_USER, password: CH_PASSWORD });
}, 300_000);

afterAll(() => {
  ch?.stop();
});

test('FX-T14 ⑦ 실제 ClickHouse 시드 행으로 판 해시를 만들고 다시 계산해도 같다', async () => {
  const tables = await loadSnapshotTables(reader, { eventId: EVENT_ID, from: null, to: FROZEN1 });
  expect(tables.inv_step).toHaveLength(seed.steps.length);
  // 시드는 세션이 시간 순으로 엇갈려 같은 request_id를 여러 번 만들 수 있다. 표는 정렬 키로 중복을 지운다
  const distinctRequests = new Set(seed.requests.map((r: Record<string, unknown>) => r.request_id)).size;
  expect(tables.inv_request).toHaveLength(distinctRequests);
  expect(tables.inv_link.length).toBeGreaterThan(0);
  const v1 = buildSnapshot({ eventId: EVENT_ID, version: 1, frozenAt: FROZEN1, prevHash: null, rangeFrom: null, late: false, tables });
  originalV1 = v1;
  expect(v1.rowCounts.inv_step).toBe(seed.steps.length);
  expect(v1.invHash).toMatch(/^[0-9a-f]{64}$/);
  const again = await loadSnapshotTables(reader, { eventId: EVENT_ID, from: null, to: FROZEN1 });
  const v1b = buildSnapshot({ eventId: EVENT_ID, version: 1, frozenAt: FROZEN1, prevHash: null, rangeFrom: null, late: false, tables: again });
  expect(v1b.invHash).toBe(v1.invHash);
  expect(verifySnapshot(v1, again)).toMatchObject({ ok: true, mismatched: [], severity: null });
  // 해시 계산은 적재 시각(ingested_at)을 칸으로 넣고, 저장 전용 ingest_rank는 넣지 않는다
  expect(SEED_INGESTED).toBeLessThan(FROZEN1);
});

test('FX-T14 ⑨ 실제 ClickHouse에서 판 2의 범위·직전 해시가 판 1을 잇는다', async () => {
  const template = seed.steps.find((s: Record<string, unknown>) => s.step === 'ADMIT') as Record<string, unknown>;
  await insertStep({
    ...template,
    source_key: 'v2-new-step',
    ts: new Date(V2_INGESTED).toISOString(),
    ingested_at: new Date(V2_INGESTED).toISOString(),
    ingest_rank: rank(V2_INGESTED),
    step: 'HOLD_TRY',
    account_id: 'v2-account',
    held_at: new Date(V2_INGESTED).toISOString(),
    seat_ids: [],
  });

  const t1 = await loadSnapshotTables(reader, { eventId: EVENT_ID, from: null, to: FROZEN1 });
  const v1 = buildSnapshot({ eventId: EVENT_ID, version: 1, frozenAt: FROZEN1, prevHash: null, rangeFrom: null, late: false, tables: t1 });
  const t2 = await loadSnapshotTables(reader, { eventId: EVENT_ID, from: FROZEN1, to: FROZEN2 });
  expect(t2.inv_step.map((r) => r.source_key)).toEqual(['v2-new-step']);
  const v2 = buildSnapshot({ eventId: EVENT_ID, version: 2, frozenAt: FROZEN2, prevHash: v1.invHash, rangeFrom: FROZEN1, late: false, tables: t2 });
  expect(v2.prevHash).toBe(v1.invHash);
  expect(v2.rangeFrom).toBe(new Date(FROZEN1).toISOString());
  expect(v2.rowCounts.inv_step).toBe(1);
  expect(v2.rowCounts.inv_request).toBe(0);
  expect(v2.invHash).not.toBe(v1.invHash);
  expect(verifySnapshot(v2, t2)).toMatchObject({ ok: true, severity: null });
  // 판 1은 늦게 들어온 판 2 행에 흔들리지 않는다
  const v1Again = buildSnapshot({ eventId: EVENT_ID, version: 1, frozenAt: FROZEN1, prevHash: null, rangeFrom: null, late: false, tables: t1 });
  expect(v1Again.invHash).toBe(v1.invHash);
});

test('FX-T14 ⑧ 실제 ClickHouse 행 하나를 바꾸면 검증이 불일치를 낸다', async () => {
  const template = seed.steps.find((s: Record<string, unknown>) => s.step !== 'SALE' && s.account_id) as Record<string, unknown>;
  await insertStep({
    ...template,
    result: 'TAMPERED',
    ingested_at: new Date(TAMPER_INGESTED).toISOString(),
    ingest_rank: rank(TAMPER_INGESTED),
  });
  const tables = await loadSnapshotTables(reader, { eventId: EVENT_ID, from: null, to: FROZEN1 });
  const v1 = buildSnapshot({ eventId: EVENT_ID, version: 1, frozenAt: FROZEN1, prevHash: null, rangeFrom: null, late: false, tables });
  // 고정해 둔 판 1과 같은 범위를 다시 계산하면 변조된 행 하나 때문에 값이 달라진다
  expect(v1.invHash).not.toBe(originalV1!.invHash);
  const check = verifySnapshot(originalV1!, tables);
  expect(check.ok).toBe(false);
  expect(check.mismatched).toEqual(['inv_step']);
  expect(check.severity).toBe('SEV2');
});

test('FX-T11 ⑧ 실제 ClickHouse 시드에서 9계정 묶음과 대기열 우회 후보가 나온다', async () => {
  // 가족 2계정이 4장을 산 모양을 더한다(§5.5 ③). CONTACT 강한 연결은 있지만 한도 이내라 후보가 아니다
  const template = seed.steps.find((s: Record<string, unknown>) => s.step === 'SALE') as Record<string, unknown>;
  for (const [i, account] of ['plant-acct-family0', 'plant-acct-family1'].entries()) {
    for (let k = 0; k < 2; k += 1) {
      await insertStep({
        ...template,
        source_key: `family-sale-${i}-${k}`,
        ts: new Date(Date.parse('2026-11-28T09:02:00.000Z') + i * 1_000 + k).toISOString(),
        ingested_at: new Date(FROZEN2).toISOString(),
        ingest_rank: rank(FROZEN2),
        account_id: account,
        seat_ids: [`family-seat-${i}-${k}`],
      });
    }
  }

  const input = await loadClusterInput(reader, {
    eventId: EVENT_ID,
    saleStartMs: SALE_START,
    limitPerPerson: 4,
    snapshotVersion: 1,
    posts: [],
  });
  const out = computeClusters(input);
  const nine = out.clusters.find((c) => c.accounts.includes('plant-acct-pay0'));
  expect(nine).toBeDefined();
  expect(nine!.accounts).toHaveLength(9);
  expect(nine!.purchaseCount).toBe(27);
  expect(nine!.limitPerPerson).toBe(4);
  expect(nine!.sharedAttributes).toContain('PAYMENT_METHOD');
  expect(nine!.scoreBand).toBe('HIGH');
  expect(nine!.candidate).toBe(true);

  const bypass = out.clusters.find((c) => c.accounts.includes('plant-acct-bypass'));
  expect(bypass).toBeDefined();
  expect(bypass!.accounts).toEqual(['plant-acct-bypass']);
  expect(bypass!.signals).toContain('BYPASS_TRACE');
  expect(bypass!.candidate).toBe(true);

  const family = out.clusters.find((c) => c.accounts.includes('plant-acct-family0'));
  expect(family).toBeDefined();
  expect(family!.accounts).toEqual(['plant-acct-family0', 'plant-acct-family1']);
  expect(family!.purchaseCount).toBe(4);
  expect(family!.candidate).toBe(false);

  expect(out.clusters.some((c) => c.accounts.some((a) => a.startsWith('plant-acct-mobile')))).toBe(false);
  expect(out.clusters.some((c) => c.accounts.some((a) => a.startsWith('plant-acct-beh')))).toBe(false);
  expect(out.clusters.some((c) => c.accounts.includes('plant-acct-weak0') && c.accounts.includes('plant-acct-weak1'))).toBe(false);

  const again = computeClusters(input);
  expect(again.resultFingerprint).toBe(out.resultFingerprint);
});
