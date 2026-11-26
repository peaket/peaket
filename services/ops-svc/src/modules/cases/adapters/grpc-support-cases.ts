// ops-svc → core-svc SupportCaseService gRPC 클라이언트(F-06-5, core.proto). 내부 토큰·호출자 ops-svc를 싣는다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { coreV1Core } from '@peaket/contracts/proto';
import type { SupportCaseMessage, SupportCaseRecord, SupportCaseReplyPort } from '../domain/support-case.js';

const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Ctor = grpc.ServiceClientConstructor;
type Reply = Record<string, unknown>;
type UnaryClient = grpc.Client & Record<string, (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Reply) => void) => grpc.ClientUnaryCall>;
let pkg: { SupportCaseService: Ctor } | undefined;
const load = () => {
  pkg ??= (grpc.loadPackageDefinition(protoLoader.fromJSON(coreV1Core as never, LOAD)) as unknown as { peaket: { core: { v1: { SupportCaseService: Ctor } } } }).peaket.core.v1;
  return pkg;
};

export interface SupportCasesClientOptions {
  readonly url: string;
  readonly token?: string;
  readonly profile?: import('@peaket/platform').GrpcLbProfile;
  readonly deadlineMs?: number;
}

const tsMs = (v: unknown): number => {
  const o = v as { seconds?: number; nanos?: number } | undefined;
  return Number(o?.seconds ?? 0) * 1000 + Math.floor(Number(o?.nanos ?? 0) / 1_000_000);
};
const messageOf = (v: unknown): SupportCaseMessage => {
  const m = (v ?? {}) as Record<string, unknown>;
  return { messageId: String(m.message_id ?? ''), authorKind: String(m.author_kind ?? ''), kind: String(m.kind ?? ''), body: String(m.body ?? ''), createdAtMs: tsMs(m.created_at) };
};

export class GrpcSupportCases implements SupportCaseReplyPort {
  readonly #client: UnaryClient;
  readonly #token: string | undefined;
  readonly #deadlineMs: number;

  constructor(o: SupportCasesClientOptions) {
    const [host, port] = o.url.split(':');
    const { SupportCaseService } = load();
    this.#client = new SupportCaseService(`127.0.0.1:${port ?? '9090'}`, grpc.credentials.createInsecure(), { 'grpc.keepalive_time_ms': 30_000 }) as unknown as UnaryClient;
    void host;
    this.#token = o.token;
    this.#deadlineMs = o.deadlineMs ?? 2_000;
  }

  #call(method: string, req: object): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const md = new grpc.Metadata();
      if (this.#token) md.set('x-peaket-internal-token', this.#token);
      md.set('x-peaket-caller', 'ops-svc');
      const fn = this.#client[method]!;
      fn.call(this.#client, req, md, { deadline: Date.now() + this.#deadlineMs }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
    });
  }

  async reply(i: { requestId: string; inquiryId: string; kind: 'ANSWER' | 'PROGRESS'; body: string; actedBy: string }): Promise<{ result: 'RECORDED' | 'INQUIRY_CLOSED'; message?: SupportCaseMessage; status: string }> {
    const r = await this.#call('AddInquiryReply', {
      request_id: i.requestId,
      inquiry_id: i.inquiryId,
      kind: i.kind === 'PROGRESS' ? 'INQUIRY_REPLY_KIND_PROGRESS' : 'INQUIRY_REPLY_KIND_ANSWER',
      body: i.body,
      acted_by: i.actedBy,
    });
    const result = String(r.result ?? '');
    return result.endsWith('_INQUIRY_CLOSED') ? { result: 'INQUIRY_CLOSED', status: String(r.status ?? '') } : { result: 'RECORDED', ...(r.message ? { message: messageOf(r.message) } : {}), status: String(r.status ?? '') };
  }

  async close(i: { requestId: string; inquiryId: string; actedBy: string }): Promise<{ status: string; closedAtMs: number | null }> {
    const r = await this.#call('CloseInquiry', { request_id: i.requestId, inquiry_id: i.inquiryId, acted_by: i.actedBy });
    return { status: String(r.status ?? ''), closedAtMs: r.closed_at ? tsMs(r.closed_at) : null };
  }

  async read(inquiryId: string, actedBy: string): Promise<SupportCaseRecord | undefined> {
    try {
      const r = await this.#call('GetInquiryRecord', { inquiry_id: inquiryId, acted_by: actedBy });
      return {
        inquiryId: String(r.inquiry_id ?? inquiryId),
        accountId: String(r.account_id ?? ''),
        status: String(r.status ?? ''),
        messages: Array.isArray(r.messages) ? r.messages.map(messageOf) : [],
      };
    } catch (e) {
      if ((e as grpc.ServiceError).code === grpc.status.NOT_FOUND) return undefined;
      throw e;
    }
  }
}
