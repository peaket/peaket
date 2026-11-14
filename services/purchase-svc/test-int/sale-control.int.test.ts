// BAT-465 R-584 판매 정지 원본(sale_control)의 실제 PostgreSQL 18 통합 시험.
// 판 번호 조건부 upsert(같은 명령 재시도는 그대로, 더 큰 판만 적용)와 좌석 Redis 사본 쓰기를 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { DrizzleSaleControlStore, MemorySaleControlCopies, SetSaleSuspension } from '../src/modules/sale-control/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-15T03:00:00.000Z');
let container: PostgresContainer | undefined;
let db: Database;
let store: DrizzleSaleControlStore;

beforeAll(async () => {
  container = await startPostgres();
  await migratePurchase(container.url);
  db = createDatabase({ url: container.url, applicationName: 'purchase-svc-sale-control-it' });
  store = new DrizzleSaleControlStore(db);
});

afterAll(async () => {
  await db?.close().catch(() => undefined);
  container?.stop();
});

const fixture = () => {
  const copies = new MemorySaleControlCopies();
  return { copies, service: new SetSaleSuspension(store, copies) };
};

describe('BAT-465 sale_control 실제 DB', () => {
  test('R584_중지와_재개가_행과_사본을_쓴다', async () => {
    const eventId = randomUUID();
    const f = fixture();
    const stopId = randomUUID();
    const stop = await f.service.run({ eventId, action: 'SUSPEND', commandId: stopId, reason: '판매자 신원 확인', suspensionRef: 'AP-1', nowMs: NOW });
    expect(stop).toEqual({ eventId, suspended: true, revision: 1, changed: true });
    expect(await store.find(eventId)).toMatchObject({ eventId, suspended: true, paused: false, revision: 1, commandId: stopId, suspensionRef: 'AP-1' });
    expect(f.copies.written.get(eventId)).toMatchObject({ suspended: '1', rev: '1', cmd: stopId, suspRef: 'AP-1' });

    const resumeId = randomUUID();
    const resume = await f.service.run({ eventId, action: 'RESUME', commandId: resumeId, reason: '확인 끝', nowMs: NOW + 1000 });
    expect(resume).toMatchObject({ suspended: false, revision: 2, changed: true });
    expect(await store.find(eventId)).toMatchObject({ suspended: false, revision: 2, commandId: resumeId });
  });

  test('R584_같은_명령의_재시도는_판_번호를_올리지_않는다', async () => {
    const eventId = randomUUID();
    const f = fixture();
    const commandId = randomUUID();
    expect((await f.service.run({ eventId, action: 'SUSPEND', commandId, reason: '사기 의심', nowMs: NOW })).revision).toBe(1);
    const again = await f.service.run({ eventId, action: 'SUSPEND', commandId, reason: '사기 의심', nowMs: NOW + 5000 });
    expect(again).toMatchObject({ suspended: true, revision: 1, changed: false });
    expect((await store.find(eventId))?.revision).toBe(1);
  });

  test('R584_제어_gRPC_판_번호는_더_클_때만_쓰고_작으면_그대로_둔다', async () => {
    const eventId = randomUUID();
    const f = fixture();
    const stopId = randomUUID();
    expect((await f.service.run({ eventId, action: 'SUSPEND', commandId: stopId, reason: '법적 요청', nowMs: NOW, version: 10 })).revision).toBe(10);
    const stale = await f.service.run({ eventId, action: 'RESUME', commandId: randomUUID(), reason: '늦은 재개', nowMs: NOW + 1, version: 9 });
    expect(stale).toMatchObject({ suspended: true, revision: 10, changed: false });
    const newer = await f.service.run({ eventId, action: 'RESUME', commandId: randomUUID(), reason: '재개', nowMs: NOW + 2, version: 20 });
    expect(newer).toMatchObject({ suspended: false, revision: 20, changed: true });
    expect(await store.find(eventId)).toMatchObject({ suspended: false, revision: 20 });
  });
});
