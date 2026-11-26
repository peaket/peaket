// core-svc 문의 유스케이스(F-06-5). 접수·목록·상세·추가 문의·내부 답변·닫기.
// 저장값은 계좌번호를 바꾸지 않고, 응답에서만 감춘다(ops가 콘솔 응답을 가린다).
import { ProblemError } from '@peaket/platform';
import type { Clock } from '@peaket/platform';
import {
  BODY_MAX,
  BODY_MIN,
  CLOSE_IDLE_MS,
  DAILY_LIMIT,
  PURGE_YEARS,
  REPLY_MAX,
  REPLY_MIN,
  TITLE_MAX,
  TITLE_MIN,
  addYears,
  caseKindOf,
  cleanBody,
  cleanTitle,
  dueOf,
  graphemeLength,
  inquiryNumber,
  isInquiryCategory,
  kstDate,
  kstYm,
  type Holidays,
  type InquiryCategory,
  type InquiryMessageKind,
  type InquiryMessageRow,
  type InquiryRow,
  type InquiryStatus,
} from '../domain/inquiry.js';
import type { InquiryFanNotifier, InquiryOrderDirectory, InquiryStore } from '../domain/inquiry-ports.js';

function fail(type: string, status: number, title: string): never {
  throw new ProblemError({ type, status, title });
}

export interface InquiryDeps {
  readonly store: InquiryStore;
  readonly orders?: InquiryOrderDirectory;
  readonly notifier?: InquiryFanNotifier;
  readonly clock: Clock;
  readonly holidays: Holidays;
}

export interface SubmitInput {
  readonly category: InquiryCategory;
  readonly orderRef?: string;
  readonly title: string;
  readonly body: string;
}

export interface InquiryView {
  readonly inquiryId: string;
  readonly number: string;
  readonly category: string;
  readonly orderRef: string | null;
  readonly orderSummary: string | null;
  readonly title: string;
  readonly status: string;
  readonly hasNewAnswer: boolean;
  readonly createdAt: string;
  readonly answeredAt: string | null;
  readonly closedAt: string | null;
  readonly progressDueAt: string | null;
  readonly resultDueAt: string;
}

export interface InquiryDetailView extends InquiryView {
  readonly messages: InquiryMessageView[];
}

export interface InquiryMessageView {
  readonly messageId: string;
  readonly authorKind: string;
  readonly authorDisplay: string;
  readonly kind: string;
  readonly body: string;
  readonly createdAt: string;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const displayOf = (author: string): string => (author === 'AGENT' ? '피켓 고객센터' : author === 'FAN' ? '나' : '피켓');

export class Inquiries {
  constructor(private readonly d: InquiryDeps) {}

  async submit(accountId: string, input: SubmitInput, requestKey: string, requestHash: string): Promise<InquiryView & { inquiryId: string }> {
    const existing = await this.d.store.findByRequestKey(accountId, requestKey);
    if (existing) {
      if (existing.requestHash !== requestHash) fail('idempotency-key-reused', 422, '같은 멱등 키를 다른 요청에 썼습니다');
      return this.view(existing);
    }
    if (!isInquiryCategory(input.category)) fail('invalid-body', 422, '문의 유형이 올바르지 않습니다');
    const title = cleanTitle(input.title);
    const body = cleanBody(input.body);
    if (graphemeLength(title) < TITLE_MIN || graphemeLength(title) > TITLE_MAX) fail('invalid-body', 422, '제목은 5~50자입니다');
    if (graphemeLength(body) < BODY_MIN || graphemeLength(body) > BODY_MAX) fail('invalid-body', 422, '내용은 10~2,000자입니다');
    const now = this.d.clock.now();
    const startOfDay = Date.parse(`${kstDate(now)}T00:00:00+09:00`);
    if ((await this.d.store.countSince(accountId, startOfDay)) >= DAILY_LIMIT) fail('inquiry-daily-limit', 429, '하루 접수 한도를 넘었습니다');
    let orderSummary: string | null = null;
    if (input.orderRef) {
      try {
        const owner = await this.d.orders?.ownerOf(input.orderRef);
        if (owner === undefined || owner !== accountId) fail('order-not-owned', 422, '이 계정의 주문이 아닙니다');
        orderSummary = (await this.d.orders?.summaryOf(input.orderRef)) ?? null;
      } catch (err) {
        if (err instanceof ProblemError) throw err;
        fail('order-lookup-unavailable', 503, '관련 주문을 확인하지 못했습니다');
      }
    }
    const seq = await this.d.store.nextSequence(kstYm(now));
    const inquiryId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const due = dueOf(input.category, now, this.d.holidays);
    const row: InquiryRow = {
      inquiryId,
      number: inquiryNumber(now, seq),
      accountId,
      category: input.category,
      orderRef: input.orderRef ?? null,
      orderSummary,
      title,
      body,
      status: 'RECEIVED',
      caseId: null,
      requestKey,
      requestHash,
      createdAtMs: now,
      answeredAtMs: null,
      fanViewedAtMs: null,
      closedAtMs: null,
      purgeAtMs: null,
      progressDueAtMs: due.progressDueAtMs,
      resultDueAtMs: due.resultDueAtMs,
    };
    const message: InquiryMessageRow = {
      messageId,
      inquiryId,
      authorKind: 'FAN',
      kind: 'MESSAGE',
      body,
      requestKey,
      requestHash,
      createdAtMs: now,
    };
    const caseRequest = {
      eventKey: inquiryId,
      kind: caseKindOf(input.category),
      sourceId: inquiryId,
      category: input.category,
      createdAt: new Date(now).toISOString(),
    } as const;
    try {
      await this.d.store.create(row, message, caseRequest);
    } catch {
      fail('inquiry-store-unavailable', 503, '문의를 저장하지 못했습니다');
    }
    return this.view(row);
  }

  async list(accountId: string, statuses: readonly InquiryStatus[] | undefined, page: number, limit: number): Promise<{ items: InquiryView[]; total: number; page: number; limit: number }> {
    const total = await this.d.store.countByAccount(accountId, statuses);
    const rows = await this.d.store.listByAccount(accountId, statuses, limit, (page - 1) * limit);
    return { items: rows.map((r) => this.view(r)), total, page, limit };
  }

  async detail(accountId: string, inquiryId: string): Promise<InquiryDetailView> {
    const row = await this.d.store.find(inquiryId);
    if (!row || row.accountId !== accountId) fail('not-found', 404, '문의를 찾을 수 없습니다');
    await this.d.store.markViewed(inquiryId, this.d.clock.now());
    const messages = await this.d.store.messages(inquiryId);
    return {
      ...this.view(row),
      messages: messages.map((m) => ({ messageId: m.messageId, authorKind: m.authorKind, authorDisplay: displayOf(m.authorKind), kind: m.kind, body: m.body, createdAt: iso(m.createdAtMs)! })),
    };
  }

  /** 내부 gRPC용. 소유·열람 시각을 보지 않고 원문 행과 기록을 준다 */
  async detailAny(inquiryId: string): Promise<{ row: InquiryRow; messages: InquiryMessageRow[] } | undefined> {
    const row = await this.d.store.find(inquiryId);
    if (!row) return undefined;
    return { row, messages: await this.d.store.messages(inquiryId) };
  }

  async addMessage(accountId: string, inquiryId: string, bodyRaw: string, requestKey: string, requestHash: string): Promise<InquiryMessageView> {
    const row = await this.d.store.find(inquiryId);
    if (!row || row.accountId !== accountId) fail('not-found', 404, '문의를 찾을 수 없습니다');
    if (row.status === 'CLOSED') fail('inquiry-closed', 409, '닫힌 문의입니다');
    const existing = await this.d.store.findMessageByRequestKey(inquiryId, requestKey);
    if (existing) {
      if (existing.requestHash !== requestHash) fail('idempotency-key-reused', 422, '같은 멱등 키를 다른 요청에 썼습니다');
      return { messageId: existing.messageId, authorKind: existing.authorKind, authorDisplay: displayOf(existing.authorKind), kind: existing.kind, body: existing.body, createdAt: iso(existing.createdAtMs)! };
    }
    const body = cleanBody(bodyRaw);
    if (graphemeLength(body) < BODY_MIN || graphemeLength(body) > BODY_MAX) fail('invalid-body', 422, '내용은 10~2,000자입니다');
    const now = this.d.clock.now();
    const message: InquiryMessageRow = { messageId: crypto.randomUUID(), inquiryId, authorKind: 'FAN', kind: 'MESSAGE', body, requestKey, requestHash, createdAtMs: now };
    const status: InquiryStatus = row.status === 'ANSWERED' || row.status === 'RECEIVED' ? 'IN_PROGRESS' : row.status;
    const caseRequest = { eventKey: message.messageId, kind: caseKindOf(row.category), sourceId: inquiryId, category: row.category, followUp: true as const, createdAt: new Date(now).toISOString() };
    try {
      await this.d.store.addFanMessage(message, status, caseRequest);
    } catch {
      fail('inquiry-store-unavailable', 503, '추가 문의를 저장하지 못했습니다');
    }
    return { messageId: message.messageId, authorKind: 'FAN', authorDisplay: '나', kind: 'MESSAGE', body, createdAt: iso(now)! };
  }

  async setCaseId(inquiryId: string, caseId: string): Promise<{ changed: boolean }> {
    const changed = await this.d.store.setCaseId(inquiryId, caseId);
    if (!changed) fail('not-found', 404, '문의를 찾을 수 없습니다');
    return { changed };
  }

  async recordReply(inquiryId: string, kind: 'ANSWER' | 'PROGRESS', bodyRaw: string, requestKey: string, requestHash: string): Promise<{ result: 'RECORDED' | 'INQUIRY_CLOSED'; message?: InquiryMessageRow; status: InquiryStatus }> {
    const row = await this.d.store.find(inquiryId);
    if (!row) fail('not-found', 404, '문의를 찾을 수 없습니다');
    if (row.status === 'CLOSED') return { result: 'INQUIRY_CLOSED', status: 'CLOSED' };
    const existing = await this.d.store.findMessageByRequestKey(inquiryId, requestKey);
    if (existing) {
      if (existing.requestHash !== requestHash) fail('reply-request-conflict', 409, '같은 요청 키를 다른 답변에 썼습니다');
      return { result: 'RECORDED', message: existing, status: row.status };
    }
    const body = cleanBody(bodyRaw);
    if (body.trim() === '' || graphemeLength(body) > 2_000) fail('invalid-body', 422, '답변은 1~2,000자입니다');
    const now = this.d.clock.now();
    const message: InquiryMessageRow = {
      messageId: crypto.randomUUID(),
      inquiryId,
      authorKind: 'AGENT',
      kind: kind as InquiryMessageKind,
      body,
      requestKey,
      requestHash,
      createdAtMs: now,
    };
    const status: InquiryStatus = kind === 'ANSWER' ? 'ANSWERED' : 'IN_PROGRESS';
    try {
      await this.d.store.addAgentMessage(message, status, kind === 'ANSWER' ? now : null);
    } catch {
      fail('inquiry-store-unavailable', 503, '답변을 저장하지 못했습니다');
    }
    try {
      await this.d.notifier?.send({ inquiryId, accountId: row.accountId, event: kind });
    } catch {
      // 알림 실패는 답변을 막지 않는다(ASVS 16.5.2)
    }
    return { result: 'RECORDED', message, status };
  }

  async closeInquiry(inquiryId: string): Promise<{ status: InquiryStatus; closedAtMs: number | null }> {
    const row = await this.d.store.find(inquiryId);
    if (!row) fail('not-found', 404, '문의를 찾을 수 없습니다');
    if (row.status === 'CLOSED') return { status: 'CLOSED', closedAtMs: row.closedAtMs };
    const now = this.d.clock.now();
    try {
      await this.d.store.close(inquiryId, now, addYears(now, PURGE_YEARS));
    } catch {
      fail('inquiry-store-unavailable', 503, '문의를 닫지 못했습니다');
    }
    return { status: 'CLOSED', closedAtMs: now };
  }

  async closeIdle(nowMs: number): Promise<number> {
    return this.d.store.closeIdle(nowMs, CLOSE_IDLE_MS, PURGE_YEARS);
  }

  private view(row: InquiryRow): InquiryView {
    return {
      inquiryId: row.inquiryId,
      number: row.number,
      category: row.category,
      orderRef: row.orderRef,
      orderSummary: row.orderSummary,
      title: row.title,
      status: row.status,
      hasNewAnswer: row.answeredAtMs !== null && (row.fanViewedAtMs === null || row.fanViewedAtMs < row.answeredAtMs),
      createdAt: iso(row.createdAtMs)!,
      answeredAt: iso(row.answeredAtMs),
      closedAt: iso(row.closedAtMs),
      progressDueAt: iso(row.progressDueAtMs),
      resultDueAt: iso(row.resultDueAtMs)!,
    };
  }
}
