// 부스 재발급 응용(openapi createTicketBoothRequest·createScannerBoothAuthorization, F-05-12 O-T28).
// 토큰 확인은 identity gRPC(포트), 코드·허용·사용 표시는 BoothStore가 한 트랜잭션에서 지킨다.
import type { Clock } from '@peaket/platform';
import { type BoothAuthorizeOutcome, type BoothRequestOutcome, type GateStatusView, type OverridePassView, boothDayKey, boothHash, isBoothTicketId, newBoothCode, parseBoothCode, BOOTH_CODE_TTL_MS, BOOTH_PERMIT_TTL_MS } from '../domain/booth.js';
import type { BoothStore } from '../domain/ports.js';

export class BoothNotFound extends Error {
  constructor() {
    super('티켓을 찾을 수 없다');
    this.name = 'BoothNotFound';
  }
}
export class BoothBeforeEntry extends Error {
  constructor() {
    super('입장 시작 전에는 온라인으로 다시 받아야 한다');
    this.name = 'BoothBeforeEntry';
  }
}
export class BoothMismatch extends Error {
  constructor() {
    super('본인확인 결과가 이 티켓의 계정과 다르다');
    this.name = 'BoothMismatch';
  }
}
export class BoothLimit extends Error {
  constructor() {
    super('오늘은 부스 재발급을 더 요청할 수 없다');
    this.name = 'BoothLimit';
  }
}
export class BoothCodeExpired extends Error {
  constructor() {
    super('부스 코드가 만료되었거나 이미 사용되었다');
    this.name = 'BoothCodeExpired';
  }
}

export interface BoothReverificationVerifier {
  verify(i: { token: string; accountId: string; ticketId: string }): Promise<boolean>;
}

export interface TicketBoothDeps {
  store: BoothStore;
  verifications: BoothReverificationVerifier;
  clock: Clock;
  /** 지표(ticket_booth_requests_total{result}). 없으면 세지 않는다 */
  onRequest?: (result: 'created' | 'before_entry' | 'mismatch' | 'limit' | 'not_found') => void;
  onAuthorize?: (result: 'authorized' | 'not_found' | 'expired' | 'event_mismatch') => void;
  onRegister?: (result: 'registered' | 'not_authorized' | 'expired' | 'reused') => void;
}

export class TicketBooth {
  constructor(private readonly d: TicketBoothDeps) {}

  /** 201 {boothRequestId, boothCode, expiresAt}. 코드·토큰 원문은 응답에만 싣는다 */
  async request(i: { ticketIdRaw: string; accountId: string; body: unknown }): Promise<{ boothRequestId: string; boothCode: string; expiresAt: string }> {
    if (!isBoothTicketId(i.ticketIdRaw)) throw new BoothNotFound();
    const ticketId = i.ticketIdRaw.toLowerCase();
    const owner = await this.d.store.ownerOf(ticketId);
    if (owner === undefined || owner !== i.accountId) {
      this.d.onRequest?.('not_found');
      throw new BoothNotFound();
    }
    const body = (typeof i.body === 'object' && i.body !== null ? i.body : {}) as Record<string, unknown>;
    const token = body.reverificationToken;
    if (typeof token !== 'string' || token.length === 0 || token.length > 200) throw new BoothMismatch();
    if (!(await this.d.verifications.verify({ token, accountId: i.accountId, ticketId }))) {
      this.d.onRequest?.('mismatch');
      throw new BoothMismatch();
    }
    const now = this.d.clock.now();
    const code = newBoothCode();
    const out: BoothRequestOutcome = await this.d.store.createRequest({
      ticketId,
      accountId: i.accountId,
      codeHash: boothHash(code),
      nowMs: now,
      dayKey: boothDayKey(now),
      expiresAtMs: now + BOOTH_CODE_TTL_MS,
    });
    this.d.onRequest?.(out.kind);
    if (out.kind === 'not_found') throw new BoothNotFound();
    if (out.kind === 'before_entry') throw new BoothBeforeEntry();
    if (out.kind === 'mismatch') throw new BoothMismatch();
    if (out.kind === 'limit') throw new BoothLimit();
    return { boothRequestId: out.boothRequestId, boothCode: code, expiresAt: new Date(out.expiresAtMs).toISOString() };
  }

  /** 200 {ticketId, seatLabel, allowUntil}. 모르는·만료·사용된 코드는 410 */
  async authorize(i: { eventId: string; deviceId: string; body: unknown }): Promise<{ ticketId: string; seatLabel: string; allowUntil: string }> {
    const body = (typeof i.body === 'object' && i.body !== null ? i.body : {}) as Record<string, unknown>;
    const code = parseBoothCode(body.boothCode);
    const now = this.d.clock.now();
    const out: BoothAuthorizeOutcome = await this.d.store.authorize({
      eventId: i.eventId,
      deviceId: i.deviceId,
      codeHash: boothHash(code),
      nowMs: now,
      allowUntilMs: now + BOOTH_PERMIT_TTL_MS,
    });
    this.d.onAuthorize?.(out.kind);
    if (out.kind === 'not_found' || out.kind === 'expired') throw new BoothCodeExpired();
    // 다른 회차는 컨트롤러가 세션 회차로 먼저 막는다. 저장소가 알려 주면 403이다
    if (out.kind === 'event_mismatch') throw new BoothMismatch();
    return { ticketId: out.ticketId, seatLabel: out.seatLabel, allowUntil: new Date(out.allowUntilMs).toISOString() };
  }

  async overridePasses(i: { eventId: string; staffAccountId: string; deviceId: string; limit?: number }): Promise<{ items: OverridePassView[] }> {
    const limit = i.limit ?? 50;
    return { items: await this.d.store.overridePasses({ eventId: i.eventId, staffAccountId: i.staffAccountId, deviceId: i.deviceId, limit }) };
  }

  gateStatus(i: { eventId: string; deviceId: string }): Promise<GateStatusView> {
    return this.d.store.gateStatus(i);
  }
}
