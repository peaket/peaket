// F-06-5 core-svc support 문의 시험 공용 도우미(시험 담당 lane2-freeze-F-06-5-opencode).
// 앱은 시험마다 새로 세운다(문의·기록·Outbox가 시험 사이에 남지 않는다).
// 구현 전에는 support 키트에 문의 부품이 없어 HTTP 경로가 404이고, gRPC는 UNIMPLEMENTED다(그 자리에서 실패).
// 정본: openapi /v1/inquiries*, core.proto SupportCaseService, docs/features/transfer-refund.md §7.1·§7.3, R-T27.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock, type FakeClock } from '@peaket/platform';
import { Writable } from 'node:stream';
import { AppModule } from '../src/app.module.js';
import { FakeIdentity, fan } from './support.js';

export const SUPPORT_KIT = Symbol.for('peaket.core.support-kit');
export const INTERNAL = 'support-inquiry-token-000000';
/** 계획 §5: 2026-11-27이 아닌 날짜를 고른다(날짜 하드코딩 결함이 숨지 않게). 금 2026-11-20 23:30 KST */
export const NOW_MS = Date.parse('2026-11-20T14:30:00.000Z');
export const HOLIDAYS = ['2026-11-25', '2026-12-03', '2026-12-04'] as const;
/** 3영업일·10영업일(금 11-20 23:30 KST에서 손으로 센 값) */
export const BD3 = '2026-11-26T14:30:00.000Z';
export const BD10 = '2026-12-09T14:30:00.000Z';

export interface InquiryRowLike {
  inquiryId: string;
  number: string;
  accountId: string;
  category: string;
  title: string;
  body: string;
  status: string;
  orderRef: string | null;
  caseId: string | null;
  requestKey: string | null;
  createdAtMs: number;
  answeredAtMs: number | null;
  fanViewedAtMs: number | null;
  closedAtMs: number | null;
  purgeAtMs: number | null;
}

export interface InquiryMessageLike {
  messageId: string;
  inquiryId: string;
  authorKind: 'FAN' | 'AGENT' | 'SYSTEM';
  kind: 'MESSAGE' | 'PROGRESS' | 'ANSWER';
  body: string;
  createdAtMs: number;
}

export interface InquiryKit {
  readonly inquiries: {
    rows(): InquiryRowLike[];
    messages(): InquiryMessageLike[];
    outbox(): Array<Record<string, unknown>>;
    failNext(op: 'saveInquiry' | 'saveMessage' | 'saveOutbox' | 'saveReply' | 'saveClose'): void;
    closeIdle(nowMs: number): Promise<number>;
  };
  readonly inquiryGrpcHandlers: Record<string, (call: never, cb: never) => void>;
}

export interface InquiryHarness {
  readonly svc: Awaited<ReturnType<typeof createService>>;
  readonly clock: FakeClock;
  readonly logs: { text(): string; lines(): Array<Record<string, unknown>> };
  readonly notices: Array<{ inquiryId: string; accountId: string; event: string }>;
  /** 관련 주문 원천: orderRef → 그 계정·표시 요약. 'boom'으로 넣으면 원천 실패를 흉내 낸다 */
  readonly orders: Map<string, { accountId: string; summary: string } | 'boom'>;
  fanHeaders(accountId?: string): Record<string, string>;
  create(h: Record<string, string>, body: unknown, idempotencyKey?: string | null): Promise<{ status: number; body: Record<string, unknown>; location?: string; headers: Record<string, unknown> }>;
  list(h: Record<string, string>, query?: string): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }>;
  get(h: Record<string, string>, inquiryId: string): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }>;
  message(h: Record<string, string>, inquiryId: string, body: unknown, idempotencyKey?: string | null): Promise<{ status: number; body: Record<string, unknown> }>;
  internalCase(inquiryId: string, caseId: string, token?: string | null): Promise<{ status: number; body: Record<string, unknown> }>;
  tick(nowMs?: number): Promise<number>;
  kit(): InquiryKit;
  close(): Promise<void>;
}

const logSink = () => {
  let text = '';
  const stream = new Writable({ write(c, _e, cb) { text += String(c); cb(); } });
  return { stream, text: () => text, lines: () => text.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>) };
};

export async function inquiryHarness(o: { notifyFails?: boolean } = {}): Promise<InquiryHarness> {
  const clock = fakeClock({ now: NOW_MS });
  const logs = logSink();
  const notices: Array<{ inquiryId: string; accountId: string; event: string }> = [];
  const orders = new Map<string, { accountId: string; summary: string } | 'boom'>();
  const support = {
    holidays: [...HOLIDAYS],
    orders: {
      async ownerOf(orderRef: string) {
        const v = orders.get(orderRef);
        if (v === 'boom') throw new Error('order source down');
        return v?.accountId;
      },
      async summaryOf(orderRef: string) {
        const v = orders.get(orderRef);
        if (v === 'boom') throw new Error('order source down');
        return v?.summary;
      },
    },
    inquiryNotifier: {
      async send(i: { inquiryId: string; accountId: string; event: string }) {
        if (o.notifyFails) throw new Error('fan notifier down');
        notices.push(i);
      },
    },
  };
  const svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, support: support as never } as never),
    env: { PEAKET_ENV: 'ci', PEAKET_INTERNAL_TOKEN: INTERNAL },
    clock,
    logDestination: logs.stream,
    adminAuthz: new FakeIdentity(),
  });
  let kitValue: InquiryKit | undefined;
  const kit = (): InquiryKit => {
    if (kitValue) return kitValue;
    let raw: unknown;
    try {
      raw = svc.app.get(SUPPORT_KIT);
    } catch {
      raw = undefined;
    }
    const k = raw as { inquiries?: InquiryKit['inquiries']; inquiryGrpcHandlers?: InquiryKit['inquiryGrpcHandlers'] } | undefined;
    if (!k?.inquiries || !k.inquiryGrpcHandlers) throw new Error('core-svc support 문의 키트가 없다(계획 §4, 구현 전)');
    kitValue = { inquiries: k.inquiries, inquiryGrpcHandlers: k.inquiryGrpcHandlers };
    return kitValue;
  };
  const parse = (payload: string): Record<string, unknown> => (payload ? (JSON.parse(payload) as Record<string, unknown>) : {});
  const hdr = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });
  return {
    svc,
    clock,
    logs,
    notices,
    orders,
    fanHeaders: (accountId) => fan(accountId ?? randomUUID()),
    async create(h, body, idempotencyKey) {
      const key = idempotencyKey === null ? undefined : (idempotencyKey ?? randomUUID());
      const r = await svc.http.inject({ method: 'POST', url: '/v1/inquiries', headers: { ...hdr(h), ...(key ? { 'idempotency-key': key } : {}) }, payload: JSON.stringify(body) });
      return { status: r.statusCode, body: parse(r.payload), ...(typeof r.headers.location === 'string' ? { location: r.headers.location } : {}), headers: r.headers as Record<string, unknown> };
    },
    async list(h, query = '') {
      const r = await svc.http.inject({ method: 'GET', url: `/v1/inquiries${query ? `?${query}` : ''}`, headers: h });
      return { status: r.statusCode, body: parse(r.payload), headers: r.headers as Record<string, unknown> };
    },
    async get(h, inquiryId) {
      const r = await svc.http.inject({ method: 'GET', url: `/v1/inquiries/${inquiryId}`, headers: h });
      return { status: r.statusCode, body: parse(r.payload), headers: r.headers as Record<string, unknown> };
    },
    async message(h, inquiryId, body, idempotencyKey) {
      const key = idempotencyKey === null ? undefined : (idempotencyKey ?? randomUUID());
      const r = await svc.http.inject({ method: 'POST', url: `/v1/inquiries/${inquiryId}/messages`, headers: { ...hdr(h), ...(key ? { 'idempotency-key': key } : {}) }, payload: JSON.stringify(body) });
      return { status: r.statusCode, body: parse(r.payload) };
    },
    async internalCase(inquiryId, caseId, token = INTERNAL) {
      const r = await svc.http.inject({ method: 'POST', url: `/internal/v1/inquiries/${inquiryId}/case`, headers: { 'content-type': 'application/json', ...(token ? { 'x-peaket-internal-token': token } : {}) }, payload: JSON.stringify({ caseId }) });
      return { status: r.statusCode, body: parse(r.payload) };
    },
    async tick(nowMs) {
      return kit().inquiries.closeIdle(nowMs ?? clock.now());
    },
    kit,
    close: () => svc.close(),
  };
}

export const problemType = (b: Record<string, unknown>): string => String(b.type ?? '').split('/').pop() ?? '';

/** 문의 하나를 접수하고 그 응답을 돌려준다(201 기대). key를 null로 주면 Idempotency-Key 없이 보낸다 */
export async function submit(h: InquiryHarness, o: { accountId: string; category?: string; orderRef?: string; title?: string; body?: string; key?: string | null }) {
  return h.create(h.fanHeaders(o.accountId), {
    category: o.category ?? 'MERCH',
    ...(o.orderRef ? { orderRef: o.orderRef } : {}),
    title: o.title ?? '응원봉 배송 예정일이 궁금합니다',
    body: o.body ?? '응원봉을 주문했는데 배송 예정일이 언제인지 알고 싶습니다. 공연 전에 받을 수 있을까요?',
  }, o.key);
}
