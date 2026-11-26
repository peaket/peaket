// F-06-5 ops-svc CS 문의 답변 시험 공용 도우미(시험 담당 lane2-freeze-F-06-5-opencode).
// core-svc SupportCaseService를 정본 설명자로 띄운 **실제 gRPC 서버**로 두고, 시작 조립과 같은 supportCasePortsFromEnv(env)로 만든
// 실제 gRPC 클라이언트를 AppModule.register({ memory:true, supportCases })에 넣는다. 구현 전에는 조립 파일이 없어 포트가 비고
// 답변 경로가 404로 끝난다(시험은 행동으로 실패한다).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { coreV1Core } from '@peaket/contracts/proto';
import { startGrpcServer, type StartedGrpcServer } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { StubService } from './cs-appeal-support.js';
import { csHarness, type CsHarness } from './cs-support.js';

const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Def = Parameters<typeof protoLoader.fromJSON>[0];
const pkg = (grpc.loadPackageDefinition(protoLoader.fromJSON(coreV1Core as Def, LOAD)) as unknown as {
  peaket: { core: { v1: { SupportCaseService: grpc.ServiceClientConstructor } } };
}).peaket.core.v1;

export const INTERNAL = 'support-case-internal-token-0000';
const METHODS = ['GetInquiryRecord', 'AddInquiryReply', 'CloseInquiry'] as const;

const ts = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });
export const INQUIRY_ID = '0194f065-0000-7000-8000-0000000000a1';
export const ACCOUNT_ID = '0194f065-0000-7000-8000-0000000000a2';

/** 문의 기록 하나(core.proto GetInquiryRecordResponse 모양). 시험이 값을 바꿔 끼운다 */
export function inquiryRecord(o: { status?: string; body?: string; messages?: Array<{ author: string; kind: string; body: string }> } = {}) {
  const now = Date.parse('2026-11-20T14:30:00.000Z');
  return {
    inquiry_id: INQUIRY_ID,
    number: 'Q-2611-0042',
    account_id: ACCOUNT_ID,
    category: 'MERCH',
    order_ref: 'ord-20261018-0010',
    title: '응원봉 배송 예정일이 궁금합니다',
    status: o.status ?? 'INQUIRY_STATUS_RECEIVED',
    created_at: ts(now),
    messages: (o.messages ?? [{ author: 'INQUIRY_AUTHOR_KIND_FAN', kind: 'INQUIRY_MESSAGE_KIND_MESSAGE', body: o.body ?? '응원봉 배송 예정일이 언제인지 알고 싶습니다.' }]).map((m, i) => ({
      message_id: `0194f065-0000-7000-8000-00000000b${String(i).padStart(3, '0')}`,
      author_kind: m.author,
      kind: m.kind,
      body: m.body,
      created_at: ts(now + i * 1000),
    })),
  };
}

export interface SupportCaseHarness {
  readonly h: CsHarness;
  readonly stub: StubService;
  readonly calls: StubService['calls'];
  /** 답변 POST */
  reply(hdrs: Record<string, string>, caseId: string, body: unknown, key?: string): Promise<{ status: number; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

export async function supportCaseHarness(o: { record?: Record<string, unknown>; replyAnswer?: () => Record<string, unknown> } = {}): Promise<SupportCaseHarness> {
  const stub = new StubService({
    GetInquiryRecord: () => ({ value: o.record ?? inquiryRecord() }),
    AddInquiryReply: (req) => ({
      value: o.replyAnswer?.() ?? {
        result: 'INQUIRY_REPLY_RESULT_RECORDED',
        status: 'INQUIRY_STATUS_ANSWERED',
        message: {
          message_id: randomUUID(),
          author_kind: 'INQUIRY_AUTHOR_KIND_AGENT',
          kind: req.kind === 'INQUIRY_REPLY_KIND_PROGRESS' ? 'INQUIRY_MESSAGE_KIND_PROGRESS' : 'INQUIRY_MESSAGE_KIND_ANSWER',
          body: req.body,
          created_at: ts(Date.parse('2026-11-20T15:00:00.000Z')),
        },
      },
    }),
    CloseInquiry: () => ({ value: { status: 'INQUIRY_STATUS_CLOSED', closed_at: ts(Date.parse('2026-11-20T15:10:00.000Z')) } }),
  });
  const server: StartedGrpcServer = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    profile: 'service',
    drainMs: 0,
    services: [{ definition: pkg.SupportCaseService.service, handlers: stub.handlers([...METHODS]) }],
  });
  let ports: unknown;
  try {
    const spec = '../src/support-case-wiring.js';
    const mod = (await import(/* @vite-ignore */ spec)) as { supportCasePortsFromEnv(env: Record<string, string>): unknown };
    ports = mod.supportCasePortsFromEnv({ PEAKET_ENV: 'ci', PEAKET_CORE_GRPC_URL: `127.0.0.1:${server.port}`, PEAKET_INTERNAL_TOKEN: INTERNAL });
  } catch (err) {
    if (!(err instanceof Error) || !/Cannot find module|Failed to load url|ERR_MODULE_NOT_FOUND|Does the file exist/i.test(err.message)) throw err;
    ports = undefined;
  }
  const h = await csHarness({ supportCases: ports });
  return {
    h,
    stub,
    calls: stub.calls,
    async reply(hdrs, caseId, body, key = `reply-${randomUUID()}`) {
      const r = await h.svc.http.inject({ method: 'POST', url: `/v1/ops/cases/${caseId}/replies`, headers: { ...hdrs, 'content-type': 'application/json', 'idempotency-key': key }, payload: JSON.stringify(body) });
      return { status: r.statusCode, body: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : {} };
    },
    async close() {
      await h.close();
      await server.close();
    },
  };
}
