// BAT-455 GAT-250 유스케이스: 신청 설정·웹 푸시 구독·한 번 누름 수신 거부(openapi §3).
import { newId, checkPushEndpoint, checkPushKeys, isPublicAddress, FanNotifyProblem, SUBSCRIPTION_LIMIT, PUSH_SUBSCRIPTION_LIMIT, subscriptionKeyOf, readOptOutToken, type SubscriptionKind } from '../domain/fan-notify.js';
import type { NotificationEventDirectory, PushLookup, RecipientDirectory, FanNotifyStore, SubscriptionPage, SubscriptionStateView } from '../domain/fan-notify-ports.js';
import type { NotificationSubscription, PushSubscriptionRecord } from '../domain/fan-notify-records.js';
import type { Clock } from '@peaket/platform';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 24 * 60 * 60 * 1000;
const LIMIT_DEFAULT = 20;

export interface FanSubscriptionsDeps {
  readonly store: FanNotifyStore;
  readonly events: NotificationEventDirectory;
  readonly clock: Clock;
}

const stateOf = (eventId: string, rows: readonly NotificationSubscription[]): SubscriptionStateView => {
  const open = rows.find((r) => r.kind === 'OPEN');
  const cancel = rows.find((r) => r.kind === 'CANCELLATION');
  return {
    eventId,
    open: open !== undefined,
    cancellation: cancel !== undefined,
    nightPush: (open ?? cancel)?.nightPush ?? false,
    cancellationStatus: cancel?.status ?? null,
    endReason: cancel?.endReason ?? null,
    sentCount: cancel?.sentCount ?? 0,
  };
};

export class FanSubscriptions {
  constructor(private readonly d: FanSubscriptionsDeps) {}

  async create(accountId: string, eventId: string, input: { kind: SubscriptionKind; nightPush?: boolean }): Promise<{ created: boolean; state: SubscriptionStateView }> {
    const id = eventId.toLowerCase();
    if (!UUID.test(id)) throw new FanNotifyProblem('NOT_FOUND', '회차를 찾을 수 없습니다');
    const ev = await this.d.events.find(id);
    if (!ev || ev.saleReview === 'DRAFT' || ev.saleReview === 'SUSPENDED' || ev.saleApprovedAt === null) throw new FanNotifyProblem('NOT_FOUND', '회차를 찾을 수 없습니다');
    const now = new Date(this.d.clock.now());
    if (input.kind === 'OPEN' && now.getTime() >= ev.openAt.getTime()) throw new FanNotifyProblem('OPEN_PASSED', '오픈 시각이 지났습니다');
    if (input.kind === 'CANCELLATION' && now.getTime() >= ev.startsAt.getTime() - DAY) throw new FanNotifyProblem('SALE_ENDED', '판매가 끝났습니다');

    const nightPush = input.nightPush ?? false;
    const existing = await this.d.store.findSubscription(accountId, id, input.kind);
    if (existing) {
      const ended = existing.status === 'ENDED';
      if (ended && existing.endReason === 'SALE_ENDED') throw new FanNotifyProblem('SALE_ENDED', '판매가 끝났습니다');
      const next: NotificationSubscription = ended
        ? { ...existing, status: 'ACTIVE', endReason: null, sentCount: 0, nightPush, updatedAt: now }
        : { ...existing, nightPush, updatedAt: now };
      await this.d.store.saveSubscription(next);
      // 한 회차의 밤 설정은 하나로 본다: 같은 회차의 다른 종류 행도 같은 값을 쓴다
      const other = await this.d.store.findSubscription(accountId, id, input.kind === 'OPEN' ? 'CANCELLATION' : 'OPEN');
      if (other && other.nightPush !== nightPush) await this.d.store.saveSubscription({ ...other, nightPush, updatedAt: now });
      return { created: false, state: stateOf(id, [next, ...(other ? [{ ...other, nightPush }] : [])]) };
    }

    if ((await this.d.store.countActiveSubscriptions(accountId)) >= SUBSCRIPTION_LIMIT) throw new FanNotifyProblem('SUBSCRIPTION_LIMIT', `살아 있는 알림 신청은 ${SUBSCRIPTION_LIMIT}건까지입니다`);
    const row: NotificationSubscription = {
      id: newId(),
      accountId,
      eventId: id,
      kind: input.kind,
      nightPush,
      sentCount: 0,
      status: 'ACTIVE',
      endReason: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.d.store.insertSubscription(row);
    const other = await this.d.store.findSubscription(accountId, id, input.kind === 'OPEN' ? 'CANCELLATION' : 'OPEN');
    if (other && other.nightPush !== nightPush) await this.d.store.saveSubscription({ ...other, nightPush, updatedAt: now });
    return { created: true, state: stateOf(id, [row, ...(other ? [{ ...other, nightPush }] : [])]) };
  }

  async remove(accountId: string, eventId: string, kind: SubscriptionKind): Promise<void> {
    await this.d.store.deleteSubscription(accountId, eventId.toLowerCase(), kind);
  }

  async list(accountId: string, eventIds: readonly string[] | undefined, cursor: string | null, limit: number): Promise<SubscriptionPage> {
    const normalized = eventIds?.map((e) => e.toLowerCase());
    const lim = Math.max(1, Math.min(100, limit || LIMIT_DEFAULT));
    if (normalized) {
      const rows = await this.d.store.listSubscriptions(accountId, normalized, null, 500);
      return { items: [...new Set(normalized)].map((eventId) => stateOf(eventId, rows.filter((r) => r.eventId === eventId))), nextCursor: null };
    }
    const rows = await this.d.store.listSubscriptions(accountId, undefined, cursor, lim + 1);
    const page = rows.slice(0, lim);
    const grouped = new Map<string, NotificationSubscription[]>();
    for (const r of page) grouped.set(r.eventId, [...(grouped.get(r.eventId) ?? []), r]);
    const items = [...grouped.entries()].map(([eventId, rs]) => stateOf(eventId, rs));
    const nextCursor = rows.length > lim ? page.at(-1)?.id ?? null : null;
    return { items, nextCursor: nextCursor ? encodeCursor(page.at(-1)!) : null };
  }
}

const encodeCursor = (r: NotificationSubscription): string => Buffer.from(`v1:${r.createdAt.getTime()}:${r.id}`, 'utf8').toString('base64url');

export interface PushSubscriptionsDeps {
  readonly store: FanNotifyStore;
  readonly clock: Clock;
  readonly lookup: PushLookup;
}

export class PushSubscriptions {
  constructor(private readonly d: PushSubscriptionsDeps) {}

  async register(accountId: string, input: { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number | null }): Promise<{ created: boolean; subscriptionKey: string; service: string }> {
    const parts = checkPushEndpoint(input.endpoint);
    const keys = checkPushKeys(input.keys);
    const addresses = await this.d.lookup(parts.host);
    if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) throw new FanNotifyProblem('PUSH_SERVICE_NOT_ALLOWED', '구독 주소가 공인 주소로 풀리지 않습니다');

    const now = new Date(this.d.clock.now());
    const hash = subscriptionKeyOf(parts.endpoint);
    const existing = await this.d.store.findPushSubscriptionByEndpoint(parts.endpoint);
    const expiresAt = typeof input.expirationTime === 'number' && Number.isFinite(input.expirationTime) ? new Date(input.expirationTime) : null;
    if (existing) {
      await this.d.store.savePushSubscription({ ...existing, accountId, endpointHash: hash, service: parts.service, p256dh: keys.p256dh, auth: keys.auth, expiresAt, boundAt: now });
      // 다른 계정에서 다시 묶을 때도 그 계정의 10개 한도를 지킨다
      await this.d.store.trimPushSubscriptions(accountId, PUSH_SUBSCRIPTION_LIMIT);
      return { created: false, subscriptionKey: hash, service: parts.service };
    }
    const row: PushSubscriptionRecord = {
      id: newId(),
      accountId,
      endpoint: parts.endpoint,
      endpointHash: hash,
      service: parts.service,
      p256dh: keys.p256dh,
      auth: keys.auth,
      expiresAt,
      boundAt: now,
      createdAt: now,
    };
    await this.d.store.insertPushSubscription(row, PUSH_SUBSCRIPTION_LIMIT);
    return { created: true, subscriptionKey: hash, service: parts.service };
  }

  async remove(accountId: string, subscriptionKey: string): Promise<void> {
    await this.d.store.deletePushSubscription(accountId, subscriptionKey);
  }
}

export interface SubscriptionOptOutsDeps {
  readonly store: FanNotifyStore;
  readonly optOutKey: string;
}

export class SubscriptionOptOuts {
  constructor(private readonly d: SubscriptionOptOutsDeps) {}

  async redeem(token: string, body: { 'List-Unsubscribe'?: unknown }): Promise<void> {
    if (body['List-Unsubscribe'] !== 'One-Click') throw new FanNotifyProblem('INVALID', 'List-Unsubscribe=One-Click 본문이 필요합니다');
    const id = readOptOutToken(token, this.d.optOutKey);
    if (id) await this.d.store.deleteSubscriptionById(id);
  }
}

/** 시험·로컬용 받는 사람 조회 대역 */
export class MemoryRecipientDirectory implements RecipientDirectory {
  readonly rows = new Map<string, import('../domain/fan-notify-ports.js').Recipient>();
  async getMany(accountIds: readonly string[], includeEmail: boolean) {
    return accountIds.map((accountId) => {
      const r = this.rows.get(accountId);
      if (!r) return { accountId, status: 'NOT_FOUND' as const, verified: false, locale: 'ko', email: includeEmail ? null : undefined };
      return { ...r, ...(includeEmail ? { email: r.email ?? null } : { email: undefined }) };
    });
  }
}
