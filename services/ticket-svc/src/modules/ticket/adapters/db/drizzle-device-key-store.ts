// 입장용 기기 공개키 저장소(Drizzle, FR-012, offline-gate §2·§3). 등록·폐기와 scanner_change 기록을 한 트랜잭션에 넣는다.
// 티켓 행을 FOR UPDATE로 잠가 같은 티켓의 동시 등록이 유효 키 하나 규칙을 깨지 않게 한다.
// 같은 키 다시 등록(지금 유효 키와 keyId가 같음)은 그 잠금 안에서 아무것도 바꾸지 않고 받는다(offline-gate §2, ADR-0336 결정 4).
// 403 세 이름과 입장 시작 뒤 교체 막기(ADR-0363 결정 2), 성공한 교체·입장 시작 뒤 첫 등록의 알림 행(결정 4)은 MemoryDeviceKeyStore와 같은 규칙이다.
import type { Database, DbTransaction } from '@peaket/platform';
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { keyIdTextOf, publicKeyTextOf } from '../../domain/device-key.js';
import {
  deviceKeyNoticeTypeOf,
  type DeviceKeyNotice,
  type DeviceKeyNoticeStore,
  type DeviceKeyNoticeType,
  type DeviceKeyRegistrationInput,
  type DeviceKeyRegistrationResult,
  type DeviceKeyStore,
} from '../../domain/ports.js';
import { deviceKey, deviceKeyNotice, ticketReturn } from './schema.js';

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

export class DrizzleDeviceKeyStore implements DeviceKeyStore, DeviceKeyNoticeStore {
  constructor(private readonly o: { database: Database; changes?: ScannerChangeWriter }) {}

  async register(i: DeviceKeyRegistrationInput): Promise<DeviceKeyRegistrationResult> {
    return this.o.database.transaction(async (tx) => {
      // 재인증 없는 REISSUE는 보유자 확인보다 403이 먼저다(offline-gate §2, RV350-1). 이름은 reissue-required(ADR-0363 결정 2)
      const reissueUnverified = i.reason === 'REISSUE' && !i.reauthVerified;
      const rows = (await tx.execute(sql`select id, event_id, account_id, payer_account_id, event_starts_at from ticket where id = ${i.ticketId} for update`)).rows as unknown as TicketRow[];
      const ticket = rows[0];
      if (!ticket) return reissueUnverified ? { kind: 'REISSUE_REQUIRED' } : { kind: 'NOT_FOUND' };
      if (ticket.account_id !== i.accountId) return reissueUnverified ? { kind: 'REISSUE_REQUIRED' } : { kind: 'NOT_HOLDER' };
      const activeRows = (await tx.execute(sql`select key_id from device_key where ticket_id = ${i.ticketId} and revoked_at is null limit 1`)).rows as { key_id: Buffer }[];
      const activeKeyId = activeRows[0] ? new Uint8Array(activeRows[0].key_id) : undefined;
      // 같은 키 다시 등록(offline-gate §2, ADR-0336 결정 4): 티켓 행 잠금 안에서, 보유자 확인 바로 뒤·입장 시작·TRANSFER·재인증 확인보다 앞에서 본다.
      // 지금 유효 키와 keyId가 같으면 새 행·폐기·scanner_change·24시간 셈·알림 행 없이 같은 keyId로 답한다. 겹친 두 요청은 잠금으로 차례가 되어
      // 먼저 온 쪽이 등록하고 뒤엣것은 여기서 바꾸지 않고 받는다. 재인증 없는 REISSUE는 같은 키여도 여기를 지나지 않는다
      if (!reissueUnverified && activeKeyId && Buffer.from(activeKeyId).equals(Buffer.from(i.keyId))) return { kind: 'REGISTERED', keyId: keyIdTextOf(activeKeyId), unchanged: true };
      const startsAt = atMs(ticket.event_starts_at);
      const started = startsAt !== undefined && i.nowMs >= startsAt;
      const hasActive = activeKeyId !== undefined;
      // 입장 시작 뒤에는 소유권이 동결된다(ADR-0363 결정 2): 다른 키가 유효하면 재인증·이유와 상관없이 부스로 보낸다(키는 그대로).
      // TRANSFER와 유효 키 없는 REISSUE는 지금처럼 거절, 유효 키 없는 첫 ISSUE만 재인증으로 받는다
      if (started) {
        if (i.reason === 'TRANSFER') return { kind: 'ENTRY_STARTED' };
        if (hasActive) return { kind: 'REISSUE_AT_BOOTH' };
        if (i.reason === 'REISSUE') return { kind: 'ENTRY_STARTED' };
        if (!i.reauthVerified) return { kind: 'ENTRY_STARTED' };
      }
      // TRANSFER는 양도로 보유자가 바뀐 뒤에 쓴다. 결제자 그대로면 양도 수락 전이므로 거절하되,
      // 돌려주기로 결제자에게 돌아온 표는 정본(offline-gate §4 '돌려주기')대로 reason=TRANSFER로 다시 등록한다(시험 리뷰 RV-01).
      if (i.reason === 'TRANSFER' && ticket.account_id === ticket.payer_account_id) {
        // 돌려주기 기록의 account_id는 돌려준 사람(받았던 사람)이다. 이 표가 결제자에게 돌아온 적이 있는지만 본다
        const returned = (await tx.select({ ticketId: ticketReturn.ticketId }).from(ticketReturn).where(eq(ticketReturn.ticketId, i.ticketId)).limit(1)).length > 0;
        if (!returned) return { kind: 'TRANSFER_NOT_ALLOWED' };
      }
      // 입장 시작 전 재발급: 재인증 없는 REISSUE와, 이미 키가 있는 ISSUE(첫 등록이 아니다)는 재인증 뒤 다시 받는다
      if (reissueUnverified || (i.reason === 'ISSUE' && hasActive && !i.reauthVerified)) return { kind: 'REISSUE_REQUIRED' };
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
      const deviceKeyId = randomUUID();
      await tx.insert(deviceKey).values({
        id: deviceKeyId,
        ticketId: i.ticketId,
        keyId: Buffer.from(i.keyId),
        publicKey: Buffer.from(i.publicKey),
        accountId: i.accountId,
        reason: i.reason,
        registeredAt: new Date(i.nowMs),
      });
      await this.o.changes?.append(tx, ticket.event_id, 'KEY_REGISTERED', {
        v: 1,
        ticketId: i.ticketId,
        keyId: keyIdTextOf(i.keyId),
        publicKey: publicKeyTextOf(i.publicKey),
      });
      // 입장 키 알림 행(ADR-0363 결정 4): 같은 트랜잭션에 한 행. 보내기 반복(application/device-key-notices.ts)이 core-svc로 보낸다
      const type = deviceKeyNoticeTypeOf({ reason: i.reason, hadActive: old !== undefined, started });
      const noticeId = type ? (i.noticeId ?? randomUUID()) : undefined;
      if (type && noticeId) {
        const at = new Date(i.nowMs);
        await tx.insert(deviceKeyNotice).values({ id: noticeId, deviceKeyId, ticketId: i.ticketId, accountId: i.accountId, type, createdAt: at, attempts: 0, nextAttemptAt: at });
      }
      return {
        kind: 'REGISTERED',
        keyId: keyIdTextOf(i.keyId),
        ...(old ? { revokedKeyId: keyIdTextOf(old) } : {}),
        ...(noticeId ? { noticeId } : {}),
      };
    });
  }

  // --- 입장 키 알림 보낼 표(DeviceKeyNoticeStore, docs/data.md device_key_notice, ADR-0363 결정 4) ---

  async claimDue(nowMs: number, limit: number, leaseMs: number): Promise<readonly DeviceKeyNotice[]> {
    // 보낼 때가 된 행을 SKIP LOCKED로 골라 다음 보낼 때를 임대 끝으로 밀어 둔다. 보내기는 트랜잭션 밖에서 하고, 결과로 markSent·reschedule한다.
    // 그 사이 파드가 죽으면 임대가 끝난 뒤 다른 파드가 다시 집는다(core-svc가 noticeId로 한 번만 적는다)
    const rows = (await this.o.database.db.execute(sql`
      with due as (
        select n.id from device_key_notice n
        where n.sent_at is null and n.next_attempt_at <= ${new Date(nowMs)}
        order by n.next_attempt_at, n.created_at
        limit ${limit}
        for update skip locked
      )
      update device_key_notice n
      set attempts = n.attempts + 1, next_attempt_at = ${new Date(nowMs + leaseMs)}
      from due, device_key dk
      where n.id = due.id and dk.id = n.device_key_id
      returning n.id, n.type, n.account_id, n.ticket_id, n.attempts, dk.registered_at
    `)).rows as { id: string; type: DeviceKeyNoticeType; account_id: string; ticket_id: string; attempts: number; registered_at: Date | string }[];
    return rows.map((r) => ({ id: r.id, type: r.type, accountId: r.account_id, ticketId: r.ticket_id, attempts: Number(r.attempts), registeredAtMs: atMs(r.registered_at)! }));
  }

  async markSent(id: string, nowMs: number): Promise<void> {
    await this.o.database.db.update(deviceKeyNotice).set({ sentAt: new Date(nowMs) }).where(and(eq(deviceKeyNotice.id, id), isNull(deviceKeyNotice.sentAt)));
  }

  async reschedule(id: string, nextAttemptAtMs: number): Promise<void> {
    await this.o.database.db.update(deviceKeyNotice).set({ nextAttemptAt: new Date(nextAttemptAtMs) }).where(and(eq(deviceKeyNotice.id, id), isNull(deviceKeyNotice.sentAt)));
  }

  async backlog(): Promise<{ count: number; oldestCreatedAtMs?: number }> {
    const rows = (await this.o.database.db.execute(sql`select count(*)::int as n, min(created_at) as oldest from device_key_notice where sent_at is null`)).rows as { n: number; oldest: Date | string | null }[];
    const n = Number(rows[0]?.n ?? 0);
    const oldest = atMs(rows[0]?.oldest ?? null);
    return n > 0 && oldest !== undefined ? { count: n, oldestCreatedAtMs: oldest } : { count: n };
  }

  async purgeSent(beforeMs: number): Promise<number> {
    const rows = await this.o.database.db
      .delete(deviceKeyNotice)
      .where(and(isNotNull(deviceKeyNotice.sentAt), lt(deviceKeyNotice.sentAt, new Date(beforeMs))))
      .returning({ id: deviceKeyNotice.id });
    return rows.length;
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
