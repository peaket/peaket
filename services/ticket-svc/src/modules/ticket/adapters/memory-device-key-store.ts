// 시험·로컬용 기기 공개키 저장소. DrizzleDeviceKeyStore와 같은 규칙(티켓당 유효 키 하나, 24시간 REISSUE 한도)을 메모리에서 지킨다.
import { keyIdTextOf, publicKeyTextOf } from '../domain/device-key.js';
import type { DeviceKeyRegistrationInput, DeviceKeyRegistrationResult, DeviceKeyStore } from '../domain/ports.js';

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

export class MemoryDeviceKeyStore implements DeviceKeyStore {
  readonly tickets = new Map<string, MemoryDeviceKeyTicket>();
  readonly keys = new Map<string, StoredKey[]>();

  seedTicket(t: MemoryDeviceKeyTicket): void {
    this.tickets.set(t.ticketId, { ...t });
  }

  async register(i: DeviceKeyRegistrationInput): Promise<DeviceKeyRegistrationResult> {
    const ticket = this.tickets.get(i.ticketId);
    if (!ticket) return { kind: 'NOT_FOUND' };
    if (ticket.accountId !== i.accountId) return { kind: 'NOT_HOLDER' };
    const started = ticket.eventStartsAtMs !== undefined && i.nowMs >= ticket.eventStartsAtMs;
    // 입장 시작 뒤에는 소유권이 동결된다. 재인증이 있어도 REISSUE·TRANSFER는 안 되고 BOOTH만 된다.
    if (started && (i.reason === 'REISSUE' || i.reason === 'TRANSFER')) return { kind: 'ENTRY_STARTED' };
    if (started && i.reason === 'ISSUE' && !i.reauthVerified) return { kind: 'ENTRY_STARTED' };
    // TRANSFER는 양도로 보유자가 바뀐 뒤에만 쓴다. 결제자 그대로면 양도 수락 전이므로 거절한다.
    if (i.reason === 'TRANSFER' && ticket.accountId === (ticket.payerAccountId ?? ticket.accountId)) return { kind: 'TRANSFER_NOT_ALLOWED' };
    const list = this.keys.get(i.ticketId) ?? [];
    const active = list.find((k) => k.revokedAtMs === undefined);
    // 이미 키가 있으면 ISSUE도 첫 등록이 아니다. 재인증 없이는 바꾸지 못한다.
    if (i.reason === 'ISSUE' && active && !i.reauthVerified) return { kind: 'REAUTH_REQUIRED' };
    if (i.reason === 'REISSUE' || (i.reason === 'ISSUE' && active)) {
      // 첫 등록은 세지 않고, 그 뒤의 키 교체만 24시간 1회로 센다.
      const first = list[0];
      const recentRotations = list.filter((k) => k !== first && k.registeredAtMs > i.nowMs - 24 * 60 * 60_000).length;
      if (recentRotations > 0) return { kind: 'REISSUE_LIMIT' };
    }
    if (active) active.revokedAtMs = i.nowMs;
    list.push({ keyId: new Uint8Array(i.keyId), publicKey: new Uint8Array(i.publicKey), reason: i.reason, registeredAtMs: i.nowMs });
    this.keys.set(i.ticketId, list);
    return { kind: 'REGISTERED', keyId: keyIdTextOf(i.keyId), ...(active ? { revokedKeyId: keyIdTextOf(active.keyId) } : {}) };
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
