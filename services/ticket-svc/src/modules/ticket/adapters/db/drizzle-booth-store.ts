// 운영 부스 재발급 저장소(BUILD_ORDER GAT-190, F-05-12 O-T28). 부스 코드·허용·사용 표시와
// SCR-052 기기 현황·내 예외 통과를 PostgreSQL에서 읽고 쓴다.
// 코드 해시(SHA-256 hex)만 두고, BOOTH 사용 표시는 DrizzleDeviceKeyStore의 키 저장과 같은 트랜잭션에서 적는다.
import type { Database, DbTransaction } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ScannerPlacementMissing } from '../../../scanner/index.js';
import type { GateStatusView, OverridePassView, OverrideReviewStatus } from '../../domain/booth.js';
import type { BoothStore } from '../../domain/ports.js';

interface Row {
  id: string;
  ticket_id: string;
  event_id: string;
  status: string;
  expires_at: Date | string | null;
  used_at: Date | string | null;
  seat_label: string | null;
  seat_id: string;
}

const ms = (v: Date | string | null): number | undefined => (v === null ? undefined : v instanceof Date ? v.getTime() : Date.parse(v));
const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

export class DrizzleBoothStore implements BoothStore {
  constructor(private readonly o: { database: Database }) {}

  async ownerOf(ticketId: string): Promise<string | undefined> {
    const rows = (await this.o.database.db.execute(sql`select account_id from ticket where id = ${ticketId} limit 1`)).rows as { account_id: string }[];
    return rows[0]?.account_id;
  }

  async createRequest(i: { ticketId: string; accountId: string; codeHash: string; nowMs: number; dayKey: string; expiresAtMs: number; reverificationId?: string }) {
    return this.o.database.transaction(async (tx) => {
      const rows = (await tx.execute(sql`select id, account_id, event_id, event_starts_at from ticket where id = ${i.ticketId} limit 1 for update`)).rows as unknown as { id: string; account_id: string; event_id: string; event_starts_at: Date | string | null }[];
      const t = rows[0];
      if (!t || t.account_id !== i.accountId) return { kind: 'not_found' as const };
      if (t.event_starts_at === null || i.nowMs < ms(t.event_starts_at)!) return { kind: 'before_entry' as const };
      const used = (await tx.execute(sql`select count(*)::int n from booth_authorization where ticket_id = ${i.ticketId} and day_key = ${i.dayKey}`)).rows as { n: number }[];
      if ((used[0]?.n ?? 0) >= 3) return { kind: 'limit' as const };
      await tx.execute(sql`update booth_authorization set status = 'EXPIRED' where ticket_id = ${i.ticketId} and status = 'PENDING'`);
      const id = randomUUID();
      await tx.execute(sql`
        insert into booth_authorization (id, ticket_id, event_id, booth_code_hash, reverification_id, status, day_key, requested_at, code_expires_at)
        values (${id}, ${i.ticketId}, ${t.event_id}, ${i.codeHash}, ${i.reverificationId ?? null}, 'PENDING', ${i.dayKey}, ${new Date(i.nowMs)}, ${new Date(i.expiresAtMs)})
      `);
      return { kind: 'created' as const, boothRequestId: id, expiresAtMs: i.expiresAtMs };
    });
  }

  async authorize(i: { eventId: string; deviceId: string; codeHash: string; nowMs: number; allowUntilMs: number }) {
    return this.o.database.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        select b.id, b.ticket_id, b.event_id, b.status, b.expires_at, b.used_at, coalesce(t.seat_label, t.seat_id::text) seat_label, t.seat_id
        from booth_authorization b join ticket t on t.id = b.ticket_id
        where b.booth_code_hash = ${i.codeHash} and b.status in ('PENDING','ALLOWED','USED')
        order by case b.status when 'PENDING' then 0 when 'ALLOWED' then 1 else 2 end, b.requested_at desc limit 1 for update of b
      `)).rows as unknown as Row[];
      const r = rows[0];
      if (!r) return { kind: 'not_found' as const };
      // 회차를 먼저 거르면 다른 회차 기기의 코드가 not_found(410)가 된다. 코드로 먼저 찾고 회차 불일치는 event_mismatch(403)다(TR-25)
      if (r.event_id !== i.eventId) return { kind: 'event_mismatch' as const };
      if (r.used_at !== null || r.status === 'USED') return { kind: 'expired' as const };
      const codeExpired = (await tx.execute(sql`select code_expires_at from booth_authorization where id = ${r.id}`)).rows as { code_expires_at: Date | string }[];
      if (ms(codeExpired[0]!.code_expires_at)! <= i.nowMs) return { kind: 'expired' as const };
      if (r.status === 'PENDING') {
        await tx.execute(sql`update booth_authorization set status = 'ALLOWED', allowed_at = ${new Date(i.nowMs)}, expires_at = ${new Date(i.allowUntilMs)} where id = ${r.id}`);
        return { kind: 'authorized' as const, ticketId: r.ticket_id, seatLabel: r.seat_label ?? r.seat_id, allowUntilMs: i.allowUntilMs };
      }
      return { kind: 'authorized' as const, ticketId: r.ticket_id, seatLabel: r.seat_label ?? r.seat_id, allowUntilMs: ms(r.expires_at)! };
    });
  }

  async consumeForRegistration(i: { ticketId: string; boothRequestId: string; nowMs: number }, tx?: unknown): Promise<boolean> {
    const run = async (db: DbTransaction): Promise<boolean> => {
      const rows = (await db.execute(sql`
        update booth_authorization set used_at = ${new Date(i.nowMs)}, status = 'USED'
        where id = ${i.boothRequestId} and ticket_id = ${i.ticketId} and status = 'ALLOWED' and used_at is null and expires_at > ${new Date(i.nowMs)}
        returning id
      `)).rows as { id: string }[];
      return rows.length > 0;
    };
    return tx ? run(tx as DbTransaction) : this.o.database.transaction(run);
  }

  async gateStatus(i: { eventId: string; deviceId: string }): Promise<GateStatusView> {
    const placement = (await this.o.database.db.execute(sql`select gate_zone from scanner_placement where event_id = ${i.eventId} and scanner_device_id = ${i.deviceId} limit 1`)).rows as { gate_zone: string }[];
    if (!placement[0]) throw new ScannerPlacementMissing();
    const devices = (await this.o.database.db.execute(sql`
      select p.scanner_device_id device_id, d.name, p.gate_zone, p.mode, p.version,
             r.package_seq, r.pending_uploads, r.reported_at
      from scanner_placement p
      join scanner_device d on d.id = p.scanner_device_id
      left join scanner_readiness r on r.event_id = p.event_id and r.scanner_device_id = p.scanner_device_id
      where p.event_id = ${i.eventId}
      order by p.scanner_device_id
    `)).rows as unknown as { device_id: string; name: string; gate_zone: string; mode: 'IN' | 'OUT'; version: number; package_seq: number | null; pending_uploads: number | null; reported_at: Date | string | null }[];
    const entries = (await this.o.database.db.execute(sql`select gate_zone, count(*)::int n from scan_event where event_id = ${i.eventId} and result = 'PASS' and method <> 'VERIFY' group by gate_zone`)).rows as { gate_zone: string; n: number }[];
    const rejects = (await this.o.database.db.execute(sql`select reason, count(*)::int n from scan_event where event_id = ${i.eventId} and result = 'REJECT' and reason is not null group by reason`)).rows as { reason: string; n: number }[];
    const open = (await this.o.database.db.execute(sql`select count(*)::int n from gate_flag where event_id = ${i.eventId} and status = 'OPEN'`)).rows as { n: number }[];
    const booths = (await this.o.database.db.execute(sql`select count(*)::int n from booth_authorization where event_id = ${i.eventId} and status = 'USED'`)).rows as { n: number }[];
    const overrides = (await this.o.database.db.execute(sql`select count(*)::int n from scan_event where event_id = ${i.eventId} and method = 'OVERRIDE'`)).rows as { n: number }[];
    const close = (await this.o.database.db.execute(sql`select closed_at from entry_close where event_id = ${i.eventId} limit 1`)).rows as { closed_at: Date | string }[];
    return {
      devices: devices.map((d) => ({
        deviceId: d.device_id,
        name: d.name,
        placement: { gateZone: d.gate_zone, mode: d.mode, version: d.version },
        ready: d.reported_at !== null,
        ...(d.package_seq !== null ? { packageSeq: d.package_seq } : {}),
        ...(d.reported_at !== null ? { lastSyncAt: iso(d.reported_at) } : {}),
        pendingUploads: d.pending_uploads ?? 0,
      })),
      entriesByZone: Object.fromEntries(entries.filter((e) => e.gate_zone !== '').map((e) => [e.gate_zone, e.n])),
      rejectsByReason: Object.fromEntries(rejects.map((r) => [r.reason, r.n])),
      openFlags: open[0]?.n ?? 0,
      boothCount: booths[0]?.n ?? 0,
      overrideCount: overrides[0]?.n ?? 0,
      ...(close[0] ? { entryClosedAt: iso(close[0].closed_at) } : {}),
    };
  }

  async overridePasses(i: { eventId: string; staffAccountId: string; deviceId: string; limit: number }): Promise<OverridePassView[]> {
    const placement = (await this.o.database.db.execute(sql`select 1 from scanner_placement where event_id = ${i.eventId} and scanner_device_id = ${i.deviceId} limit 1`)).rows as unknown[];
    if (placement.length === 0) throw new ScannerPlacementMissing();
    const rows = (await this.o.database.db.execute(sql`
      select se.id scan_id, se.scanned_at_device, se.ticket_id, coalesce(t.seat_label, t.seat_id::text) seat_label,
             coalesce(se.reason, 'OVERRIDE_OTHER') reason, se.override_note note, gf.status flag_status
      from scan_event se
      join ticket t on t.id = se.ticket_id
      left join gate_flag gf on gf.event_id = se.event_id and gf.ticket_id = se.ticket_id and gf.kind = 'OVERRIDE_REVIEW'
      where se.event_id = ${i.eventId} and se.method = 'OVERRIDE' and se.staff_account_id = ${i.staffAccountId}
      order by se.scanned_at_device desc, se.device_seq desc
      limit ${i.limit}
    `)).rows as unknown as { scan_id: string; scanned_at_device: Date | string; ticket_id: string; seat_label: string; reason: string; note: string | null; flag_status: string | null }[];
    return rows.map((r) => {
      const s: OverrideReviewStatus = r.flag_status === 'OK' ? 'OK' : r.flag_status === 'SUSPECT' ? 'SUSPECT' : r.flag_status === 'UNDETERMINED' ? 'UNDETERMINED' : 'WAITING';
      return { scanId: r.scan_id, at: iso(r.scanned_at_device), ticketId: r.ticket_id, seatLabel: r.seat_label, reason: r.reason, ...(r.note !== null ? { note: r.note } : {}), reviewStatus: s };
    });
  }
}
