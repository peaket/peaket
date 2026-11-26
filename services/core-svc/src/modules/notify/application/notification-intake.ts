// BAT-455 GAT-250 원장 입구: 무역 사건·로그인 수단 변경(I-T34)·계정 병합(POL-034)·직접 낱건.
// 사건을 받은 트랜잭션에서 중복 키를 먼저 넣고, 들어갔을 때만 작업을 적는다(ADR-0109).
import type { Clock } from '@peaket/platform';
import {
  assertVars,
  FAN_NOTICE_KINDS,
  FanNotifyProblem,
  isSubscriptionNotice,
  newId,
  TICKET_KEY_NOTICE_KINDS,
  ticketKeyNoticeDedupKey,
  type FanNoticeKind,
  type NotificationChannel,
  type TicketKeyNoticeKind,
  type Vars,
} from '../domain/fan-notify.js';
import type { BookingNoticeReader, BookingNoticeView, FanNotifyStore, NoticeCatalogView, NotifyHeldEvents, NotifySignals } from '../domain/fan-notify-ports.js';
import type { NotificationJob } from '../domain/fan-notify-records.js';
import { BOOKING_CONFIRMED_TEMPLATE_VERSION } from '../templates/booking-confirmed/index.js';

const DAY = 24 * 60 * 60 * 1000;

export interface NotificationIntakeDeps {
  readonly store: FanNotifyStore;
  readonly clock: Clock;
  /** 수신 거부 토큰 키. 워커와 같은 값을 쓴다 */
  readonly optOutKey: string;
  /** F-06-8 예매 확정 알림의 purchase-svc notice-view */
  readonly noticeReader?: BookingNoticeReader;
  /** F-06-8 예매 확정 알림의 catalog(공연명·장소·시각·등급 이름) */
  readonly catalog?: NoticeCatalogView;
  /** F-06-8 반복 실패 사건 보류 표 */
  readonly heldEvents?: NotifyHeldEvents;
  readonly signals?: NotifySignals;
}

export interface TradeNoticeEvent {
  type: 'EVENT_CANCELLATION_CONFIRMED' | 'EVENT_POSTPONED' | 'REFUNDED' | 'REFUND_FAILED';
  orderId: string;
  eventId: string;
  accountId: string;
  occurredAtMs?: number;
  fanNoticeReason?: string;
  refundAmount?: number;
  postponedTo?: string;
  refundWindowClosesAt?: string;
}

export interface LoginMethodChangedInput {
  eventKey: string;
  accountId: string;
  change: 'LINKED' | 'UNLINKED';
  provider: string;
  occurredAtMs?: number;
}

export interface AccountMergedInput {
  eventKey: string;
  primaryAccountId: string;
  mergedAccountId: string;
  occurredAtMs?: number;
}

/** ticket-svc device_key_notice 보내기 반복이 보내는 입장 키 알림 사건(docs/features/notify.md §4.7, ADR-0363 결정 4) */
export interface TicketKeyNoticeEvent {
  noticeId: string;
  type: TicketKeyNoticeKind;
  accountId: string;
  ticketId: string;
  registeredAtMs: number;
}

export interface NoticeInput {
  kind: FanNoticeKind;
  targetId: string;
  accountId: string;
  channel: NotificationChannel;
  vars?: Vars;
  expiresAt?: Date;
}

/** F-06-8 `trade.orders` CONFIRMED 사건. type이 CONFIRMED가 아니면 intake가 먼저 억제한다 */
export interface BookingConfirmedEvent {
  type: string;
  eventKey: string;
  orderId: string;
  eventId: string;
  accountId: string;
  occurredAtMs: number;
  amount: number;
  items: readonly { tierId: string; seatLabel?: string }[];
}

export interface BookingIntakeResult {
  created: number;
  duplicate: number;
  suppressed?: 'not_confirmed' | 'not_allowed';
  held?: boolean;
}

const BOOKING_NOTICE_READ_ATTEMPTS = 3;
const BOOKING_NO = /^[0-9]{8}(?!00000)[0-9]{5}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export class NotificationIntake {
  readonly #held = new Set<string>();

  constructor(private readonly d: NotificationIntakeDeps) {}

  /**
   * F-06-8 예매 확정 알림(notify §4.8·§4.9). CONFIRMED만 소비하고, noticeAllowed=false면 작업을 만들지 않는다.
   * vars는 일곱 키뿐이고 phoneE164·판매자·이름·전화번호·좌석 번호·예매번호 전체를 넣지 않는다.
   */
  async bookingConfirmed(e: BookingConfirmedEvent): Promise<BookingIntakeResult> {
    if (e.type !== 'CONFIRMED') {
      this.d.signals?.suppressed('not_confirmed');
      return { created: 0, duplicate: 0, suppressed: 'not_confirmed' };
    }
    if (!isUuid(e.orderId) || !isUuid(e.eventId) || !isUuid(e.accountId) || !e.eventKey) throw new FanNotifyProblem('INVALID', '예매 확정 사건 모양이 올바르지 않습니다');
    if (await this.#isHeld(e.eventKey)) return { created: 0, duplicate: 0, held: true };

    const notice = await this.#readNotice(e);
    if (notice === 'HELD') return { created: 0, duplicate: 0, held: true };
    if (!notice || !notice.noticeAllowed) {
      this.d.signals?.suppressed('not_allowed');
      return { created: 0, duplicate: 0, suppressed: 'not_allowed' };
    }
    if (!notice.bookingNo || !BOOKING_NO.test(notice.bookingNo)) {
      this.d.signals?.bookingNoInvalid();
      return { created: 0, duplicate: 0 };
    }

    const tierIds = [...new Set(e.items.map((i) => i.tierId))].sort();
    const catalog = await this.#readCatalog(e, tierIds);
    if (catalog === 'HELD') return { created: 0, duplicate: 0, held: true };
    if (!catalog) return { created: 0, duplicate: 0 };

    const counts = new Map<string, number>();
    for (const item of e.items) counts.set(item.tierId, (counts.get(item.tierId) ?? 0) + 1);
    const names = tierIds.map((id) => catalog.tierNames[id]);
    let seatSummary: string;
    if (names.every((n) => typeof n === 'string' && n.length > 0)) {
      seatSummary = tierIds.map((id) => `${catalog.tierNames[id]!} ${counts.get(id) ?? 0}매`).join(', ');
    } else {
      seatSummary = `좌석 ${e.items.length}매`;
      this.d.signals?.tierNameMissing();
    }
    const vars = assertVars('BOOKING_CONFIRMED', {
      productionName: catalog.productionName,
      eventStartsAt: catalog.eventStartsAt,
      venueName: catalog.venueName,
      seatSummary,
      amount: e.amount,
      bookingNoLast4: notice.bookingNo.slice(-4),
      orderId: e.orderId,
    });

    const out: BookingIntakeResult = { created: 0, duplicate: 0 };
    const base = {
      kind: 'BOOKING_CONFIRMED' as const,
      targetId: e.orderId,
      accountId: e.accountId,
      vars,
      templateVersion: BOOKING_CONFIRMED_TEMPLATE_VERSION,
      expiresAt: new Date(e.occurredAtMs + DAY_MS),
    };
    const email = await this.enqueue({ ...base, channel: 'EMAIL', dedupKey: `BOOKING_CONFIRMED:${e.orderId}:CONFIRMED:${e.accountId}:EMAIL` });
    out[email] += 1;
    for (const sub of await this.d.store.listPushSubscriptions(e.accountId)) {
      const r = await this.enqueue({
        ...base,
        channel: 'WEB_PUSH',
        dedupKey: `BOOKING_CONFIRMED:${e.orderId}:CONFIRMED:${e.accountId}:WEB_PUSH:${sub.endpointHash}`,
      });
      out[r] += 1;
    }
    return out;
  }

  async tradeEvent(e: TradeNoticeEvent): Promise<'created' | 'duplicate'> {
    if (!isUuid(e.orderId) || !isUuid(e.eventId) || !isUuid(e.accountId)) throw new FanNotifyProblem('INVALID', 'ID 모양이 올바르지 않습니다');
    if (!['EVENT_CANCELLATION_CONFIRMED', 'EVENT_POSTPONED', 'REFUNDED', 'REFUND_FAILED'].includes(e.type)) throw new FanNotifyProblem('INVALID', '알 수 없는 알림 종류입니다');
    const vars = this.tradeVars(e);
    return this.enqueue({
      kind: e.type,
      targetId: e.orderId,
      accountId: e.accountId,
      channel: 'EMAIL',
      vars,
      dedupKey: `${e.type}:${e.orderId}:${e.accountId}:EMAIL`,
    });
  }

  async loginMethodChanged(i: LoginMethodChangedInput): Promise<{ created: number; duplicate: number }> {
    if (!isUuid(i.accountId) || !i.eventKey || !['LINKED', 'UNLINKED'].includes(i.change)) throw new FanNotifyProblem('INVALID', '로그인 수단 사건 모양이 올바르지 않습니다');
    const kind: FanNoticeKind = i.change === 'LINKED' ? 'LOGIN_METHOD_LINKED' : 'LOGIN_METHOD_UNLINKED';
    const vars = assertVars(kind, { provider: i.provider });
    const out = { created: 0, duplicate: 0 };
    for (const channel of ['EMAIL', 'WEB_PUSH'] as const) {
      const r = await this.enqueue({ kind, targetId: i.eventKey, accountId: i.accountId, channel, vars, dedupKey: `${kind}:${i.eventKey}:${i.accountId}:${channel}` });
      out[r] += 1;
    }
    return out;
  }

  async accountMerged(i: AccountMergedInput): Promise<{ created: number; duplicate: number; subscriptionsMoved: number; pushMoved: number }> {
    if (!isUuid(i.primaryAccountId) || !isUuid(i.mergedAccountId) || i.primaryAccountId === i.mergedAccountId) throw new FanNotifyProblem('INVALID', '병합 사건 모양이 올바르지 않습니다');
    const now = new Date(this.d.clock.now());
    const sub = await this.d.store.mergeSubscriptions(i.primaryAccountId, i.mergedAccountId, now);
    const push = await this.d.store.mergePushSubscriptions(i.primaryAccountId, i.mergedAccountId, now);
    const out = { created: 0, duplicate: 0, subscriptionsMoved: sub.moved + sub.deduped, pushMoved: push.moved + push.deduped };
    for (const channel of ['EMAIL', 'WEB_PUSH'] as const) {
      const r = await this.enqueue({ kind: 'ACCOUNT_MERGED', targetId: i.eventKey, accountId: i.primaryAccountId, channel, vars: {}, dedupKey: `ACCOUNT_MERGED:${i.eventKey}:${i.primaryAccountId}:${channel}` });
      out[r] += 1;
    }
    return out;
  }

  /**
   * 입장 키 알림(notify §4.7): 이메일 하나와 그 계정의 살아 있는 웹 푸시 구독마다 하나. 중복 키에 noticeId가 들어가 같은 사건이 다시 와도 작업은 하나다.
   * 변수는 type·registeredAt·ticketId 셋이고 공개키·keyId·이메일 주소는 싣지 않는다. 밤에도 보낸다(거래·안전 알림, §7.2)
   */
  async ticketKeyNotice(e: TicketKeyNoticeEvent): Promise<{ created: number; duplicate: number }> {
    if (!isUuid(e.noticeId) || !isUuid(e.accountId) || !isUuid(e.ticketId)) throw new FanNotifyProblem('INVALID', 'ID 모양이 올바르지 않습니다');
    if (!TICKET_KEY_NOTICE_KINDS.includes(e.type)) throw new FanNotifyProblem('INVALID', '알 수 없는 입장 키 알림 종류입니다');
    if (!Number.isSafeInteger(e.registeredAtMs) || e.registeredAtMs < 0) throw new FanNotifyProblem('INVALID', '등록 시각이 올바르지 않습니다');
    const vars = assertVars(e.type, { type: e.type, registeredAt: new Date(e.registeredAtMs).toISOString(), ticketId: e.ticketId });
    const out = { created: 0, duplicate: 0 };
    const key = { type: e.type, ticketId: e.ticketId, noticeId: e.noticeId, accountId: e.accountId };
    const email = await this.enqueue({ kind: e.type, targetId: e.ticketId, accountId: e.accountId, channel: 'EMAIL', vars, dedupKey: ticketKeyNoticeDedupKey({ ...key, channel: 'EMAIL' }) });
    out[email] += 1;
    for (const sub of await this.d.store.listPushSubscriptions(e.accountId)) {
      const r = await this.enqueue({
        kind: e.type,
        targetId: e.ticketId,
        accountId: e.accountId,
        channel: 'WEB_PUSH',
        vars,
        dedupKey: ticketKeyNoticeDedupKey({ ...key, channel: 'WEB_PUSH', subscriptionKey: sub.endpointHash }),
      });
      out[r] += 1;
    }
    return out;
  }

  async notice(i: NoticeInput): Promise<'created' | 'duplicate'> {
    if (!FAN_NOTICE_KINDS.includes(i.kind)) throw new FanNotifyProblem('INVALID', '알 수 없는 알림 종류입니다');
    if (!isUuid(i.accountId) || !i.targetId) throw new FanNotifyProblem('INVALID', '알림 대상이 올바르지 않습니다');
    if (!['EMAIL', 'WEB_PUSH', 'ALIMTALK', 'SMS'].includes(i.channel)) throw new FanNotifyProblem('INVALID', '알 수 없는 채널입니다');
    return this.enqueue({
      kind: i.kind,
      targetId: i.targetId,
      accountId: i.accountId,
      channel: i.channel,
      vars: i.vars ?? {},
      dedupKey: `${i.kind}:${i.targetId}:${i.accountId}:${i.channel}`,
      ...(i.expiresAt ? { expiresAt: i.expiresAt } : {}),
    });
  }

  async #isHeld(eventKey: string): Promise<boolean> {
    if (this.#held.has(eventKey)) return true;
    const found = this.d.heldEvents?.find ? await this.d.heldEvents.find(eventKey).catch(() => false) : false;
    if (found) this.#held.add(eventKey);
    return found === true;
  }

  async #readNotice(e: BookingConfirmedEvent): Promise<BookingNoticeView | 'HELD' | undefined> {
    if (!this.d.noticeReader) return undefined;
    for (let i = 1; i <= BOOKING_NOTICE_READ_ATTEMPTS; i += 1) {
      try {
        return await this.d.noticeReader.get(e.orderId);
      } catch {
        if (i === BOOKING_NOTICE_READ_ATTEMPTS) {
          await this.#hold(e);
          return 'HELD';
        }
      }
    }
    return undefined;
  }

  async #readCatalog(e: BookingConfirmedEvent, tierIds: readonly string[]): Promise<Awaited<ReturnType<NoticeCatalogView['getBookingNotice']>> | 'HELD' | undefined> {
    if (!this.d.catalog) return undefined;
    for (let i = 1; i <= BOOKING_NOTICE_READ_ATTEMPTS; i += 1) {
      try {
        return await this.d.catalog.getBookingNotice(e.eventId, tierIds);
      } catch {
        if (i === BOOKING_NOTICE_READ_ATTEMPTS) {
          await this.#hold(e);
          return 'HELD';
        }
      }
    }
    return undefined;
  }

  async #hold(e: BookingConfirmedEvent): Promise<void> {
    this.#held.add(e.eventKey);
    await this.d.heldEvents?.hold(
      { eventKey: e.eventKey, kind: 'BOOKING_CONFIRMED', payload: { eventKey: e.eventKey, orderId: e.orderId }, attempts: BOOKING_NOTICE_READ_ATTEMPTS },
      new Date(this.d.clock.now()),
    );
  }

  private tradeVars(e: TradeNoticeEvent): Vars {
    const raw: Vars = {};
    if (e.fanNoticeReason !== undefined) raw.fanNoticeReason = e.fanNoticeReason;
    if (e.refundAmount !== undefined) raw.refundAmount = e.refundAmount;
    if (e.postponedTo !== undefined) raw.postponedTo = e.postponedTo;
    if (e.refundWindowClosesAt !== undefined) raw.refundWindowClosesAt = e.refundWindowClosesAt;
    return assertVars(e.type, raw);
  }

  private async enqueue(o: { kind: FanNoticeKind; targetId: string; accountId: string; channel: NotificationChannel; vars: Vars; dedupKey: string; expiresAt?: Date; templateVersion?: string }): Promise<'created' | 'duplicate'> {
    const now = new Date(this.d.clock.now());
    const vars = assertVars(o.kind, o.vars);
    const job: NotificationJob = {
      dedupKey: o.dedupKey,
      kind: o.kind,
      targetId: o.targetId,
      accountId: o.accountId,
      channel: o.channel,
      vars,
      ...(o.templateVersion !== undefined ? { templateVersion: o.templateVersion } : {}),
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: now,
      leaseUntil: null,
      expiresAt: o.expiresAt ?? new Date(now.getTime() + DAY),
      createdAt: now,
    };
    if (isSubscriptionNotice(o.kind) && o.channel === 'EMAIL' && !vars.body && !vars.title) {
      // 신청 알림 문안은 부르는 쪽이 정한다. 비어 있으면 조용히 보내지 않는다
      throw new FanNotifyProblem('INVALID', '신청 알림에는 문안이 필요합니다');
    }
    const r = await this.d.store.enqueue(job, now);
    return r.created ? 'created' : 'duplicate';
  }
}

/** 웹 푸시만 쓰는 새 ID. 시험이 값 모양을 본다 */
export const newJobId = newId;
