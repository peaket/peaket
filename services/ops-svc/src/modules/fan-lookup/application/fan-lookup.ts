// ops-svc 팬 조회 유스케이스(F-06-5, SCR-066). 원천은 포트로만 읽고, 원문 열람은 접속기록·감사 뒤에만 준다.
import { ProblemError } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import type { CsCaseStore } from '../../cases/index.js';

export interface FanProfile {
  readonly accountId: string;
  readonly memberCode?: string;
  readonly nickname?: string;
  readonly status?: string;
  readonly mergedIntoAccountId?: string | null;
  readonly name?: string;
  readonly phone?: string;
  readonly email?: string;
  readonly identityVerifiedAt?: string | null;
  readonly loginProviders?: string[];
  readonly mergeHistory?: Array<{ absorbedAccountId: string; mergedAt: string }>;
  readonly bookingRestriction?: { reasonCode: string; startsAt: string; endsAt: string; appealDueAt: string } | null;
  readonly selfRequestCaseIds?: string[];
}
export interface FanOrder {
  readonly orderId: string;
  readonly orderNo: string;
  readonly reservationNo?: string | null;
  readonly kind: string;
  readonly eventId?: string | null;
  readonly title: string;
  readonly status: string;
  readonly amount: number;
  readonly orderedAt: string;
  readonly buyerName?: string;
  readonly buyerPhone?: string;
}
export interface FanTicket {
  readonly ticketId: string;
  readonly orderId: string;
  readonly eventId: string;
  readonly title: string;
  readonly seatLabel: string;
  readonly status: string;
  readonly transferLocked: boolean;
  readonly holderIsPayer: boolean;
  readonly qrPayload?: string;
}
export interface FanTransfer {
  readonly offerId: string;
  readonly ticketId: string;
  readonly direction: string;
  readonly counterpartNickname?: string;
  readonly status: string;
  readonly createdAt: string;
  readonly closedAt?: string | null;
}
export interface FanQueueEntry {
  readonly eventId: string;
  readonly title: string;
  readonly status: string;
  readonly enteredAt: string;
  readonly endedAt?: string | null;
  readonly rank?: number;
  readonly riskScore?: number;
}
export interface FanPage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}
import type { AdminDataAccessStore } from '../domain/ports.js';
export type { AdminDataAccessRow, AdminDataAccessStore } from '../domain/ports.js';

export interface FanLookupWiring {
  readonly now?: () => number;
  readonly profile?: {
    get(accountId: string): Promise<FanProfile | undefined>;
    resolve(i: { orderNo?: string; reservationNo?: string; memberCode?: string }): Promise<string | undefined>;
  };
  readonly orders?: {
    list(accountId: string, page: { cursor?: string; limit: number }): Promise<FanPage<FanOrder>>;
    unmask(accountId: string, orderId: string): Promise<{ name?: string; phone?: string } | { error: 'not-found' | 'gone' }>;
  };
  readonly tickets?: { list(accountId: string, page: { cursor?: string; limit: number }): Promise<FanPage<FanTicket>> };
  readonly transfers?: { list(accountId: string, page: { cursor?: string; limit: number }): Promise<FanPage<FanTransfer>> };
  readonly queueEntries?: { list(accountId: string, page: { caseId: string; limit: number }): Promise<FanPage<FanQueueEntry>> };
  readonly access?: AdminDataAccessStore;
}

function bad(type: string, status: number, title: string): never {
  throw new ProblemError({ type, status, title });
}
const maskName = (v: string | undefined): string | null => (v ? `${[...v][0] ?? ''}*` : null);
const maskPhone = (v: string | undefined): string | null => (v ? v.replace(/(\d{2,3})[-\s]?\d{3,4}[-\s]?(\d{4})$/, '$1-****-$2') : null);
const maskEmail = (v: string | undefined): string | null => {
  if (!v) return null;
  const [local, domain] = v.split('@');
  return domain ? `${(local ?? '').slice(0, 2)}***@${domain}` : '***';
};
const maskNickname = (v: string | undefined): string | null => (v ? `${[...v][0] ?? ''}*` : null);
const iso = (v: string | null | undefined): string | null => (v ? v : null);

const FIELDS = new Set(['NAME', 'PHONE', 'EMAIL']);
const fieldsSelected = (fields: string[], wanted: string): boolean => fields.includes(wanted);

export class FanLookup {
  constructor(
    private readonly d: {
      wiring: FanLookupWiring;
      caseStore?: CsCaseStore;
      audit?: { append(record: { recordType: string; recordId: string; payload: Record<string, unknown>; nowMs: number }): Promise<void> };
      clock: { now(): number };
    },
  ) {}

  #now(): number {
    return this.d.wiring.now?.() ?? this.d.clock.now();
  }

  async lookup(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const keys = ['orderNo', 'reservationNo', 'memberCode'].filter((k) => typeof raw[k] === 'string' && String(raw[k]).trim() !== '');
    if (keys.length !== 1 || Object.keys(raw).some((k) => !['orderNo', 'reservationNo', 'memberCode'].includes(k))) bad('invalid-body', 400, '찾는 값은 하나여야 합니다');
    if (!this.d.wiring.profile) bad('fan-lookup-unavailable', 503, '팬 조회 원천을 사용할 수 없습니다');
    let accountId: string | undefined;
    try {
      accountId = await this.d.wiring.profile.resolve(raw as never);
    } catch {
      bad('fan-lookup-unavailable', 503, '팬 조회 원천을 사용할 수 없습니다');
    }
    if (!accountId) bad('not-found', 404, '찾는 계정이 없습니다');
    const p = await this.d.wiring.profile.get(accountId);
    if (!p) bad('not-found', 404, '찾는 계정이 없습니다');
    return { accountId: p.accountId, memberCode: p.memberCode ?? '', nickname: p.nickname ?? '', status: p.status ?? 'ACTIVE', mergedIntoAccountId: p.mergedIntoAccountId ?? null };
  }

  async detail(accountId: string): Promise<Record<string, unknown>> {
    if (!this.d.wiring.profile) bad('fan-lookup-unavailable', 503, '팬 조회 원천을 사용할 수 없습니다');
    const p = await this.d.wiring.profile.get(accountId);
    if (!p) bad('not-found', 404, '팬 계정이 없습니다');
    return {
      accountId: p.accountId,
      memberCode: p.memberCode ?? '',
      nickname: p.nickname ?? '',
      status: p.status ?? 'ACTIVE',
      nameMasked: maskName(p.name),
      phoneMasked: maskPhone(p.phone),
      emailMasked: maskEmail(p.email),
      identityVerifiedAt: iso(p.identityVerifiedAt),
      loginProviders: p.loginProviders ?? [],
      mergeHistory: p.mergeHistory ?? [],
      bookingRestriction: p.bookingRestriction ?? null,
      selfRequestCaseIds: p.selfRequestCaseIds ?? [],
    };
  }

  async unmask(accountId: string, raw: Record<string, unknown>, actor: { accountId: string; role: string }, sourceIp: string): Promise<Record<string, unknown>> {
    const fields = Array.isArray(raw.fields) ? raw.fields.filter((f): f is string => typeof f === 'string') : [];
    const reason = typeof raw.reason === 'string' ? raw.reason : '';
    const orderId = typeof raw.orderId === 'string' ? raw.orderId : undefined;
    if (!fields.length || fields.length > 3 || new Set(fields).size !== fields.length || fields.some((f) => !FIELDS.has(f))) bad('invalid-body', 422, '고를 칸이 올바르지 않습니다');
    if ([...reason].length < 5 || [...reason].length > 500) bad('invalid-body', 422, '열람 사유는 5~500자입니다');
    if (orderId && fields.includes('EMAIL')) bad('invalid-body', 422, '주문에는 이메일이 없습니다');
    if (!this.d.wiring.profile) bad('fan-lookup-unavailable', 503, '팬 조회 원천을 사용할 수 없습니다');
    const now = this.#now();
    const rateKey = `${actor.accountId}:${new Date(now).toISOString().slice(0, 10)}`;
    const count = (this.#counts.get(rateKey) ?? 0) + 1;
    if (count > 200) bad('fan-lookup-rate-limited', 429, '열람 한도를 넘었습니다');
    const profile = await this.d.wiring.profile.get(accountId);
    if (!profile) bad('not-found', 404, '팬 계정이 없습니다');
    let values: { name?: string; phone?: string; email?: string };
    if (orderId) {
      if (!this.d.wiring.orders) bad('fan-lookup-unavailable', 503, '주문 원천을 사용할 수 없습니다');
      const out = await this.d.wiring.orders.unmask(accountId, orderId);
      if ('error' in out) {
        if (out.error === 'gone') bad('retention-ended', 410, '보존 기간이 지나 열 수 없습니다');
        bad('not-found', 404, '주문을 찾을 수 없습니다');
      } else {
        values = { ...out };
      }
    } else {
      values = { name: profile.name, phone: profile.phone, email: profile.email };
    }
    const selected = {
      ...(fieldsSelected(fields, 'NAME') ? { name: values.name ?? null } : {}),
      ...(fieldsSelected(fields, 'PHONE') ? { phone: values.phone ?? null } : {}),
      ...(fieldsSelected(fields, 'EMAIL') ? { email: values.email ?? null } : {}),
    };
    const id = randomUUID();
    const retainUntilMs = (() => {
      const d = new Date(now);
      return Date.UTC(d.getUTCFullYear() + 2, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
    })();
    const access = this.d.wiring.access;
    if (!access) bad('access-log-unavailable', 503, '접속기록을 남길 수 없습니다');
    try {
      await access.append({ id, adminAccountId: actor.accountId, actorRole: actor.role, action: 'VIEW_UNMASKED', targetKind: 'FAN_PROFILE', reason, fields, sourceIp, sourceService: 'ops-svc', targetCount: fields.length, occurredAtMs: now, recordedAtMs: now, retainUntilMs });
    } catch {
      bad('access-log-unavailable', 503, '접속기록을 남길 수 없습니다');
    }
    this.#counts.set(rateKey, count);
    try {
      await this.d.audit?.append({ recordType: 'ADMIN_DATA_ACCESS_RECORDED', recordId: id, nowMs: now, payload: { action: 'VIEW_UNMASKED', targetKind: 'FAN_PROFILE', fields, sourceService: 'ops-svc' } });
    } catch {
      // 감사 체인 실패는 접속기록을 되돌리지 않는다(배경 정비가 다시 본다)
    }
    return { ...selected, reason, unmaskedAt: new Date(now).toISOString() };
  }

  #counts = new Map<string, number>();

  async orders(accountId: string, limit: number): Promise<Record<string, unknown>> {
    if (!this.d.wiring.orders) bad('fan-lookup-unavailable', 503, '주문 원천을 사용할 수 없습니다');
    const page = await this.d.wiring.orders.list(accountId, { limit });
    return { items: page.items.map((o) => ({ orderId: o.orderId, orderNo: o.orderNo, reservationNo: o.reservationNo ?? null, kind: o.kind, eventId: o.eventId ?? null, title: o.title, status: o.status, amount: o.amount, orderedAt: o.orderedAt, buyerNameMasked: maskName(o.buyerName), buyerPhoneMasked: maskPhone(o.buyerPhone) })), nextCursor: page.nextCursor };
  }

  async tickets(accountId: string, limit: number): Promise<Record<string, unknown>> {
    if (!this.d.wiring.tickets) bad('fan-lookup-unavailable', 503, '티켓 원천을 사용할 수 없습니다');
    const page = await this.d.wiring.tickets.list(accountId, { limit });
    return { items: page.items.map((t) => ({ ticketId: t.ticketId, orderId: t.orderId, eventId: t.eventId, title: t.title, seatLabel: t.seatLabel, status: t.status, transferLocked: t.transferLocked, holderIsPayer: t.holderIsPayer })), nextCursor: page.nextCursor };
  }

  async transfers(accountId: string, limit: number): Promise<Record<string, unknown>> {
    if (!this.d.wiring.transfers) bad('fan-lookup-unavailable', 503, '양도 원천을 사용할 수 없습니다');
    const page = await this.d.wiring.transfers.list(accountId, { limit });
    return { items: page.items.map((t) => ({ offerId: t.offerId, ticketId: t.ticketId, direction: t.direction, counterpartNicknameMasked: maskNickname(t.counterpartNickname), status: t.status, createdAt: t.createdAt, closedAt: t.closedAt ?? null })), nextCursor: page.nextCursor };
  }

  async queueEntries(accountId: string, caseId: string | undefined, limit: number): Promise<Record<string, unknown>> {
    if (!caseId) bad('invalid-query', 400, '본인 확인 건이 필요합니다');
    if (!this.d.wiring.profile || !this.d.wiring.queueEntries) bad('fan-lookup-unavailable', 503, '대기 원천을 사용할 수 없습니다');
    const p = await this.d.wiring.profile.get(accountId);
    if (!p) bad('not-found', 404, '팬 계정이 없습니다');
    if (!(p.selfRequestCaseIds ?? []).includes(caseId)) bad('self-request-required', 403, '본인 확인을 요청한 건이 아닙니다');
    const page = await this.d.wiring.queueEntries.list(accountId, { caseId, limit });
    return { items: page.items.map((q) => ({ eventId: q.eventId, title: q.title, status: q.status, enteredAt: q.enteredAt, endedAt: q.endedAt ?? null })), nextCursor: page.nextCursor };
  }

  async cases(accountId: string, limit: number): Promise<Record<string, unknown>> {
    if (!this.d.caseStore) bad('fan-lookup-unavailable', 503, '건 원천을 사용할 수 없습니다');
    const rows = await this.d.caseStore.list({ statuses: ['OPEN', 'IN_PROGRESS', 'RESOLVED'], accountId, limit });
    return { items: rows.map((c) => ({ caseId: c.caseId, kind: c.kind, targetRef: c.targetRef, category: c.category, status: c.status, progressDueAt: c.progressDueAtMs === null ? null : new Date(c.progressDueAtMs).toISOString(), resultDueAt: c.resultDueAtMs === null ? null : new Date(c.resultDueAtMs).toISOString(), assignee: c.assignee, version: c.version, createdAt: new Date(c.createdAtMs).toISOString(), resolvedAt: c.resolvedAtMs === null ? null : new Date(c.resolvedAtMs).toISOString(), resultNote: c.resultNote })), nextCursor: null };
  }
}
