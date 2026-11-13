// 운영 스캐너 목록·변경분·스캔·이상 표시 저장소(Drizzle, BUILD_ORDER GAT-180·GAT-190).
// 목록은 REPEATABLE READ 한 스냅샷에서 scanner_seq와 내용을 함께 읽고(offline-gate §6.3),
// 스캔 판정·이상 표시·변경 기록은 한 트랜잭션에서 끝낸다. 티켓 표는 ticket 모듈 소유라 이름으로만 읽는다.
import type { Database, DbTransaction } from '@peaket/platform';
import { asc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { ScannerGateStore } from '../../domain/ports.js';
import type {
  GateFlagAwareness,
  GateFlagKind,
  GateFlagPage,
  GateFlagStatus,
  GateFlagView,
  ScanBatchResult,
  ScanEventInput,
  ScanResult,
  ScannerChangesView,
  ScannerPackageView,
  ScannerTicketStatus,
} from '../../domain/scanner-gate.js';
import { gateFlag, gateFlagScan, scanEvent, scannerChange, scannerSeq } from './schema.js';

interface TicketRow {
  id: string;
  seat_id: string;
  gate_zone: string;
  status: ScannerTicketStatus;
}

interface LatestScanRow {
  ticket_id: string;
  direction: 'IN' | 'OUT';
  scanned_at_device: Date | string;
  gate_zone: string;
  device_name?: string;
}

interface FlagRow {
  id: string;
  ticket_id: string;
  seat_id: string | null;
  gate_zone: string | null;
  kind: GateFlagKind;
  awareness: GateFlagAwareness;
  status: GateFlagStatus;
  created_at: Date | string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

const cursorOf = (createdAt: string, flagId: string): string => Buffer.from(JSON.stringify([Date.parse(createdAt), flagId]), 'utf8').toString('base64url');
const parseCursor = (raw: string): { atMs: number; flagId: string } | undefined => {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'string') return undefined;
    return { atMs: v[0], flagId: v[1] };
  } catch {
    return undefined;
  }
};

const flagView = (r: FlagRow): GateFlagView => ({
  flagId: r.id,
  ticketId: r.ticket_id,
  seatLabel: r.seat_id ?? '',
  gateZone: r.gate_zone ?? '',
  kind: r.kind,
  awareness: r.awareness,
  status: r.status,
  createdAt: iso(r.created_at),
});

export class DrizzleScannerGateStore implements ScannerGateStore {
  constructor(private readonly database: Database) {}

  /** 티켓 발권·취소 트랜잭션에서도 부른다. 회차 카운터를 올리고 변경 기록을 같은 트랜잭션에 넣는다. */
  append(tx: DbTransaction, eventId: string, kind: string, payload: Record<string, unknown>): Promise<number> {
    return this.appendChange(tx, eventId, kind, payload);
  }

  async appendChange(tx: DbTransaction, eventId: string, kind: string, payload: Record<string, unknown>): Promise<number> {
    const [row] = await tx
      .insert(scannerSeq)
      .values({ eventId, lastSeq: 1 })
      .onConflictDoUpdate({ target: scannerSeq.eventId, set: { lastSeq: sql`${scannerSeq.lastSeq} + 1` } })
      .returning({ lastSeq: scannerSeq.lastSeq });
    if (!row) throw new Error('스캐너 변경 일련번호를 올리지 못했다');
    await tx.insert(scannerChange).values({ eventId, seq: row.lastSeq, kind, payload, createdAt: new Date() });
    return row.lastSeq;
  }

  async package(i: { eventId: string; nowMs: number }): Promise<ScannerPackageView> {
    return this.database.transaction(
      async (tx) => {
        const tickets = (await tx.execute(sql`select id, seat_id, gate_zone, status from ticket where event_id = ${i.eventId} order by id`)).rows as unknown as TicketRow[];
        const seqRows = (await tx.execute(sql`select last_seq from scanner_seq where event_id = ${i.eventId}`)).rows as { last_seq: string | number }[];
        const scans = (
          await tx.execute(sql`
            select distinct on (se.ticket_id) se.ticket_id, se.direction, se.scanned_at_device, se.gate_zone, sd.name as device_name
            from scan_event se
            left join scanner_device sd on sd.id = se.scanner_device_id
            where se.event_id = ${i.eventId} and se.result = 'PASS' and se.method <> 'VERIFY'
            order by se.ticket_id, se.scanned_at_device desc, se.device_seq desc
          `)
        ).rows as unknown as LatestScanRow[];
        const scanByTicket = new Map(scans.map((s) => [s.ticket_id, s]));
        const keyRows = (
          await tx.execute(sql`
            select dk.ticket_id, dk.key_id, dk.public_key
            from device_key dk join ticket t on t.id = dk.ticket_id
            where t.event_id = ${i.eventId} and dk.revoked_at is null
            order by dk.ticket_id, dk.registered_at
          `)
        ).rows as { ticket_id: string; key_id: Buffer; public_key: Buffer }[];
        const revokedRows = (
          await tx.execute(sql`
            select distinct dk.key_id
            from device_key dk join ticket t on t.id = dk.ticket_id
            where t.event_id = ${i.eventId} and dk.revoked_at is not null
          `)
        ).rows as { key_id: Buffer }[];
        const keysByTicket = new Map<string, { keyId: string; publicKey: string }[]>();
        for (const r of keyRows) {
          const list = keysByTicket.get(r.ticket_id) ?? [];
          list.push({ keyId: Buffer.from(r.key_id).toString('base64url'), publicKey: Buffer.from(r.public_key).toString('base64url') });
          keysByTicket.set(r.ticket_id, list);
        }
        const zones = [...new Set(tickets.map((t) => t.gate_zone).filter((z) => z !== ''))].sort();
        return {
          eventId: i.eventId,
          reentryAllowed: false,
          gateZones: zones,
          serverTime: new Date(i.nowMs).toISOString(),
          tickets: tickets.map((t) => {
            const scan = scanByTicket.get(t.id);
            return {
              ticketId: t.id,
              gateZone: t.gate_zone,
              seatLabel: t.seat_id,
              status: t.status,
              keys: keysByTicket.get(t.id) ?? [],
              ...(scan
                ? {
                    scanState: {
                      lastDirection: scan.direction,
                      lastAt: iso(scan.scanned_at_device),
                      ...(scan.device_name ? { lastDeviceName: scan.device_name } : {}),
                      ...(scan.gate_zone ? { lastGateZone: scan.gate_zone } : {}),
                    },
                  }
                : {}),
            };
          }),
          revokedKeyIds: revokedRows.map((r) => Buffer.from(r.key_id).toString('base64url')),
          lastSeq: Number(seqRows[0]?.last_seq ?? 0),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async changes(i: { eventId: string; after: number; limit: number }): Promise<ScannerChangesView> {
    const rows = await this.database.db
      .select()
      .from(scannerChange)
      .where(sql`${scannerChange.eventId} = ${i.eventId} and ${scannerChange.seq} > ${i.after}`)
      .orderBy(asc(scannerChange.seq))
      .limit(i.limit + 1);
    const [seqRow] = await this.database.db.select({ lastSeq: scannerSeq.lastSeq }).from(scannerSeq).where(eq(scannerSeq.eventId, i.eventId)).limit(1);
    const page = rows.slice(0, i.limit);
    return {
      changes: page.map((r) => ({ seq: Number(r.seq), kind: r.kind, payload: r.payload })),
      lastSeq: Number(seqRow?.lastSeq ?? 0),
      hasMore: rows.length > i.limit,
    };
  }

  async acceptScans(i: {
    eventId: string;
    deviceId: string;
    staffAccountId: string;
    sessionId: string;
    scans: readonly ScanEventInput[];
    nowMs: number;
  }): Promise<ScanBatchResult> {
    return this.database.transaction(async (tx) => {
      const acceptedIds: string[] = [];
      const flags: GateFlagView[] = [];
      for (const scan of i.scans) {
        const existing = (await tx.execute(sql`select id from scan_event where event_id = ${i.eventId} and id = ${scan.id} limit 1`)).rows as { id: string }[];
        if (existing[0]) {
          acceptedIds.push(scan.id);
          continue;
        }
        // 같은 티켓의 두 IN이 동시에 들어와도 한 트랜잭션씩 최신 PASS를 보게 한다.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${i.eventId} || ':' || ${scan.ticketId}, 0))`);
        const ticket = ((await tx.execute(sql`select id, seat_id, gate_zone, status from ticket where event_id = ${i.eventId} and id = ${scan.ticketId} limit 1`)).rows as unknown as TicketRow[])[0];
        const latest = (
          await tx.execute(sql`
            select direction, scanned_at_device, device_seq
            from scan_event
            where event_id = ${i.eventId} and ticket_id = ${scan.ticketId} and result = 'PASS' and method <> 'VERIFY'
            order by scanned_at_device desc, device_seq desc
            limit 1
          `)
        ).rows as { direction: 'IN' | 'OUT' }[];
        const kinds: GateFlagKind[] = [];
        let result: ScanResult = scan.result;
        let reason: string | undefined = scan.reason;
        let keyBad: 'INVALID_QR' | 'KEY_REVOKED' | 'KEY_UNKNOWN' | undefined;
        if (scan.keyId !== undefined) {
          const keyId = /^[A-Za-z0-9_-]{11}$/.test(scan.keyId) ? Buffer.from(scan.keyId, 'base64url') : undefined;
          if (!keyId || keyId.length !== 8) keyBad = 'INVALID_QR';
          else {
            const state = await this.#keyState(tx, scan.ticketId, keyId);
            if (state === 'REVOKED') keyBad = 'KEY_REVOKED';
            else if (state === 'UNKNOWN') keyBad = 'KEY_UNKNOWN';
          }
        }
        if (!ticket) {
          result = 'REJECT';
          reason = 'UNKNOWN_TICKET';
        } else if (ticket.status === 'CANCEL_REQUESTED' || ticket.status === 'REFUNDED' || ticket.status === 'VOIDED') {
          result = 'REJECT';
          reason = 'TICKET_CANCELLED';
          if (scan.direction === 'IN') kinds.push('AFTER_CANCEL');
        } else if (scan.method === 'VERIFY') {
          result = 'CHECK';
          reason = 'VERIFY_ONLY';
        } else if (keyBad) {
          result = 'REJECT';
          reason = keyBad;
        } else if (scan.direction === 'IN' && latest[0]?.direction === 'IN') {
          result = 'REJECT';
          reason = 'ALREADY_IN';
          kinds.push('DUPLICATE');
        } else if (scan.direction === 'OUT' && latest[0]?.direction !== 'IN') {
          result = 'CHECK';
          reason = 'NO_ENTRY_RECORD';
        }
        if (scan.scannerSessionId !== i.sessionId) kinds.push('OUT_OF_SESSION');
        const inserted = await tx
          .insert(scanEvent)
          .values({
            id: scan.id,
            eventId: i.eventId,
            ticketId: scan.ticketId,
            scannerDeviceId: i.deviceId,
            scannerSessionId: scan.scannerSessionId,
            staffAccountId: i.staffAccountId,
            direction: scan.direction,
            method: scan.method,
            result,
            reason: reason ?? null,
            gateZone: scan.gateZone ?? ticket?.gate_zone ?? '',
            keyId: scan.keyId === undefined ? null : Buffer.from(scan.keyId, 'base64url'),
            qrTs: scan.qrTimestamp === undefined ? null : new Date(scan.qrTimestamp),
            scannedAtDevice: new Date(scan.scannedAtDevice),
            clockOffsetMs: scan.clockOffsetMs ?? null,
            knownSeq: scan.knownSeq,
            deviceSeq: scan.deviceSeq,
            receivedAt: new Date(i.nowMs),
            flag: kinds[0] ?? 'NONE',
          })
          .onConflictDoNothing()
          .returning({ id: scanEvent.id });
        if (!inserted[0]) {
          acceptedIds.push(scan.id);
          continue;
        }
        acceptedIds.push(scan.id);
        for (const kind of kinds) {
          const flagId = randomUUID();
          const [flagRow] = await tx
            .insert(gateFlag)
            .values({ id: flagId, eventId: i.eventId, ticketId: scan.ticketId, kind, awareness: scan.knownSeq < (await this.#lastSeq(tx, i.eventId)) ? 'CONCURRENT' : 'KNOWN', status: 'OPEN', createdAt: new Date(i.nowMs) })
            .returning();
          if (!flagRow) continue;
          await tx.insert(gateFlagScan).values({ flagId, scanEventId: scan.id });
          await this.appendChange(tx, i.eventId, 'FLAG', { v: 1, flagId, ticketId: scan.ticketId, kind, status: 'OPEN' });
          flags.push({
            flagId,
            ticketId: scan.ticketId,
            seatLabel: ticket?.seat_id ?? '',
            gateZone: ticket?.gate_zone ?? '',
            kind,
            awareness: flagRow.awareness as GateFlagAwareness,
            status: 'OPEN',
            createdAt: new Date(i.nowMs).toISOString(),
          });
        }
        if (result === 'PASS' && scan.method !== 'VERIFY') {
          await this.appendChange(tx, i.eventId, 'SCAN_STATE', {
            v: 1,
            ticketId: scan.ticketId,
            direction: scan.direction,
            scannedAtDevice: scan.scannedAtDevice,
            gateZone: scan.gateZone ?? ticket?.gate_zone ?? '',
            deviceId: i.deviceId,
          });
        }
      }
      return { acceptedIds, flags };
    });
  }

  async listFlags(i: { eventId: string; cursor?: string; limit: number }): Promise<GateFlagPage> {
    const cursor = i.cursor ? parseCursor(i.cursor) : undefined;
    const rows = (
      cursor
        ? await this.database.db.execute(sql`
            select f.id, f.ticket_id, t.seat_id, t.gate_zone, f.kind, f.awareness, f.status, f.created_at
            from gate_flag f left join ticket t on t.id = f.ticket_id
            where f.event_id = ${i.eventId} and (f.created_at < ${new Date(cursor.atMs)} or (f.created_at = ${new Date(cursor.atMs)} and f.id < ${cursor.flagId}))
            order by f.created_at desc, f.id desc limit ${i.limit + 1}
          `)
        : await this.database.db.execute(sql`
            select f.id, f.ticket_id, t.seat_id, t.gate_zone, f.kind, f.awareness, f.status, f.created_at
            from gate_flag f left join ticket t on t.id = f.ticket_id
            where f.event_id = ${i.eventId}
            order by f.created_at desc, f.id desc limit ${i.limit + 1}
          `)
    ).rows as unknown as FlagRow[];
    const page = rows.slice(0, i.limit);
    const last = page.at(-1);
    return { items: page.map(flagView), ...(rows.length > i.limit && last ? { nextCursor: cursorOf(iso(last.created_at), last.id) } : {}) };
  }

  async flagEventId(flagId: string): Promise<string | undefined> {
    const [row] = await this.database.db.select({ eventId: gateFlag.eventId }).from(gateFlag).where(eq(gateFlag.id, flagId)).limit(1);
    return row?.eventId;
  }

  async resolveFlag(i: { eventId: string; flagId: string; status: GateFlagStatus; note?: string; resolvedBy: string; nowMs: number }): Promise<GateFlagView | undefined> {
    return this.database.transaction(async (tx) => {
      const [updated] = await tx
        .update(gateFlag)
        .set({ status: i.status, resolvedBy: i.resolvedBy, resolvedAt: new Date(i.nowMs), note: i.note ?? null })
        .where(sql`${gateFlag.id} = ${i.flagId} and ${gateFlag.eventId} = ${i.eventId}`)
        .returning();
      if (!updated) return undefined;
      const rows = (
        await tx.execute(sql`
          select f.id, f.ticket_id, t.seat_id, t.gate_zone, f.kind, f.awareness, f.status, f.created_at
          from gate_flag f left join ticket t on t.id = f.ticket_id where f.id = ${i.flagId}
        `)
      ).rows as unknown as FlagRow[];
      await this.appendChange(tx, i.eventId, 'FLAG', { v: 1, flagId: i.flagId, ticketId: updated.ticketId, kind: updated.kind, status: i.status });
      return rows[0] ? flagView(rows[0]) : undefined;
    });
  }

  async #lastSeq(tx: DbTransaction, eventId: string): Promise<number> {
    const [row] = await tx.select({ lastSeq: scannerSeq.lastSeq }).from(scannerSeq).where(eq(scannerSeq.eventId, eventId)).limit(1);
    return Number(row?.lastSeq ?? 0);
  }

  /** 스캔 기록의 keyId가 그 티켓의 유효 키인지 폐기됐는지 모르는지(같은 트랜잭션 스냅샷) */
  async #keyState(tx: DbTransaction, ticketId: string, keyId: Buffer): Promise<'ACTIVE' | 'REVOKED' | 'UNKNOWN'> {
    const rows = (
      await tx.execute(sql`
        select count(*) filter (where revoked_at is null)::int as active,
               count(*) filter (where revoked_at is not null)::int as revoked
        from device_key where ticket_id = ${ticketId} and key_id = ${keyId}
      `)
    ).rows as { active: number; revoked: number }[];
    const r = rows[0];
    if (Number(r?.active ?? 0) > 0) return 'ACTIVE';
    if (Number(r?.revoked ?? 0) > 0) return 'REVOKED';
    return 'UNKNOWN';
  }
}
