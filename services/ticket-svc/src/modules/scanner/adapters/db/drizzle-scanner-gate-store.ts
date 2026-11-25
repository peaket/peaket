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
  ScannerVersionVector,
} from '../../domain/scanner-gate.js';
import { gateFlag, gateFlagScan, scanEvent, scannerChange, scannerEventPolicy, scannerSeq } from './schema.js';

interface TicketRow {
  id: string;
  seat_id: string;
  seat_label?: string | null;
  gate_zone: string;
  status: ScannerTicketStatus;
  cancelled_at?: Date | string | null;
}

interface LatestScanRow {
  ticket_id: string;
  direction: 'IN' | 'OUT';
  scanned_at_device: Date | string;
  gate_zone: string;
  device_name?: string;
}

interface PassScanRow {
  id: string;
  direction: 'IN' | 'OUT';
  scanned_at_device: Date | string;
  clock_offset_ms: number | null;
  device_seq: string | number;
  known_seq: string | number;
  state_seq: string | number | null;
}

/** 보정 시각 = scannedAtDevice(이미 기기 시계 오차를 더한 값). 서버는 clock_offset_ms를 다시 더하지 않는다(offline-gate §7.1) */
const correctedOf = (r: { scanned_at_device: Date | string }): number => (r.scanned_at_device instanceof Date ? r.scanned_at_device.getTime() : Date.parse(r.scanned_at_device));
/** 마지막 보정 뒤 ±2분 [가정] 넘게 어긋나면 시각 불확실(offline-gate §7.1) */
const CLOCK_UNCERTAIN_MS = 2 * 60_000;

interface FlagRow {
  id: string;
  ticket_id: string;
  seat_id: string | null;
  seat_label?: string | null;
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
  seatLabel: r.seat_label ?? r.seat_id ?? '',
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

  async versionVector(eventId: string, nowMs: number): Promise<ScannerVersionVector> {
    return this.database.transaction(
      async (tx) => {
        const seqRows = (await tx.execute(sql`select last_seq from scanner_seq where event_id = ${eventId}`)).rows as { last_seq: string | number }[];
        const kindRows = (await tx.execute(sql`select kind, max(seq) as seq from scanner_change where event_id = ${eventId} group by kind`)).rows as { kind: string; seq: string | number }[];
        const lastOf = (...kinds: string[]) => Math.max(0, ...kindRows.filter((r) => kinds.includes(r.kind)).map((r) => Number(r.seq)));
        return {
          eventId,
          seq: Number(seqRows[0]?.last_seq ?? 0),
          ticketSeq: lastOf('TICKET_STATUS'),
          keySeq: lastOf('KEY_REGISTERED', 'KEY_REVOKED'),
          policySeq: lastOf('POLICY'),
          placementSeq: lastOf('PLACEMENT'),
          flagSeq: lastOf('FLAG'),
          issuedAt: new Date(nowMs).toISOString(),
          maxOfflineMs: 0,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  /**
   * 정책 사본을 조건부로 바꾸고(옛 값일 때만) POLICY를 같은 트랜잭션에 적는다.
   * 두 요청이 겹치면 행 잠금이 차례로 처리해 한 줄만 적힌다. DB 오류는 사본 값 그대로 돌려준다(요청을 실패시키지 않는다).
   */
  async syncPolicy(i: { eventId: string; coreReentryAllowed?: boolean; atMs: number }): Promise<{ reentryAllowed?: boolean; changedSeq?: number }> {
    try {
      return await this.database.transaction(async (tx) => {
        if (i.coreReentryAllowed !== undefined) {
          const updated = (
            await tx.execute(sql`
              update scanner_event_policy
              set reentry_allowed = ${i.coreReentryAllowed}, observed_at = ${new Date(i.atMs)}
              where event_id = ${i.eventId} and reentry_allowed <> ${i.coreReentryAllowed}
              returning reentry_allowed
            `)
          ).rows as { reentry_allowed: boolean }[];
          if (updated.length > 0) {
            const seq = await this.appendChange(tx, i.eventId, 'POLICY', { v: 1, reentryAllowed: i.coreReentryAllowed });
            await tx.execute(sql`update scanner_event_policy set policy_seq = ${seq} where event_id = ${i.eventId}`);
            return { reentryAllowed: i.coreReentryAllowed, changedSeq: seq };
          }
        }
        const existing = (await tx.execute(sql`select reentry_allowed from scanner_event_policy where event_id = ${i.eventId}`)).rows as { reentry_allowed: boolean }[];
        if (existing[0]) return { reentryAllowed: existing[0].reentry_allowed };
        if (i.coreReentryAllowed === undefined) return {};
        const inserted = (
          await tx.execute(sql`
            insert into scanner_event_policy (event_id, reentry_allowed, policy_seq, observed_at)
            values (${i.eventId}, ${i.coreReentryAllowed}, 0, ${new Date(i.atMs)})
            on conflict (event_id) do nothing
            returning reentry_allowed
          `)
        ).rows as { reentry_allowed: boolean }[];
        if (inserted[0]) return { reentryAllowed: inserted[0].reentry_allowed };
        // 그 사이 다른 요청이 만들었다. 그 값을 쓴다
        const again = (await tx.execute(sql`select reentry_allowed from scanner_event_policy where event_id = ${i.eventId}`)).rows as { reentry_allowed: boolean }[];
        return again[0] ? { reentryAllowed: again[0].reentry_allowed } : {};
      });
    } catch {
      try {
        const copy = (await this.database.db.execute(sql`select reentry_allowed from scanner_event_policy where event_id = ${i.eventId}`)).rows as { reentry_allowed: boolean }[];
        return copy[0] ? { reentryAllowed: copy[0].reentry_allowed } : {};
      } catch {
        return {};
      }
    }
  }

  async package(i: { eventId: string; nowMs: number }): Promise<ScannerPackageView> {
    return this.database.transaction(
      async (tx) => {
        const tickets = (await tx.execute(sql`select id, seat_id, seat_label, gate_zone, status from ticket where event_id = ${i.eventId} order by id`)).rows as unknown as TicketRow[];
        const seqRows = (await tx.execute(sql`select last_seq from scanner_seq where event_id = ${i.eventId}`)).rows as { last_seq: string | number }[];
        const kindRows = (await tx.execute(sql`select kind, max(seq) as seq from scanner_change where event_id = ${i.eventId} group by kind`)).rows as { kind: string; seq: string | number }[];
        const lastOf = (...kinds: string[]) => Math.max(0, ...kindRows.filter((r) => kinds.includes(r.kind)).map((r) => Number(r.seq)));
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
              seatLabel: t.seat_label ?? t.seat_id,
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
          versionVector: {
            eventId: i.eventId,
            seq: Number(seqRows[0]?.last_seq ?? 0),
            ticketSeq: lastOf('TICKET_STATUS'),
            keySeq: lastOf('KEY_REGISTERED', 'KEY_REVOKED'),
            policySeq: lastOf('POLICY'),
            placementSeq: lastOf('PLACEMENT'),
            flagSeq: lastOf('FLAG'),
            issuedAt: new Date(i.nowMs).toISOString(),
            maxOfflineMs: 0,
          },
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async changes(i: { eventId: string; after: number; limit: number; nowMs?: number }): Promise<ScannerChangesView> {
    return this.database.transaction(
      async (tx) => {
        const rows = await tx
          .select()
          .from(scannerChange)
          .where(sql`${scannerChange.eventId} = ${i.eventId} and ${scannerChange.seq} > ${i.after}`)
          .orderBy(asc(scannerChange.seq))
          .limit(i.limit + 1);
        const [seqRow] = await tx.select({ lastSeq: scannerSeq.lastSeq }).from(scannerSeq).where(eq(scannerSeq.eventId, i.eventId)).limit(1);
        const kindRows = (await tx.execute(sql`select kind, max(seq) as seq from scanner_change where event_id = ${i.eventId} group by kind`)).rows as { kind: string; seq: string | number }[];
        const lastOf = (...kinds: string[]) => Math.max(0, ...kindRows.filter((r) => kinds.includes(r.kind)).map((r) => Number(r.seq)));
        const page = rows.slice(0, i.limit);
        return {
          changes: page.map((r) => ({ seq: Number(r.seq), kind: r.kind, payload: r.payload })),
          // 페이지 끝 번호를 커서로 준다. 앱은 저장한 마지막 번호로 다음 쪽을 받는다(C1-05).
          lastSeq: page.length > 0 ? Number(page.at(-1)!.seq) : i.after,
          hasMore: rows.length > i.limit,
          versionVector: {
            eventId: i.eventId,
            seq: Number(seqRow?.lastSeq ?? 0),
            ticketSeq: lastOf('TICKET_STATUS'),
            keySeq: lastOf('KEY_REGISTERED', 'KEY_REVOKED'),
            policySeq: lastOf('POLICY'),
            placementSeq: lastOf('PLACEMENT'),
            flagSeq: lastOf('FLAG'),
            issuedAt: new Date(i.nowMs ?? Date.now()).toISOString(),
            maxOfflineMs: 0,
          },
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async acceptScans(i: {
    eventId: string;
    deviceId: string;
    staffAccountId?: string;
    sessionId?: string;
    placement?: { gateZone: string; mode: 'IN' | 'OUT' };
    reentryAllowed?: boolean;
    sessions?: Readonly<Record<string, { accountId?: string; validFromMs?: number; validUntilMs?: number }>>;
    scans: readonly ScanEventInput[];
    nowMs: number;
    staleVersionIds?: readonly string[];
  }): Promise<ScanBatchResult> {
    return this.database.transaction(async (tx) => {
      // 입장 기록 마감(배타)과 겹치지 않게 같은 회차 잠금을 공유로 잡는다(offline-gate §7.3 '한 번만, 업로드와 겹칠 때').
      // 마감 커밋 전이면 마감 전 기록으로, 커밋 뒤면 받은 시각이 마감 시각보다 커 '마감 뒤 도착'으로 받는다
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('ticket-entry-close:' || ${i.eventId}, 0))`);
      const closeRows = (await tx.execute(sql`select closed_at from entry_close where event_id = ${i.eventId} limit 1`)).rows as unknown as { closed_at: Date | string }[];
      const closedAtMs = closeRows[0] ? (closeRows[0].closed_at instanceof Date ? closeRows[0].closed_at.getTime() : Date.parse(closeRows[0].closed_at)) : undefined;
      const acceptedIds: string[] = [];
      const duplicateIds: string[] = [];
      const flags: GateFlagView[] = [];
      const stale = new Set(i.staleVersionIds ?? []);
      const makeFlag = async (ticket: TicketRow | undefined, ticketId: string, kind: GateFlagKind, knownSeq: number, scanId: string, awarenessBase?: number | null): Promise<void> => {
        const flagId = randomUUID();
        // '몰랐음/알고도 통과'는 정상으로 남은 가장 이른 기록의 state_seq와 견준다(offline-gate §7.1).
        // awarenessBase가 null이면 그 기록에 state_seq가 없는 옛 행이라 CONCURRENT다
        const base = awarenessBase === null ? null : (awarenessBase ?? (await this.#lastSeq(tx, i.eventId)));
        const awareness: GateFlagAwareness = base === null || knownSeq < base ? 'CONCURRENT' : 'KNOWN';
        const [flagRow] = await tx
          .insert(gateFlag)
          .values({ id: flagId, eventId: i.eventId, ticketId, kind, awareness, status: 'OPEN', createdAt: new Date(i.nowMs) })
          .returning();
        if (!flagRow) return;
        await tx.insert(gateFlagScan).values({ flagId, scanEventId: scanId });
        await this.appendChange(tx, i.eventId, 'FLAG', { v: 1, flagId, ticketId, kind, status: 'OPEN' });
        flags.push({
          flagId,
          ticketId,
          seatLabel: ticket ? (ticket.seat_label ?? ticket.seat_id) : '',
          gateZone: ticket?.gate_zone ?? '',
          kind,
          awareness: flagRow.awareness as GateFlagAwareness,
          status: 'OPEN',
          createdAt: new Date(i.nowMs).toISOString(),
        });
      };
      for (const scan of i.scans) {
        const existing = (await tx.execute(sql`select id from scan_event where event_id = ${i.eventId} and id = ${scan.id} limit 1`)).rows as { id: string }[];
        if (existing[0]) {
          acceptedIds.push(scan.id);
          duplicateIds.push(scan.id);
          continue;
        }
        // 같은 티켓의 두 IN이 동시에 들어와도 한 트랜잭션씩 최신 PASS를 보게 한다.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${i.eventId} || ':' || ${scan.ticketId}, 0))`);
        const ticket = (
          (await tx.execute(sql`
            select t.id, t.seat_id, t.seat_label, t.gate_zone, t.status,
                   (select min(c.cancelled_at) from ticket_cancellation c where c.ticket_id = t.id) as cancelled_at
            from ticket t where t.event_id = ${i.eventId} and t.id = ${scan.ticketId} limit 1
          `)).rows as unknown as TicketRow[]
        )[0];
        const passRows = (
          await tx.execute(sql`
            select id, direction, scanned_at_device, clock_offset_ms, device_seq, known_seq, state_seq
            from scan_event
            where event_id = ${i.eventId} and ticket_id = ${scan.ticketId} and result = 'PASS' and method <> 'VERIFY'
            order by scanned_at_device asc, device_seq asc
          `)
        ).rows as unknown as PassScanRow[];
        const latest = passRows.at(-1);
        const corrected = Date.parse(scan.scannedAtDevice);
        const session = i.sessions?.[scan.scannerSessionId];
        const kinds: GateFlagKind[] = [];
        const demoted: PassScanRow[] = [];
        /** 이 기록이 '중복 입장'일 때 견줄 정상 기록의 state_seq(null이면 옛 행) */
        let duplicateBase: number | null | undefined;
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
        // 취소 접수 뒤의 입장만 취소다. 취소 시각보다 이른 기록은 정상 판정으로 넘긴다(C1-04).
        const cancelledAt = ticket?.cancelled_at ? (ticket.cancelled_at instanceof Date ? ticket.cancelled_at.getTime() : Date.parse(ticket.cancelled_at)) : undefined;
        const cancelledAfter = cancelledAt !== undefined && corrected < cancelledAt;
        if (!ticket) {
          result = 'REJECT';
          reason = 'UNKNOWN_TICKET';
        } else if ((ticket.status === 'CANCEL_REQUESTED' || ticket.status === 'REFUNDED' || ticket.status === 'VOIDED') && !cancelledAfter) {
          result = 'REJECT';
          reason = 'TICKET_CANCELLED';
          if (scan.direction === 'IN') kinds.push('AFTER_CANCEL');
        } else if (scan.method === 'VERIFY') {
          result = 'CHECK';
          reason = 'VERIFY_ONLY';
        } else if (keyBad) {
          result = 'REJECT';
          reason = keyBad;
        } else if (i.placement && (ticket.gate_zone !== i.placement.gateZone || (scan.gateZone !== undefined && scan.gateZone !== i.placement.gateZone) || i.placement.mode !== scan.direction)) {
          // 티켓 구역·기기 배치 구역·배치 모드가 다르면 거부한다(offline-gate §6.4 8, §7.1).
          result = 'REJECT';
          reason = 'WRONG_ZONE';
        } else if (scan.direction === 'IN' && i.reentryAllowed === true && result !== 'REJECT') {
          if (latest?.direction === 'IN') {
            result = 'CHECK';
            reason = 'NO_EXIT_RECORD';
            kinds.push('NO_EXIT');
          }
        } else if (scan.direction === 'IN' && result === 'PASS') {
          const firstIn = passRows.find((s) => s.direction === 'IN');
          if (firstIn && (corrected > correctedOf(firstIn) || (corrected === correctedOf(firstIn) && scan.deviceSeq > Number(firstIn.device_seq)))) {
            result = 'REJECT';
            reason = 'ALREADY_IN';
            kinds.push('DUPLICATE');
            // 정상 기록의 state_seq와 견준다. 그 값이 없으면(옛 행) CONCURRENT다
            duplicateBase = firstIn.state_seq === null ? null : Number(firstIn.state_seq);
          } else if (firstIn) {
            // 늦게 올라온 더 이른 기록이 정상이 된다. 먼저 통과했던 뒤 기록은 중복으로 내린다(C1-03).
            for (const old of passRows) if (old.direction === 'IN') demoted.push(old);
          }
        } else if (scan.direction === 'OUT' && latest?.direction !== 'IN') {
          result = 'CHECK';
          reason = 'NO_ENTRY_RECORD';
        }
        if (session) {
          if (session.validFromMs !== undefined && session.validUntilMs !== undefined && (corrected < session.validFromMs || corrected > session.validUntilMs)) kinds.push('OUT_OF_SESSION');
        } else if (i.sessionId === undefined || scan.scannerSessionId !== i.sessionId) {
          kinds.push('OUT_OF_SESSION');
        }
        // '마감 뒤 도착'은 받은 시각이 ticket-svc 마감 행의 시각보다 뒤일 때다(core 사본 값이 아니다, offline-gate §7.3)
        if (closedAtMs !== undefined && i.nowMs > closedAtMs) kinds.push('AFTER_CLOSE');
        if (scan.clockOffsetMs !== undefined && Math.abs(scan.clockOffsetMs) > CLOCK_UNCERTAIN_MS) kinds.push('TIME_UNCERTAIN');
        if (stale.has(scan.id)) kinds.push('STALE_VERSION');
        if (scan.method === 'OVERRIDE') kinds.push('OVERRIDE_REVIEW');
        const staffAccountId = session?.accountId ?? i.staffAccountId;
        const inserted = await tx
          .insert(scanEvent)
          .values({
            id: scan.id,
            eventId: i.eventId,
            ticketId: scan.ticketId,
            scannerDeviceId: i.deviceId,
            scannerSessionId: scan.scannerSessionId,
            staffAccountId: staffAccountId ?? null,
            direction: scan.direction,
            method: scan.method,
            result,
            reason: reason ?? null,
            overrideNote: scan.overrideNote ?? null,
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
          duplicateIds.push(scan.id);
          continue;
        }
        acceptedIds.push(scan.id);
        for (const kind of kinds) await makeFlag(ticket, scan.ticketId, kind, scan.knownSeq, scan.id, kind === 'DUPLICATE' ? duplicateBase : undefined);
        let stateSeq: number | undefined;
        if (result === 'PASS' && scan.method !== 'VERIFY') {
          stateSeq = await this.appendChange(tx, i.eventId, 'SCAN_STATE', {
            v: 1,
            ticketId: scan.ticketId,
            direction: scan.direction,
            scannedAtDevice: scan.scannedAtDevice,
            gateZone: scan.gateZone ?? ticket?.gate_zone ?? '',
            deviceId: i.deviceId,
          });
          // 이 기록이 적은 SCAN_STATE 변경 번호. 나중 '중복 입장'의 갈림이 이 값과 견준다(C1-03)
          await tx.execute(sql`update scan_event set state_seq = ${stateSeq} where event_id = ${i.eventId} and id = ${scan.id}`);
        }
        for (const old of demoted) {
          await tx.execute(sql`update scan_event set result = 'REJECT', reason = 'ALREADY_IN', flag = 'DUPLICATE' where event_id = ${i.eventId} and id = ${old.id}`);
          // 내려간 기록은 새로 정상이 된 기록의 state_seq와 견준다
          await makeFlag(ticket, scan.ticketId, 'DUPLICATE', Number(old.known_seq), old.id, stateSeq ?? null);
        }
      }
      return { acceptedIds, flags, resyncRequired: stale.size > 0, staleIds: [...stale], duplicateIds };
    });
  }

  async listFlags(i: { eventId: string; gateZone?: string; cursor?: string; limit: number }): Promise<GateFlagPage> {
    const cursor = i.cursor ? parseCursor(i.cursor) : undefined;
    // 요청한 기기의 배치 구역과 티켓 구역이 같은 표시만. 사후 검토 표시(OVERRIDE_REVIEW)는 넣지 않는다(offline-gate §7.2, C1-16).
    // 구역을 모르는 단위 조립은 예전처럼 거르지 않는다(HTTP 경로는 배치가 없으면 409라 늘 구역이 있다)
    const zone = i.gateZone;
    const filter = zone === undefined ? sql`` : sql`and f.kind <> 'OVERRIDE_REVIEW' and t.gate_zone = ${zone}`;
    const rows = (
      cursor
        ? await this.database.db.execute(sql`
            select f.id, f.ticket_id, t.seat_id, t.seat_label, t.gate_zone, f.kind, f.awareness, f.status, f.created_at
            from gate_flag f left join ticket t on t.id = f.ticket_id
            where f.event_id = ${i.eventId} ${filter}
              and (f.created_at < ${new Date(cursor.atMs)} or (f.created_at = ${new Date(cursor.atMs)} and f.id < ${cursor.flagId}))
            order by f.created_at desc, f.id desc limit ${i.limit + 1}
          `)
        : await this.database.db.execute(sql`
            select f.id, f.ticket_id, t.seat_id, t.seat_label, t.gate_zone, f.kind, f.awareness, f.status, f.created_at
            from gate_flag f left join ticket t on t.id = f.ticket_id
            where f.event_id = ${i.eventId} ${filter}
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
          select f.id, f.ticket_id, t.seat_id, t.seat_label, t.gate_zone, f.kind, f.awareness, f.status, f.created_at
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
