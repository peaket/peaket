// F-06-5 core-svc support 문의 gRPC 시험(SupportCaseService, 시험 담당 lane2-freeze-F-06-5-opencode).
// 정본: docs/api/proto/peaket/core/v1/core.proto SupportCaseService, openapi CaseReply, data.md inquiry·inquiry_message, R-T27 ⑤.
// 구현 전에는 키트에 inquiryGrpcHandlers가 없어 각 RPC가 UNIMPLEMENTED로 끝나 그 자리에서 실패한다.
import 'reflect-metadata';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { startGrpcServer, type StartedGrpcServer } from '@peaket/platform';
import { coreV1Core } from '@peaket/contracts/proto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { INTERNAL, inquiryHarness, submit, type InquiryHarness } from './support-inquiry-support.js';

const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const pkg = (grpc.loadPackageDefinition(protoLoader.fromJSON(coreV1Core as never, LOAD)) as unknown as { peaket: { core: { v1: { SupportCaseService: grpc.ServiceClientConstructor } } } }).peaket.core.v1;

let current: InquiryHarness | undefined;
let server: StartedGrpcServer;
let client: grpc.Client & Record<string, (...a: unknown[]) => void>;

const handlers = (): Record<string, grpc.handleUnaryCall<Record<string, unknown>, Record<string, unknown>>> => {
  try {
    const h = current?.kit().inquiryGrpcHandlers;
    return (h ?? {}) as Record<string, grpc.handleUnaryCall<Record<string, unknown>, Record<string, unknown>>>;
  } catch {
    return {};
  }
};

function wrap(name: 'GetInquiryRecord' | 'AddInquiryReply' | 'CloseInquiry'): grpc.handleUnaryCall<Record<string, unknown>, Record<string, unknown>> {
  return (call, cb) => {
    const handler = handlers()[name];
    if (!handler) return cb({ code: grpc.status.UNIMPLEMENTED, details: 'support 문의 키트가 없다' });
    handler(call, cb);
  };
}

const md = (o: { token?: string | null; caller?: string | null } = {}) => {
  const m = new grpc.Metadata();
  if (o.token !== null) m.set('x-peaket-internal-token', o.token ?? INTERNAL);
  if (o.caller !== null) m.set('x-peaket-caller', o.caller ?? 'ops-svc');
  return m;
};
const call = (method: string, req: Record<string, unknown>, m = md()) =>
  new Promise<{ err?: grpc.ServiceError; res?: Record<string, unknown> }>((resolve) =>
    (client as unknown as Record<string, (r: unknown, m: grpc.Metadata, cb: (e: grpc.ServiceError | null, v?: unknown) => void) => void>)[method]!(req, m, (e, v) => resolve({ ...(e ? { err: e } : {}), ...(v ? { res: v as Record<string, unknown> } : {}) })),
  );

const tsOf = (v: unknown): number => {
  const o = v as { seconds?: number; nanos?: number };
  return Number(o.seconds) * 1000 + Number(o.nanos ?? 0) / 1_000_000;
};
const addYears = (ms: number, years: number): number => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
};

let seq = 0;
async function open(h: InquiryHarness = current!): Promise<{ accountId: string; inquiryId: string }> {
  const accountId = crypto.randomUUID();
  const r = await submit(h, { accountId, title: `gRPC 문의 ${++seq}번째`, body: 'gRPC 시험에서 문의를 하나 열어 두는 본문입니다.' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { accountId, inquiryId: String(r.body.inquiryId) };
}

async function answer(inquiryId: string, body = '확인했습니다. 배송 예정일은 다음 주 수요일입니다.') {
  return call('AddInquiryReply', { request_id: `req-${++seq}`, inquiry_id: inquiryId, kind: 'INQUIRY_REPLY_KIND_ANSWER', body, acted_by: crypto.randomUUID() });
}

beforeAll(async () => {
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    profile: 'service',
    drainMs: 0,
    services: [
      {
        definition: pkg.SupportCaseService.service,
        handlers: { GetInquiryRecord: wrap('GetInquiryRecord'), AddInquiryReply: wrap('AddInquiryReply'), CloseInquiry: wrap('CloseInquiry') },
      },
    ],
  });
  client = new pkg.SupportCaseService(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as typeof client;
});
beforeEach(async () => {
  current = await inquiryHarness();
});
afterEach(async () => {
  await current?.close();
  current = undefined;
});
afterAll(async () => {
  await server?.close();
});

describe('SupportCaseService 내부 경계', () => {
  test('R-T27 ④ 내부 토큰·호출자가 틀리면 PERMISSION_DENIED이고, 맞으면 없는 문의는 NOT_FOUND다', async () => {
    const inquiryId = crypto.randomUUID();
    for (const m of [{}, { caller: null }, { token: 'wrong' }, { caller: 'core-svc' }]) {
      const r = await call('GetInquiryRecord', { inquiry_id: inquiryId, acted_by: crypto.randomUUID() }, md(m as never));
      expect(r.err?.code).toBe(grpc.status.PERMISSION_DENIED);
    }
    const missing = await call('GetInquiryRecord', { inquiry_id: inquiryId, acted_by: crypto.randomUUID() });
    expect(missing.err?.code).toBe(grpc.status.NOT_FOUND);
  });

  test('R-T27 ④ [ASVS v5.0.0-8.1.2][ASVS v5.0.0-8.2.1] 답변은 기록되고 상태가 ANSWERED가 되며 담당자 ID가 기록·팬 알림에 실리지 않는다', async () => {
    const { accountId, inquiryId } = await open();
    const r = await answer(inquiryId);
    expect(r.err).toBeUndefined();
    expect(r.res).toMatchObject({ result: 'INQUIRY_REPLY_RESULT_RECORDED', status: 'INQUIRY_STATUS_ANSWERED' });
    const msg = r.res!.message as Record<string, unknown>;
    expect(msg).toMatchObject({ author_kind: 'INQUIRY_AUTHOR_KIND_AGENT', kind: 'INQUIRY_MESSAGE_KIND_ANSWER' });
    expect(JSON.stringify(msg)).not.toContain('acted_by');
    const row = current!.kit().inquiries.messages().find((m) => m.messageId === msg.message_id)!;
    expect(row).toMatchObject({ authorKind: 'AGENT', kind: 'ANSWER' });
    expect(current!.kit().inquiries.rows()[0]).toMatchObject({ status: 'ANSWERED' });
    expect(current!.notices).toEqual([{ inquiryId, accountId, event: 'ANSWER' }]);
    expect(JSON.stringify(current!.notices)).not.toContain('acted_by');
  });

  test('R-T27 ④ 진행 경과는 IN_PROGRESS, 추가 문의는 다시 IN_PROGRESS, 답변은 ANSWERED다', async () => {
    const { accountId, inquiryId } = await open();
    const p = await call('AddInquiryReply', { request_id: `req-${++seq}`, inquiry_id: inquiryId, kind: 'INQUIRY_REPLY_KIND_PROGRESS', body: '판매자에게 사실 확인을 요청했습니다. 조금만 기다려 주세요.', acted_by: crypto.randomUUID() });
    expect(p.res).toMatchObject({ result: 'INQUIRY_REPLY_RESULT_RECORDED', status: 'INQUIRY_STATUS_IN_PROGRESS' });
    await answer(inquiryId);
    const fan = await current!.message(current!.fanHeaders(accountId), inquiryId, { body: '추가로 궁금한 것이 있어 다시 문의드립니다. 확인 부탁드립니다.' });
    expect(fan.status).toBe(201);
    expect(current!.kit().inquiries.rows()[0]).toMatchObject({ status: 'IN_PROGRESS' });
    const a2 = await answer(inquiryId);
    expect(a2.res).toMatchObject({ status: 'INQUIRY_STATUS_ANSWERED' });
  });

  test('R-T27 [ASVS v5.0.0-2.3.2] 같은 request_id 같은 본문은 같은 기록, 다른 본문은 ALREADY_EXISTS다', async () => {
    const { inquiryId } = await open();
    const first = await call('AddInquiryReply', { request_id: 'same-req-77', inquiry_id: inquiryId, kind: 'INQUIRY_REPLY_KIND_ANSWER', body: '같은 요청 열쇠로 한 번만 남기는 답변입니다.', acted_by: crypto.randomUUID() });
    expect(first.res).toMatchObject({ result: 'INQUIRY_REPLY_RESULT_RECORDED' });
    const again = await call('AddInquiryReply', { request_id: 'same-req-77', inquiry_id: inquiryId, kind: 'INQUIRY_REPLY_KIND_ANSWER', body: '같은 요청 열쇠로 한 번만 남기는 답변입니다.', acted_by: crypto.randomUUID() });
    expect(again.res).toMatchObject({ result: 'INQUIRY_REPLY_RESULT_RECORDED' });
    expect((again.res!.message as Record<string, unknown>).message_id).toBe((first.res!.message as Record<string, unknown>).message_id);
    expect(current!.kit().inquiries.messages().filter((m) => m.kind === 'ANSWER')).toHaveLength(1);
    const other = await call('AddInquiryReply', { request_id: 'same-req-77', inquiry_id: inquiryId, kind: 'INQUIRY_REPLY_KIND_ANSWER', body: '같은 열쇠에 다른 본문을 보내는 시험입니다.', acted_by: crypto.randomUUID() });
    expect(other.err?.code).toBe(grpc.status.ALREADY_EXISTS);
  });

  test('R-T27 ⑤ [ASVS v5.0.0-2.3.1] 닫힌 문의에는 답변하지 않고 INQUIRY_CLOSED를 주며 기록이 늘지 않는다', async () => {
    const { inquiryId } = await open();
    const closed = await call('CloseInquiry', { request_id: 'close-1', inquiry_id: inquiryId, acted_by: crypto.randomUUID() });
    expect(closed.res).toMatchObject({ status: 'INQUIRY_STATUS_CLOSED' });
    const before = current!.kit().inquiries.messages().length;
    const r = await answer(inquiryId);
    expect(r.res).toMatchObject({ result: 'INQUIRY_REPLY_RESULT_INQUIRY_CLOSED', status: 'INQUIRY_STATUS_CLOSED' });
    expect(current!.kit().inquiries.messages()).toHaveLength(before);
  });

  test('R-T27 ⑤ [ASVS v5.0.0-14.2.7] 답변 뒤 14일이 지나면 배경 작업이 닫고 purge_at을 3년 뒤로 쓴다', async () => {
    const { inquiryId } = await open();
    await answer(inquiryId);
    const justBefore = await current!.tick(current!.clock.now() + 14 * 86_400_000 - 1);
    expect(justBefore).toBe(0);
    const closed = await current!.tick(current!.clock.now() + 14 * 86_400_000 + 1);
    expect(closed).toBe(1);
    const row = current!.kit().inquiries.rows()[0]!;
    expect(row.status).toBe('CLOSED');
    expect(row.purgeAtMs).toBe(addYears(row.closedAtMs!, 3));
    const fan = await current!.message(current!.fanHeaders(crypto.randomUUID()), inquiryId, { body: '닫힌 문의에 다시 글을 남겨 보는 시험 본문입니다.' });
    expect(fan.status).toBe(404);
  });

  test('R-T27 [ASVS v5.0.0-1.1.1] 답변 본문은 NFC 정규화하고 2,000/2,001 grapheme 경계를 지킨다', async () => {
    const { inquiryId } = await open();
    const nfd = 'e\u0301'.repeat(10);
    const ok = await answer(inquiryId, nfd);
    expect(ok.res).toMatchObject({ result: 'INQUIRY_REPLY_RESULT_RECORDED' });
    expect(current!.kit().inquiries.messages().find((m) => m.kind === 'ANSWER')!.body).toBe('é'.repeat(10));
    const tooLong = await answer(inquiryId, '가'.repeat(2001));
    expect(tooLong.err?.code).toBe(grpc.status.INVALID_ARGUMENT);
    const empty = await answer(inquiryId, '   ');
    expect(empty.err?.code).toBe(grpc.status.INVALID_ARGUMENT);
  });

  test('R-T27 [ASVS v5.0.0-16.5.2] 팬 알림이 실패해도 답변은 남고 기록이 늘어난다', async () => {
    const first = current!;
    await first.close();
    const h2 = await inquiryHarness({ notifyFails: true });
    current = h2;
    const { inquiryId } = await open(h2);
    const r = await answer(inquiryId);
    expect(r.res).toMatchObject({ result: 'INQUIRY_REPLY_RESULT_RECORDED', status: 'INQUIRY_STATUS_ANSWERED' });
    expect(h2.kit().inquiries.messages().filter((m) => m.kind === 'ANSWER')).toHaveLength(1);
    expect(h2.notices).toHaveLength(0);
  });

  test('R-T27 [ASVS v5.0.0-16.5.3] 답변 저장 실패에는 INTERNAL이고 반쪽 행이 없다', async () => {
    const { inquiryId } = await open();
    current!.kit().inquiries.failNext('saveReply');
    const failed = await answer(inquiryId);
    expect(failed.err?.code).toBe(grpc.status.INTERNAL);
    expect(current!.kit().inquiries.messages().filter((m) => m.kind === 'ANSWER')).toHaveLength(0);
    expect(current!.kit().inquiries.rows()[0]).toMatchObject({ status: 'RECEIVED' });
    const ok = await answer(inquiryId);
    expect(ok.res).toMatchObject({ result: 'INQUIRY_REPLY_RESULT_RECORDED' });
  });

  test('R-T27 [ASVS v5.0.0-16.5.3] CloseInquiry 저장 실패에는 INTERNAL이고 상태가 그대로다', async () => {
    const { inquiryId } = await open();
    current!.kit().inquiries.failNext('saveClose');
    const failed = await call('CloseInquiry', { request_id: 'close-fail', inquiry_id: inquiryId, acted_by: crypto.randomUUID() });
    expect(failed.err?.code).toBe(grpc.status.INTERNAL);
    expect(current!.kit().inquiries.rows()[0]).toMatchObject({ status: 'RECEIVED', closedAtMs: null });
    const ok = await call('CloseInquiry', { request_id: 'close-ok', inquiry_id: inquiryId, acted_by: crypto.randomUUID() });
    expect(ok.res).toMatchObject({ status: 'INQUIRY_STATUS_CLOSED' });
    expect(tsOf((ok.res as Record<string, unknown>).closed_at)).toBe(current!.clock.now());
    expect(current!.kit().inquiries.rows()[0]!.closedAtMs).toBe(current!.clock.now());
  });
});
