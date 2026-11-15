// A2-19 회귀: 다운로드 접속기록을 별도 표(2년 보존)에 남기고, core_partner에는 추가·조회만 준다.
import { fakeClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { AttendeeExports } from '../src/modules/export/application/attendee-exports.js';
import { DrizzleAttendeeExportStore } from '../src/modules/export/adapters/db/drizzle-export-store.js';
import { MemoryActorNames, MemoryPartnerEventLookup } from '../src/modules/export/index.js';
import type { AttendeeExportRecord } from '../src/modules/export/domain/export.js';
import type { AttendeeExportStore, AttendeeSource, BookersReauth } from '../src/modules/export/domain/ports.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const TENANT = randomUUID();
const EVENT = randomUUID();
const ACCOUNT = randomUUID();
const createdAt = new Date('2026-11-15T00:00:00Z');
const clock = fakeClock({ now: createdAt.getTime() });
const reauth: BookersReauth = { verify: async () => ({ accountId: ACCOUNT, factors: ['passkey'] }) };
const attendees: AttendeeSource = {
  list: async () => [
    { orderId: randomUUID(), eventId: EVENT, buyerName: '김민수', buyerPhone: '010-1234-5678', seatLabel: 'A-1', quantity: 1 },
    { orderId: randomUUID(), eventId: EVENT, buyerName: '이서', buyerPhone: '010-9876-5432', seatLabel: 'B-2', quantity: 2 },
  ],
  count: async () => ({ bookings: 2, tickets: 3 }),
};

class RecordingStore implements AttendeeExportStore {
  readonly calls: string[] = [];
  inserted?: AttendeeExportRecord;
  audited?: AttendeeExportRecord;

  async insert(record: AttendeeExportRecord): Promise<void> {
    this.calls.push('insert');
    this.inserted = record;
  }
  async audit(record: AttendeeExportRecord): Promise<void> {
    this.calls.push('audit');
    this.audited = record;
  }
  async list(): Promise<AttendeeExportRecord[]> {
    return [];
  }
}

const record = (): AttendeeExportRecord => ({
  exportId: randomUUID(),
  promoterId: TENANT,
  eventId: EVENT,
  actorAccountId: ACCOUNT,
  actorDisplayName: '스텔라 관리자',
  actorRole: 'partner_admin',
  reason: '현장 명단 대조',
  format: 'CSV',
  count: 2,
  result: 'COMPLETED',
  createdAt,
  expiresAt: new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000),
});

describe('A2-19 다운로드 접속기록', () => {
  test('내려받기는 이력 저장 뒤 접속기록을 행위자·사유·건수·형식과 함께 남긴다', async () => {
    const store = new RecordingStore();
    const events = new MemoryPartnerEventLookup();
    events.add(TENANT, EVENT, 'LUMEN', new Date('2026-12-01T00:00:00Z'));
    const app = new AttendeeExports({ store, attendees, events, reauth, actors: new MemoryActorNames(), clock });

    const out = await app.create(TENANT, EVENT, { accountId: ACCOUNT, sessionId: 's-1', role: 'partner_admin' }, 'token', { reason: '현장 명단 대조', format: 'CSV' });
    expect(store.calls).toEqual(['insert', 'audit']);
    expect(store.audited).toMatchObject({
      exportId: out.record.exportId,
      promoterId: TENANT,
      eventId: EVENT,
      actorAccountId: ACCOUNT,
      actorDisplayName: '파트너 관리자',
      actorRole: 'partner_admin',
      reason: '현장 명단 대조',
      format: 'CSV',
      count: 2,
      createdAt,
    });
  });

  test('Drizzle 접속기록은 retain_until을 만든 시각 + 2년으로 쓴다', async () => {
    const values: Record<string, unknown>[] = [];
    const tx = {
      insert: () => ({
        values: async (v: Record<string, unknown>) => {
          values.push(v);
        },
      }),
    };
    const db = {
      transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
    } as unknown as Database;
    const store = new DrizzleAttendeeExportStore(db);
    const r = record();
    await store.audit(r);

    expect(values).toHaveLength(1);
    const v = values[0]!;
    expect(v).toMatchObject({
      id: r.exportId,
      exportId: r.exportId,
      promoterId: TENANT,
      eventId: EVENT,
      actorAccountId: ACCOUNT,
      actorDisplayName: '스텔라 관리자',
      actorRole: 'partner_admin',
      reason: '현장 명단 대조',
      format: 'CSV',
      count: 2,
      createdAt,
    });
    expect((v.retainUntil as Date).getTime() - createdAt.getTime()).toBe(2 * 365 * 24 * 60 * 60 * 1000);
  });

  test('0019는 접속기록 표를 만들고 core_partner에 SELECT·INSERT만 준다', () => {
    const sql = read('migrations/0019_attendee_export_audit.sql');
    expect(sql).toContain('CREATE TABLE "attendee_export_audit"');
    expect(sql).toContain('"retain_until" timestamp with time zone NOT NULL');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('CREATE POLICY attendee_export_audit_partner_tenant');
    const grants = sql.match(/GRANT[^;]*attendee_export_audit[^;]*/g) ?? [];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain('SELECT, INSERT');
    expect(grants[0]).not.toMatch(/UPDATE|DELETE/);
    const journal = JSON.parse(read('migrations/meta/_journal.json')) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((e) => e.idx === 19)?.tag).toBe('0019_attendee_export_audit');
  });
});
