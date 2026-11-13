// 입장용 기기 공개키 저장소(Drizzle, FR-012, offline-gate §2·§3). 등록·폐기와 scanner_change 기록을 한 트랜잭션에 넣는다.
// 티켓 행을 FOR UPDATE로 잠가 같은 티켓의 동시 등록이 유효 키 하나 규칙을 깨지 않게 한다.
import type { Database, DbTransaction } from '@peaket/platform';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { keyIdTextOf, publicKeyTextOf } from '../../domain/device-key.js';
import type { DeviceKeyRegistrationInput, DeviceKeyRegistrationResult, DeviceKeyStore } from '../../domain/ports.js';
import { deviceKey } from './schema.js';

export interface ScannerChangeWriter {
  append(tx: DbTransaction, eventId: string, kind: string, payload: Record<string, unknown>): Promise<number>;
}

interface TicketRow {
  id: string;
  event_id: string;
  account_id: string;
  payer_account_id: string;
  event_starts_at: Date | string | null;
}

const atMs = (v: Date | string | null): number | undefined => (v === null ? undefined : v instanceof Date ? v.getTime() : Date.parse(v));

export class DrizzleDeviceKeyStore implements DeviceKeyStore {
  constructor(private readonly o: { database: Database; changes?: ScannerChangeWriter }) {}

  async register(i: DeviceKeyRegistrationInput): Promise<DeviceKeyRegistrationResult> {
    return this.o.database.transaction(async (tx) => {
      const rows = (await tx.execute(sql`select id, event_id, account_id, payer_account_id, event_starts_at from ticket where id = ${i.ticketId} for update`)).rows as unknown as TicketRow[];
      const ticket = rows[0];
      if (!ticket) return { kind: 'NOT_FOUND' };
      if (ticket.account_id !== i.accountId) return { kind: 'NOT_HOLDER' };
      const startsAt = atMs(ticket.event_starts_at);
      const started = startsAt !== undefined && i.nowMs >= startsAt;
      // 입장 시작 뒤에는 소유권이 동결된다. 재인증이 있어도 REISSUE·TRANSFER는 안 되고 BOOTH만 된다.
      if (started && (i.reason === 'REISSUE' || i.reason === 'TRANSFER')) return { kind: 'ENTRY_STARTED' };
      if (started && i.reason === 'ISSUE' && !i.reauthVerified) return { kind: 'ENTRY_STARTED' };
      // TRANSFER는 양도로 보유자가 바뀐 뒤에만 쓴다. 결제자 그대로면 양도 수락 전이므로 거절한다.
      if (i.reason === 'TRANSFER' && ticket.account_id === ticket.payer_account_id) return { kind: 'TRANSFER_NOT_ALLOWED' };
      const activeRows = (await tx.execute(sql`select id from device_key where ticket_id = ${i.ticketId} and revoked_at is null limit 1`)).rows as { id: string }[];
      const hasActive = activeRows.length > 0;
      // 이미 키가 있으면 ISSUE도 첫 등록이 아니다. 재인증 없이는 바꾸지 못한다.
      if (i.reason === 'ISSUE' && hasActive && !i.reauthVerified) return { kind: 'REAUTH_REQUIRED' };
      if (i.reason === 'REISSUE' || (i.reason === 'ISSUE' && hasActive)) {
        // 첫 등록은 세지 않고, 그 뒤의 키 교체만 24시간 1회로 센다.
        const recent = (await tx.execute(sql`
          select count(*)::int as n from device_key
          where ticket_id = ${i.ticketId} and registered_at > ${new Date(i.nowMs - 24 * 60 * 60_000)}
            and id <> (select id from device_key where ticket_id = ${i.ticketId} order by registered_at asc, id asc limit 1)
        `)).rows as { n: number }[];
        if (Number(recent[0]?.n ?? 0) > 0) return { kind: 'REISSUE_LIMIT' };
      }
      const old = await this.revokeActiveInTx(tx, i.ticketId, i.nowMs);
      if (old) await this.o.changes?.append(tx, ticket.event_id, 'KEY_REVOKED', { v: 1, ticketId: i.ticketId, keyId: keyIdTextOf(old) });
      await tx.insert(deviceKey).values({
        id: randomUUID(),
        ticketId: i.ticketId,
        keyId: Buffer.from(i.keyId),
        publicKey: Buffer.from(i.publicKey),
        reason: i.reason,
        registeredAt: new Date(i.nowMs),
      });
      await this.o.changes?.append(tx, ticket.event_id, 'KEY_REGISTERED', { v: 1, ticketId: i.ticketId, keyId: keyIdTextOf(i.keyId) });
      return { kind: 'REGISTERED', keyId: keyIdTextOf(i.keyId), ...(old ? { revokedKeyId: keyIdTextOf(old) } : {}) };
    });
  }

  /** 취소 트랜잭션 안에서 그 티켓의 유효 키를 폐기하고 keyId를 돌려준다 */
  async revokeActiveInTx(tx: DbTransaction, ticketId: string, nowMs: number): Promise<Uint8Array | undefined> {
    const [old] = await tx
      .update(deviceKey)
      .set({ revokedAt: new Date(nowMs) })
      .where(and(eq(deviceKey.ticketId, ticketId), isNull(deviceKey.revokedAt)))
      .returning({ keyId: deviceKey.keyId });
    return old ? new Uint8Array(old.keyId) : undefined;
  }

  async activeKeysByEvent(eventId: string): Promise<Map<string, { keyId: string; publicKey: string }[]>> {
    const rows = (await this.o.database.db.execute(sql`
      select dk.ticket_id, dk.key_id, dk.public_key
      from device_key dk join ticket t on t.id = dk.ticket_id
      where t.event_id = ${eventId} and dk.revoked_at is null
      order by dk.ticket_id, dk.registered_at
    `)).rows as { ticket_id: string; key_id: Buffer; public_key: Buffer }[];
    const out = new Map<string, { keyId: string; publicKey: string }[]>();
    for (const r of rows) {
      const list = out.get(r.ticket_id) ?? [];
      list.push({ keyId: keyIdTextOf(new Uint8Array(r.key_id)), publicKey: publicKeyTextOf(new Uint8Array(r.public_key)) });
      out.set(r.ticket_id, list);
    }
    return out;
  }

  async revokedKeyIdsByEvent(eventId: string): Promise<string[]> {
    const rows = (await this.o.database.db.execute(sql`
      select distinct dk.key_id
      from device_key dk join ticket t on t.id = dk.ticket_id
      where t.event_id = ${eventId} and dk.revoked_at is not null
    `)).rows as { key_id: Buffer }[];
    return rows.map((r) => keyIdTextOf(new Uint8Array(r.key_id)));
  }

  async keyState(ticketId: string, keyId: Uint8Array): Promise<'ACTIVE' | 'REVOKED' | 'UNKNOWN'> {
    const rows = (await this.o.database.db.execute(sql`
      select count(*) filter (where revoked_at is null)::int as active,
             count(*) filter (where revoked_at is not null)::int as revoked
      from device_key where ticket_id = ${ticketId} and key_id = ${Buffer.from(keyId)}
    `)).rows as { active: number; revoked: number }[];
    const r = rows[0];
    if (Number(r?.active ?? 0) > 0) return 'ACTIVE';
    if (Number(r?.revoked ?? 0) > 0) return 'REVOKED';
    return 'UNKNOWN';
  }
}
