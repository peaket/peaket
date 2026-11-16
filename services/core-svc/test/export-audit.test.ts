// A2-19 회귀: 다운로드 접속기록을 별도 표(2년 보존)에 남기고, core_partner에는 추가·조회만 준다.
// W7-audit A2-19: 명단 보기도 한 페이지마다 LIST 접속기록을 남기고(남기지 못하면 명단을 주지 않는다), 내려받기 이력과 DOWNLOAD 접속기록은
// recordExport 한 번(한 트랜잭션)으로 쓰며, 보존 끝은 만든 때 + 2년(UTC 달력)이다(docs/features/settlement.md §9, docs/data.md §2, J-T26 ⑤⑥).
import { fakeClock, ProblemError, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { AttendeeExports, type ExportActor } from '../src/modules/export/application/attendee-exports.js';
import { DrizzleAttendeeExportStore } from '../src/modules/export/adapters/db/drizzle-export-store.js';
import { attendeeExport, attendeeExportAudit } from '../src/modules/export/adapters/db/schema.js';
import { MemoryActorNames, MemoryAttendeeExportStore, MemoryPartnerEventLookup } from '../src/modules/export/index.js';
import { accessLogRetainUntil, type AttendeeExportRecord } from '../src/modules/export/domain/export.js';
import type { AttendeeExportStore, AttendeeSource, AttendeeViewRecord, BookersReauth } from '../src/modules/export/domain/ports.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const EVENT = randomUUID();
const OLD_EVENT = randomUUID();
const ACCOUNT = randomUUID();
const createdAt = new Date('2026-11-15T00:00:00Z');
const clock = fakeClock({ now: createdAt.getTime() });
const reauth: BookersReauth = { verify: async () => ({ accountId: ACCOUNT, factors: ['passkey'] }) };
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 두 행을 주는 원천. 부른 횟수를 센다 */
function twoRows(): AttendeeSource & { listed: number } {
  const s = {
    listed: 0,
    async list() {
      s.listed += 1;
      return {
        items: [
          { orderId: randomUUID(), eventId: EVENT, buyerName: '김민수', buyerPhone: '010-1234-5678', seatLabel: 'A-1', quantity: 1 },
          { orderId: randomUUID(), eventId: EVENT, buyerName: '이서', buyerPhone: '010-9876-5432', seatLabel: 'B-2', quantity: 2 },
        ],
        nextCursor: null,
      };
    },
    async count() {
      return { bookings: 7, tickets: 9 };
    },
  };
  return s;
}

/** 부른 메서드를 차례로 남기는 저장소. failExport·failView를 켜면 그 쓰기가 던진다 */
class RecordingStore implements AttendeeExportStore {
  readonly calls: string[] = [];
  readonly exported: AttendeeExportRecord[] = [];
  /** recordExport 둘째 인자(접속지, 리뷰 R2) */
  readonly access: ({ clientIp: string } | undefined)[] = [];
  readonly viewed: AttendeeViewRecord[] = [];
  failExport = false;
  failView = false;

  // 옛 포트 메서드(W7-audit 뒤 포트에서 빠진다). 불리면 calls에 남아 'recordExport 한 번' 단언이 잡는다
  async insert(): Promise<void> {
    this.calls.push('insert');
  }
  async audit(): Promise<void> {
    this.calls.push('audit');
  }
  async recordExport(record: AttendeeExportRecord, access?: { clientIp: string }): Promise<void> {
    this.calls.push('recordExport');
    this.access.push(access);
    if (this.failExport) throw new Error('audit-down');
    this.exported.push(record);
  }
  async recordView(view: AttendeeViewRecord): Promise<void> {
    this.calls.push('recordView');
    if (this.failView) throw new Error('view-audit-down');
    this.viewed.push(view);
  }
  async list(): Promise<AttendeeExportRecord[]> {
    return [];
  }
}

const events = (): MemoryPartnerEventLookup => {
  const e = new MemoryPartnerEventLookup();
  e.add(TENANT, EVENT, 'LUMEN', new Date('2026-12-01T00:00:00Z'));
  // 끝난 지 1개월이 넘은 회차(보유 기간 끝, 410)
  e.add(TENANT, OLD_EVENT, '오래된 공연', new Date('2026-08-01T00:00:00Z'));
  return e;
};

const admin: ExportActor = { accountId: ACCOUNT, sessionId: 's-1', role: 'partner_admin', clientIp: '198.51.100.20' };

const record = (o: Partial<AttendeeExportRecord> = {}): AttendeeExportRecord => ({
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
  ...o,
});

const view = (o: Partial<AttendeeViewRecord> = {}): AttendeeViewRecord => ({
  auditId: '0190f3a1-7c2e-7a00-8000-0000000000aa',
  promoterId: TENANT,
  eventId: EVENT,
  actorAccountId: ACCOUNT,
  actorDisplayName: '파트너 관리자',
  actorRole: 'partner_admin',
  count: 2,
  filter: { limit: 50, cursor: 'c1' },
  createdAt,
  clientIp: '203.0.113.9',
  ...o,
});

/** Drizzle 가짜 db: transaction 호출과 그 안의 넣기(표·값)를 모은다. failAt번째 넣기(1부터)가 던진다 */
function fakeDb(failAt?: number) {
  const transactions: { options: unknown; txs: unknown[] }[] = [];
  const inserts: { tx: unknown; table: unknown; values: Record<string, unknown> }[] = [];
  const db = {
    transaction: async (fn: (t: unknown) => Promise<unknown>, options: unknown) => {
      const tx = {
        insert: (table: unknown) => ({
          values: async (values: Record<string, unknown>) => {
            inserts.push({ tx, table, values });
            if (failAt !== undefined && inserts.length === failAt) throw new Error('insert-down');
          },
        }),
      };
      transactions.push({ options, txs: [tx] });
      return fn(tx);
    },
  } as unknown as Database;
  return { db, transactions, inserts };
}

describe('A2-19 명단 보기 접속기록', () => {
  test('A2-19 J-T26 ⑤ 명단 보기는 행위자·보인 건수·조건을 LIST 접속기록에 남긴다', async () => {
    // 웨이브 6 독립 시험 작성자(R-625)가 쓴 재현 시험을 고쳐 씀: 형 변환과 auditList 이름 대신 recordView·넷째 인자 actor로 부른다
    const store = new MemoryAttendeeExportStore();
    const actors = new MemoryActorNames();
    const app = new AttendeeExports({ store, attendees: twoRows(), events: events(), reauth, actors, clock });

    const page = await app.listAttendees(TENANT, EVENT, { limit: 50 }, admin);
    expect(page.items).toHaveLength(2);
    expect(store.views).toHaveLength(1);
    const v = store.views[0]!;
    expect(v).toMatchObject({
      promoterId: TENANT,
      eventId: EVENT,
      actorAccountId: ACCOUNT,
      actorRole: 'partner_admin',
      actorDisplayName: '파트너 관리자',
      count: 2,
      createdAt,
      clientIp: '198.51.100.20',
    });
    // 합계(7건)가 아니라 이 페이지에 보인 행 수다. 받은 cursor가 없으면 키를 두지 않는다
    expect(v.count).not.toBe(7);
    expect(v.filter).toStrictEqual({ limit: 50 });
    expect(v.auditId).toMatch(UUID_V7);

    actors.set(ACCOUNT, '스텔라 관리자');
    await app.listAttendees(TENANT, EVENT, { limit: 50, cursor: 'c1' }, admin);
    expect(store.views).toHaveLength(2);
    expect(store.views[1]).toMatchObject({ actorDisplayName: '스텔라 관리자', count: 2 });
    expect(store.views[1]!.filter).toStrictEqual({ limit: 50, cursor: 'c1' });
    expect(store.views[1]!.auditId).toMatch(UUID_V7);
    expect(store.views[1]!.auditId).not.toBe(v.auditId);
  });

  test('A2-19 J-T26 ⑤ 접속기록을 남기지 못하면 명단을 돌려주지 않는다', async () => {
    const store = new RecordingStore();
    store.failView = true;
    const app = new AttendeeExports({ store, attendees: twoRows(), events: events(), reauth, actors: new MemoryActorNames(), clock });
    await expect(app.listAttendees(TENANT, EVENT, { limit: 50 }, admin)).rejects.toThrow('view-audit-down');
    expect(store.calls).toEqual(['recordView']);
  });

  test('A2-19 J-T26 ⑤ 행위자 없이 부르면 원천을 읽지 않고 실패한다', async () => {
    for (const actor of [undefined as unknown as ExportActor, { accountId: '', sessionId: 's-1', role: 'partner_admin', clientIp: '198.51.100.20' }]) {
      const source = twoRows();
      const store = new MemoryAttendeeExportStore();
      const app = new AttendeeExports({ store, attendees: source, events: events(), reauth, actors: new MemoryActorNames(), clock });
      await expect(app.listAttendees(TENANT, EVENT, { limit: 50 }, actor), JSON.stringify(actor ?? null)).rejects.toThrow();
      expect(source.listed).toBe(0);
      expect(store.views).toHaveLength(0);
    }
  });

  test('A2-19 J-T26 ⑤ 명단을 보이지 않은 요청은 접속기록에 남지 않는다', async () => {
    const store = new MemoryAttendeeExportStore();
    const app = new AttendeeExports({ store, attendees: twoRows(), events: events(), reauth, actors: new MemoryActorNames(), clock });
    await expect(app.listAttendees(OTHER_TENANT, EVENT, { limit: 50 }, admin)).rejects.toMatchObject({ status: 404 });
    await expect(app.listAttendees(TENANT, OLD_EVENT, { limit: 50 }, admin)).rejects.toMatchObject({ status: 410 });
    expect(store.views).toHaveLength(0);
  });

  test('A2-19 R2 J-T26 ⑤ 명단 보기 접속기록에 요청의 접속지를 남긴다', async () => {
    const store = new MemoryAttendeeExportStore();
    const app = new AttendeeExports({ store, attendees: twoRows(), events: events(), reauth, actors: new MemoryActorNames(), clock });
    await app.listAttendees(TENANT, EVENT, { limit: 50 }, { ...admin, clientIp: '203.0.113.7' });
    await app.listAttendees(TENANT, EVENT, { limit: 50 }, { ...admin, clientIp: '2001:db8::1' });
    expect(store.views.map((v) => v.clientIp)).toEqual(['203.0.113.7', '2001:db8::1']);
  });

  test('A2-19 R2 J-T26 ⑤ 접속지를 정하지 못하면 원천을 읽지 않고 실패한다', async () => {
    for (const clientIp of ['', 'abc', '300.1.1.1']) {
      const actor: ExportActor = { ...admin, clientIp };
      const source = twoRows();
      const store = new RecordingStore();
      const app = new AttendeeExports({ store, attendees: source, events: events(), reauth, actors: new MemoryActorNames(), clock });
      await expect(app.listAttendees(TENANT, EVENT, { limit: 50 }, actor), `보기 ${JSON.stringify(clientIp)}`).rejects.toThrow();
      await expect(app.create(TENANT, EVENT, actor, 'token', { reason: '접속지 없음', format: 'CSV' }), `내려받기 ${JSON.stringify(clientIp)}`).rejects.toThrow();
      expect(source.listed, clientIp).toBe(0);
      expect(store.calls, clientIp).toEqual([]);
    }
    // 접속지 칸이 아예 없는 행위자도 같다
    const { clientIp: _drop, ...noIp } = admin;
    const source = twoRows();
    const store = new RecordingStore();
    const app = new AttendeeExports({ store, attendees: source, events: events(), reauth, actors: new MemoryActorNames(), clock });
    await expect(app.listAttendees(TENANT, EVENT, { limit: 50 }, noIp as ExportActor)).rejects.toThrow();
    expect(source.listed).toBe(0);
    expect(store.calls).toEqual([]);
  });
});

describe('A2-19 내려받기 접속기록', () => {
  test('A2-19 J-T26 ⑥ 내려받기는 이력과 DOWNLOAD 접속기록을 recordExport 한 번으로 쓴다', async () => {
    const store = new RecordingStore();
    const app = new AttendeeExports({ store, attendees: twoRows(), events: events(), reauth, actors: new MemoryActorNames(), clock });

    const out = await app.create(TENANT, EVENT, admin, 'token', { reason: '현장 명단 대조', format: 'CSV' });
    expect(store.calls).toEqual(['recordExport']);
    expect(store.exported).toHaveLength(1);
    expect(store.exported[0]).toMatchObject({
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
    expect(out.record).toMatchObject({ reason: '현장 명단 대조', format: 'CSV', count: 2, actorDisplayName: '파트너 관리자', actorRole: 'partner_admin' });
    expect(store.access).toEqual([{ clientIp: '198.51.100.20' }]);
  });

  test('A2-19 R2 J-T26 ⑥ 내려받기 접속기록에도 접속지를 남기고 이력 응답에는 싣지 않는다', async () => {
    const recording = new RecordingStore();
    const viaRecording = new AttendeeExports({ store: recording, attendees: twoRows(), events: events(), reauth, actors: new MemoryActorNames(), clock });
    const out = await viaRecording.create(TENANT, EVENT, { ...admin, clientIp: '203.0.113.7' }, 'token', { reason: '현장 명단 대조', format: 'CSV' });
    expect(recording.access).toEqual([{ clientIp: '203.0.113.7' }]);
    // 이력 기록(attendee_export)과 응답에는 접속지가 없다
    expect(Object.keys(recording.exported[0]!)).not.toContain('clientIp');
    expect(JSON.stringify(out.record)).not.toContain('203.0.113.7');

    const memory = new MemoryAttendeeExportStore();
    const viaMemory = new AttendeeExports({ store: memory, attendees: twoRows(), events: events(), reauth, actors: new MemoryActorNames(), clock });
    await viaMemory.create(TENANT, EVENT, { ...admin, clientIp: '203.0.113.7' }, 'token', { reason: '현장 명단 대조', format: 'CSV' });
    expect(memory.audits.at(-1)?.clientIp).toBe('203.0.113.7');
    expect(Object.keys(memory.rows.at(-1)!)).not.toContain('clientIp');
    expect(JSON.stringify(await viaMemory.history(TENANT, EVENT, 50))).not.toContain('203.0.113.7');
  });

  test('A2-19 J-T26 ⑥ 접속기록 저장이 실패하면 내려받기 성공으로 답하지 않는다', async () => {
    // 웨이브 6 독립 시험 작성자(R-625)가 쓴 재현 시험을 고쳐 씀: 비원자 동작을 굳히던 'inserted가 남는다' 단언을 지웠다
    const store = new RecordingStore();
    store.failExport = true;
    const app = new AttendeeExports({ store, attendees: twoRows(), events: events(), reauth, actors: new MemoryActorNames(), clock });
    const err = await app.create(TENANT, EVENT, admin, 'token', { reason: '감사 실패', format: 'CSV' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ProblemError);
    expect((err as Error).message).toBe('audit-down');
    expect(store.calls).toEqual(['recordExport']);
  });
});

describe('A2-19 Drizzle 접속기록 저장', () => {
  test('A2-19 J-T26 ⑥ Drizzle recordExport는 두 행을 한 트랜잭션에 넣는다', async () => {
    const { db, transactions, inserts } = fakeDb();
    const r = record();
    await new DrizzleAttendeeExportStore(db).recordExport(r, { clientIp: '203.0.113.9' });

    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.options).toEqual({ tenantId: TENANT, accessMode: 'read write' });
    expect(inserts.map((i) => i.table)).toEqual([attendeeExport, attendeeExportAudit]);
    expect(inserts.every((i) => i.tx === transactions[0]!.txs[0])).toBe(true);
    expect(inserts[0]!.values).toMatchObject({
      id: r.exportId,
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
      expiresAt: r.expiresAt,
    });
    expect(inserts[1]!.values).toMatchObject({
      id: r.exportId,
      exportId: r.exportId,
      action: 'DOWNLOAD',
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
    expect(inserts[1]!.values.filter).toStrictEqual({});

    // 둘째 넣기(접속기록)가 던지면 recordExport가 거절된다(트랜잭션이 함께 되돌린다)
    const failing = fakeDb(2);
    await expect(new DrizzleAttendeeExportStore(failing.db).recordExport(record(), { clientIp: '203.0.113.9' })).rejects.toThrow('insert-down');
    expect(failing.transactions).toHaveLength(1);
  });

  test('A2-19 J-T26 ⑤ Drizzle recordView는 LIST 행을 export_id·reason·format 없이 넣는다', async () => {
    const { db, transactions, inserts } = fakeDb();
    const v = view();
    await new DrizzleAttendeeExportStore(db).recordView(v);

    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.options).toEqual({ tenantId: TENANT, accessMode: 'read write' });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe(attendeeExportAudit);
    expect(inserts[0]!.values).toMatchObject({
      id: v.auditId,
      action: 'LIST',
      exportId: null,
      reason: null,
      format: null,
      promoterId: TENANT,
      eventId: EVENT,
      actorAccountId: ACCOUNT,
      actorDisplayName: '파트너 관리자',
      actorRole: 'partner_admin',
      count: 2,
      createdAt,
    });
    expect(inserts[0]!.values.filter).toStrictEqual({ limit: 50, cursor: 'c1' });
  });

  test('A2-19 J-T26 ⑤ 접속기록 보존 끝은 만든 때 + 2년(달력)이다', async () => {
    // 730일로 세면 2028-11-14가 된다(2028-02-29가 끼어 있다)
    expect(accessLogRetainUntil(new Date('2026-11-15T00:00:00Z')).toISOString()).toBe('2028-11-15T00:00:00.000Z');
    expect(accessLogRetainUntil(new Date('2027-03-01T00:00:00Z')).toISOString()).toBe('2029-03-01T00:00:00.000Z');
    expect(accessLogRetainUntil(new Date('2028-02-29T12:00:00Z')).toISOString()).toBe('2030-03-01T12:00:00.000Z');

    // Drizzle 넣기 값의 retain_until도 같은 규칙이다(내려받기·보기 모두)
    const leap = new Date('2028-02-29T12:00:00Z');
    const a = fakeDb();
    await new DrizzleAttendeeExportStore(a.db).recordExport(record({ createdAt: leap }), { clientIp: '203.0.113.9' });
    expect((a.inserts[1]!.values.retainUntil as Date).toISOString()).toBe('2030-03-01T12:00:00.000Z');
    const b = fakeDb();
    await new DrizzleAttendeeExportStore(b.db).recordView(view({ createdAt: createdAt }));
    expect((b.inserts[0]!.values.retainUntil as Date).toISOString()).toBe('2028-11-15T00:00:00.000Z');
  });
});

describe('A2-19 R2 Drizzle 접속지', () => {
  test('A2-19 R2 Drizzle 접속기록 넣기 값에 source_ip가 있다', async () => {
    const a = fakeDb();
    await new DrizzleAttendeeExportStore(a.db).recordView(view({ clientIp: '203.0.113.7' }));
    expect(a.inserts).toHaveLength(1);
    expect(a.inserts[0]!.values.sourceIp).toBe('203.0.113.7');

    const b = fakeDb();
    await new DrizzleAttendeeExportStore(b.db).recordExport(record(), { clientIp: '2001:db8::1' });
    expect(b.inserts.map((i) => i.table)).toEqual([attendeeExport, attendeeExportAudit]);
    expect(b.inserts[1]!.values.sourceIp).toBe('2001:db8::1');
    // 이력(attendee_export)에는 접속지를 싣지 않는다
    expect(Object.keys(b.inserts[0]!.values)).not.toContain('sourceIp');
  });
});

describe('A2-19 접속기록 마이그레이션', () => {
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

  test('A2-19 0021은 action·filter를 더하고 LIST·DOWNLOAD 모양을 CHECK로 강제하며 UPDATE·DELETE를 주지 않는다', () => {
    const sql = read('migrations/0021_attendee_access_audit_list.sql');
    const statements = sql.split(/;|--> statement-breakpoint/).map((s) => s.trim());
    const one = (re: RegExp): string => {
      const found = statements.filter((s) => re.test(s));
      expect(found, String(re)).toHaveLength(1);
      return found[0]!;
    };
    const action = one(/ADD COLUMN "action"/);
    expect(action).toMatch(/"action" text/);
    expect(action).toContain(`DEFAULT 'DOWNLOAD'`);
    expect(action).toContain('NOT NULL');
    const filter = one(/ADD COLUMN "filter"/);
    expect(filter).toMatch(/"filter" jsonb/);
    expect(filter).toContain(`DEFAULT '{}'::jsonb`);
    expect(filter).toContain('NOT NULL');
    for (const col of ['export_id', 'reason', 'format']) one(new RegExp(`ALTER COLUMN "${col}" DROP NOT NULL`));
    // 리뷰 R2: 접속지 칸(inet)과, 0019로 들어간 옛 행은 두고 새 행에만 접속지를 강제하는 CHECK(NOT VALID)
    expect(one(/ADD COLUMN "source_ip"/)).toMatch(/"source_ip" inet/);

    // CHECK 둘(표 이름 접두·따옴표·공백을 지우고 견준다)
    const norm = sql.replace(/"attendee_export_audit"\./g, '').replace(/"/g, '').replace(/\s+/g, ' ').toLowerCase();
    expect(norm).toMatch(/check \(action in \('list', 'download'\)\)/);
    expect(norm).toContain(`action = 'download' and export_id is not null and reason is not null and format is not null`);
    expect(norm).toContain(`action = 'list' and export_id is null and reason is null and format is null`);
    expect(norm).toMatch(/check \(source_ip is not null\) not valid/);

    // 권한·행 보안은 건드리지 않는다
    const grants = sql.match(/GRANT[^;]*attendee_export_audit[^;]*/g) ?? [];
    for (const g of grants) {
      expect(g).toContain('SELECT, INSERT');
      expect(g).not.toMatch(/UPDATE|DELETE/);
    }
    expect(sql).not.toMatch(/DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY|DROP POLICY/);
    const journal = JSON.parse(read('migrations/meta/_journal.json')) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((e) => e.idx === 21)?.tag).toBe('0021_attendee_access_audit_list');
  });
});
