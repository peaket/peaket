// core-svc support 문의 gRPC(F-06-5, core.proto SupportCaseService). 부르는 쪽은 ops-svc만이고 내부 토큰·호출자를 확인한다.
import * as grpc from '@grpc/grpc-js';
import { constantTimeEqual, ProblemError } from '@peaket/platform';
import type { Inquiries } from '../application/inquiries.js';
import type { InquiryMessageRow, InquiryRow } from '../domain/inquiry.js';

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const ts = (ms: number | null): { seconds: number; nanos: number } | undefined => (ms === null ? undefined : { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });
const statusName = (s: string): string => `INQUIRY_STATUS_${s}`;
const authorName = (s: string): string => `INQUIRY_AUTHOR_KIND_${s}`;
const kindName = (s: string): string => `INQUIRY_MESSAGE_KIND_${s}`;
const replyKind = (s: string): 'ANSWER' | 'PROGRESS' => (s.endsWith('_PROGRESS') ? 'PROGRESS' : 'ANSWER');
const messageOf = (m: InquiryMessageRow) => ({ message_id: m.messageId, author_kind: authorName(m.authorKind), kind: kindName(m.kind), body: m.body, created_at: ts(m.createdAtMs) });
const recordOf = (r: InquiryRow) => ({
  inquiry_id: r.inquiryId,
  number: r.number,
  account_id: r.accountId,
  category: r.category,
  order_ref: r.orderRef ?? '',
  title: r.title,
  status: statusName(r.status),
  created_at: ts(r.createdAtMs),
  ...(r.answeredAtMs !== null ? { answered_at: ts(r.answeredAtMs) } : {}),
  ...(r.closedAtMs !== null ? { closed_at: ts(r.closedAtMs) } : {}),
});

const mapError = (err: unknown, cb: grpc.sendUnaryData<object>): void => {
  if (err instanceof ProblemError) {
    if (err.status === 404) return cb({ code: grpc.status.NOT_FOUND, details: 'inquiry not found' });
    if (err.status === 409) return cb({ code: grpc.status.ALREADY_EXISTS, details: 'inquiry conflict' });
    if (err.status === 422 || err.status === 400) return cb({ code: grpc.status.INVALID_ARGUMENT, details: 'invalid input' });
  }
  cb({ code: grpc.status.INTERNAL, details: 'inquiry store failed' });
};

export interface InquiryGrpcOptions {
  readonly inquiries: Inquiries;
  readonly internalToken?: string;
}

export function inquiryGrpcHandlers(o: InquiryGrpcOptions): grpc.UntypedServiceImplementation {
  const allowed = (metadata: grpc.Metadata): boolean => {
    if (metadata.get('x-peaket-caller')[0] !== 'ops-svc') return false;
    if (o.internalToken === undefined || o.internalToken === '') return true;
    const got = metadata.get('x-peaket-internal-token')[0];
    return typeof got === 'string' && constantTimeEqual(got, o.internalToken);
  };
  const denied = (cb: grpc.sendUnaryData<object>) => cb({ code: grpc.status.PERMISSION_DENIED, details: '내부 호출자만' });

  const GetInquiryRecord: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    if (!allowed(call.metadata)) return denied(cb);
    const id = text(call.request.inquiry_id);
    o.inquiries
      .detailAny(id)
      .then((out) => {
        if (!out) return cb({ code: grpc.status.NOT_FOUND, details: 'inquiry not found' });
        cb(null, { ...recordOf(out.row), messages: out.messages.map(messageOf) });
      }, (err) => mapError(err, cb));
  };

  const AddInquiryReply: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    if (!allowed(call.metadata)) return denied(cb);
    const inquiryId = text(call.request.inquiry_id);
    const requestId = text(call.request.request_id);
    const kind = replyKind(text(call.request.kind));
    const body = text(call.request.body);
    o.inquiries
      .recordReply(inquiryId, kind, body, requestId, `${kind}:${body}`)
      .then((out) => {
        if (out.result === 'INQUIRY_CLOSED') return cb(null, { result: 'INQUIRY_REPLY_RESULT_INQUIRY_CLOSED', status: 'INQUIRY_STATUS_CLOSED' });
        cb(null, { result: 'INQUIRY_REPLY_RESULT_RECORDED', message: out.message ? messageOf(out.message) : undefined, status: statusName(out.status) });
      }, (err) => mapError(err, cb));
  };

  const CloseInquiry: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    if (!allowed(call.metadata)) return denied(cb);
    o.inquiries
      .closeInquiry(text(call.request.inquiry_id))
      .then((out) => cb(null, { status: 'INQUIRY_STATUS_CLOSED', closed_at: ts(out.closedAtMs) }), (err) => mapError(err, cb));
  };

  return { GetInquiryRecord, AddInquiryReply, CloseInquiry };
}
