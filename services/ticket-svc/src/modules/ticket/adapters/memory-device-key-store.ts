// 시험·로컬용 기기 공개키 저장소. DrizzleDeviceKeyStore와 같은 규칙(티켓당 유효 키 하나, 24시간 REISSUE 한도,
// 같은 키 다시 등록은 바꾸지 않고 받음, 403 세 이름(ADR-0363 결정 2), 성공한 교체·입장 시작 뒤 첫 등록의 알림 행(결정 4))을 메모리에서 지킨다.
import { randomUUID } from 'node:crypto';
import { keyIdTextOf, publicKeyTextOf } from '../domain/device-key.js';
import {
  deviceKeyNoticeTypeOf,
  type DeviceKeyNotice,
  type DeviceKeyNoticeStore,
  type DeviceKeyNoticeType,
  type DeviceKeyRegistrationInput,
  type DeviceKeyRegistrationResult,
  type DeviceKeyStore,
} from '../domain/ports.js';

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export interface MemoryDeviceKeyTicket {
  ticketId: string;
  eventId: string;
  accountId: string;
  payerAccountId?: string;
  eventStartsAtMs?: number;
}

interface StoredKey {
  keyId: Uint8Array;
  publicKey: Uint8Array;
  reason: string;
  registeredAtMs: number;
  revokedAtMs?: number;
}

interface StoredNotice {
  id: string;
  type: DeviceKeyNoticeType;
  accountId: string;
  ticketId: string;
  registeredAtMs: number;
  createdAtMs: number;
  attempts: number;
  nextAttemptAtMs: number;
  sentAtMs?: number;
}

export class MemoryDeviceKeyStore implements DeviceKeyStore, DeviceKeyNoticeStore {
  readonly tickets = new Map<string, MemoryDeviceKeyTicket>();
  readonly keys = new Map<string, StoredKey[]>();
  /** 입장 키 알림 행(device_key_notice). 시험이 행 수·종류를 본다 */
  readonly notices: StoredNotice[] = [];

  /** 변경 기록을 남길 곳(시험·로컬). 없으면 키만 바꾼다 */
  constructor(private readonly changes?: (eventId: string, kind: string, payload: Record<string, unknown>) => void) {}

  seedTicket(t: MemoryDeviceKeyTicket): void {
    this.tickets.set(t.ticketId, { ...t });
  }

  async register(i: DeviceKeyRegistrationInput): Promise<DeviceKeyRegistrationResult> {
    // 재인증 없는 REISSUE는 보유자 확인보다 403이 먼저다(offline-gate §2, RV350-1). 이름은 reissue-required(ADR-0363 결정 2)
    const reissueUnverified = i.reason === 'REISSUE' && !i.reauthVerified;
    const ticket = this.tickets.get(i.ticketId);
    if (!ticket) return reissueUnverified ? { kind: 'REISSUE_REQUIRED' } : { kind: 'NOT_FOUND' };
    if (ticket.accountId !== i.accountId) return reissueUnverified ? { kind: 'REISSUE_REQUIRED' } : { kind: 'NOT_HOLDER' };
    const list = this.keys.get(i.ticketId) ?? [];
    const active = list.find((k) => k.revokedAtMs === undefined);
    // 같은 키 다시 등록(offline-gate §2, ADR-0336 결정 4): 보유자 확인 바로 뒤, 입장 시작·TRANSFER·재인증 확인보다 앞에서 본다.
    // 지금 유효 키와 keyId가 같으면 아무것도 바꾸지 않고 같은 keyId로 답한다(새 키·폐기·24시간 셈·알림 행 없음). 입장 시작 뒤에도 같다.
    // 재인증 없는 REISSUE는 같은 키여도 여기를 지나지 않는다(그 확인을 못 지나면 같은 키여도 403)
    if (!reissueUnverified && active && sameBytes(active.keyId, i.keyId)) return { kind: 'REGISTERED', keyId: keyIdTextOf(active.keyId), unchanged: true };
    const started = ticket.eventStartsAtMs !== undefined && i.nowMs >= ticket.eventStartsAtMs;
    // 입장 시작 뒤에는 소유권이 동결된다(ADR-0363 결정 2): 다른 키가 유효하면 재인증·이유와 상관없이 부스로 보낸다(키는 그대로).
    // TRANSFER와 유효 키 없는 REISSUE는 지금처럼 거절, 유효 키 없는 첫 ISSUE만 재인증으로 받는다
    if (started) {
      if (i.reason === 'TRANSFER') return { kind: 'ENTRY_STARTED' };
      // BOOTH는 부스에서 옛 키를 바꾸는 정본 경로다(IR-03)
      if (active && i.reason !== 'BOOTH') return { kind: 'REISSUE_AT_BOOTH' };
      if (i.reason === 'REISSUE') return { kind: 'ENTRY_STARTED' };
      if (!i.reauthVerified) return { kind: 'ENTRY_STARTED' };
    }
    // TRANSFER는 양도로 보유자가 바뀐 뒤에만 쓴다. 결제자 그대로면 양도 수락 전이므로 거절한다.
    if (i.reason === 'TRANSFER' && ticket.accountId === (ticket.payerAccountId ?? ticket.accountId)) return { kind: 'TRANSFER_NOT_ALLOWED' };
    // 입장 시작 전 재발급: 재인증 없는 REISSUE와, 이미 키가 있는 ISSUE(첫 등록이 아니다)는 재인증 뒤 다시 받는다
    if (reissueUnverified || (i.reason === 'ISSUE' && active && !i.reauthVerified)) return { kind: 'REISSUE_REQUIRED' };
    if (i.reason === 'REISSUE' || (i.reason === 'ISSUE' && active)) {
      // 첫 등록은 세지 않고, 그 뒤의 키 교체만 24시간 1회로 센다.
      const first = list[0];
      const recentRotations = list.filter((k) => k !== first && k.registeredAtMs > i.nowMs - 24 * 60 * 60_000).length;
      if (recentRotations > 0) return { kind: 'REISSUE_LIMIT' };
    }
    if (active) active.revokedAtMs = i.nowMs;
    if (active) this.changes?.(ticket.eventId, 'KEY_REVOKED', { v: 1, ticketId: i.ticketId, keyId: keyIdTextOf(active.keyId) });
    list.push({ keyId: new Uint8Array(i.keyId), publicKey: new Uint8Array(i.publicKey), reason: i.reason, registeredAtMs: i.nowMs });
    this.keys.set(i.ticketId, list);
    this.changes?.(ticket.eventId, 'KEY_REGISTERED', { v: 1, ticketId: i.ticketId, keyId: keyIdTextOf(i.keyId), publicKey: publicKeyTextOf(i.publicKey) });
    // 입장 키 알림 행(ADR-0363 결정 4): 등록과 같은 자리에서 한 행
    const type = deviceKeyNoticeTypeOf({ reason: i.reason, hadActive: active !== undefined, started });
    const noticeId = type ? (i.noticeId ?? randomUUID()) : undefined;
    if (type && noticeId) {
      this.notices.push({ id: noticeId, type, accountId: i.accountId, ticketId: i.ticketId, registeredAtMs: i.nowMs, createdAtMs: i.nowMs, attempts: 0, nextAttemptAtMs: i.nowMs });
    }
    return {
      kind: 'REGISTERED',
      keyId: keyIdTextOf(i.keyId),
      ...(active ? { revokedKeyId: keyIdTextOf(active.keyId) } : {}),
      ...(noticeId ? { noticeId } : {}),
    };
  }

  // --- 입장 키 알림 보낼 표(DeviceKeyNoticeStore, DrizzleDeviceKeyStore와 같은 규칙) ---

  async claimDue(nowMs: number, limit: number, leaseMs: number): Promise<readonly DeviceKeyNotice[]> {
    const due = this.notices
      .filter((n) => n.sentAtMs === undefined && n.nextAttemptAtMs <= nowMs)
      .sort((a, b) => a.nextAttemptAtMs - b.nextAttemptAtMs || a.createdAtMs - b.createdAtMs)
      .slice(0, limit);
    return due.map((n) => {
      n.attempts += 1;
      n.nextAttemptAtMs = nowMs + leaseMs;
      return { id: n.id, type: n.type, accountId: n.accountId, ticketId: n.ticketId, registeredAtMs: n.registeredAtMs, attempts: n.attempts };
    });
  }

  async markSent(id: string, nowMs: number): Promise<void> {
    const n = this.notices.find((x) => x.id === id);
    if (n && n.sentAtMs === undefined) n.sentAtMs = nowMs;
  }

  async reschedule(id: string, nextAttemptAtMs: number): Promise<void> {
    const n = this.notices.find((x) => x.id === id);
    if (n && n.sentAtMs === undefined) n.nextAttemptAtMs = nextAttemptAtMs;
  }

  async backlog(): Promise<{ count: number; oldestCreatedAtMs?: number }> {
    const open = this.notices.filter((n) => n.sentAtMs === undefined);
    if (open.length === 0) return { count: 0 };
    return { count: open.length, oldestCreatedAtMs: Math.min(...open.map((n) => n.createdAtMs)) };
  }

  async purgeSent(beforeMs: number): Promise<number> {
    const before = this.notices.length;
    for (let k = this.notices.length - 1; k >= 0; k -= 1) {
      const n = this.notices[k]!;
      if (n.sentAtMs !== undefined && n.sentAtMs < beforeMs) this.notices.splice(k, 1);
    }
    return before - this.notices.length;
  }

  async activeKeysByEvent(eventId: string): Promise<Map<string, { keyId: string; publicKey: string }[]>> {
    const out = new Map<string, { keyId: string; publicKey: string }[]>();
    for (const [ticketId, list] of this.keys) {
      if (this.tickets.get(ticketId)?.eventId !== eventId) continue;
      const active = list.filter((k) => k.revokedAtMs === undefined).map((k) => ({ keyId: keyIdTextOf(k.keyId), publicKey: publicKeyTextOf(k.publicKey) }));
      if (active.length > 0) out.set(ticketId, active);
    }
    return out;
  }

  async revokedKeyIdsByEvent(eventId: string): Promise<string[]> {
    const out = new Set<string>();
    for (const [ticketId, list] of this.keys) {
      if (this.tickets.get(ticketId)?.eventId !== eventId) continue;
      for (const k of list) if (k.revokedAtMs !== undefined) out.add(keyIdTextOf(k.keyId));
    }
    return [...out];
  }

  async keyState(ticketId: string, keyId: Uint8Array): Promise<'ACTIVE' | 'REVOKED' | 'UNKNOWN'> {
    const list = this.keys.get(ticketId) ?? [];
    const match = list.filter((k) => k.keyId.length === keyId.length && k.keyId.every((v, i) => v === keyId[i]));
    if (match.some((k) => k.revokedAtMs === undefined)) return 'ACTIVE';
    if (match.length > 0) return 'REVOKED';
    return 'UNKNOWN';
  }
}
