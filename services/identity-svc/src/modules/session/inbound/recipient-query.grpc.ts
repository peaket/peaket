// BAT-455 받는 층: gRPC RecipientQueryService(identity.proto, notify §2.1 E6, N-T24).
// F-05-11: 양도 받는 사람 찾기 ResolvePhone과 가린 닉네임 BatchGetNicknames를 더한다(docs/features/transfer-refund.md §4).
// 부르는 쪽은 core-svc 팬 알림 발송 워커와 ticket-svc다. 읽기라 멱등 키가 없다.
import * as grpc from '@grpc/grpc-js';
import { verifyInternalGrpcActor } from '@peaket/platform';
import type { GetRecipients, RecipientsProblem } from '../application/get-recipients.js';

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const STATUS: Record<string, string> = {
  ACTIVE: 'RECIPIENT_STATUS_ACTIVE',
  WITHDRAWAL_PENDING: 'RECIPIENT_STATUS_WITHDRAWAL_PENDING',
  MERGED: 'RECIPIENT_STATUS_MERGED',
  DELETED: 'RECIPIENT_STATUS_DELETED',
  NOT_FOUND: 'RECIPIENT_STATUS_NOT_FOUND',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NICKNAME_BATCH_MAX = 500;

/** 숫자만 남기고 +82를 0으로 맞춘다. 모양이 틀리면 undefined(ticket-svc의 규칙과 같다) */
export function normalizePhoneDigits(raw: string): string | undefined {
  let digits = raw.replace(/[^0-9]/g, '');
  if (digits.startsWith('82')) digits = `0${digits.slice(2)}`;
  return /^01[016789][0-9]{7,8}$/.test(digits) ? digits : undefined;
}

export interface RecipientQueryUseCases {
  /** core-svc 알림 발송 워커의 받는 사람 조회(기존) */
  readonly recipients?: Pick<GetRecipients, 'run'>;
  /** 숫자만 남긴 휴대폰 번호 → ACTIVE 계정. 없으면 undefined */
  readonly resolvePhone?: (phoneDigits: string) => Promise<{ readonly accountId: string; readonly nickname: string } | undefined>;
  /** 계정 ID 여럿의 ACTIVE 닉네임만 */
  readonly resolveNicknames?: (accountIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
}

export function recipientQueryHandlers(uc: RecipientQueryUseCases, onError?: (method: string, err: unknown) => void, o?: { readonly internalToken?: string }): grpc.UntypedServiceImplementation {
  const handlers: grpc.UntypedServiceImplementation = {};
  /** 내부 토큰이 설정된 조립은 정해진 호출자만 받는다. 없으면 local·ci 시험 조립이라 통과한다 */
  const allowed = (call: grpc.ServerUnaryCall<Req, Req>, caller: string, cb: grpc.sendUnaryData<Req>): boolean => {
    if (!o?.internalToken) return true;
    const v = verifyInternalGrpcActor(call.metadata ?? new grpc.Metadata(), o.internalToken, { caller });
    if (v.ok) return true;
    cb({ code: v.reason === 'token' ? grpc.status.UNAUTHENTICATED : grpc.status.PERMISSION_DENIED, details: '부를 수 없는 호출자다' });
    return false;
  };
  if (uc.recipients) {
    handlers.BatchGetRecipients = (call: grpc.ServerUnaryCall<Req, object>, cb: grpc.sendUnaryData<object>) => {
      if (o?.internalToken) {
        const v = verifyInternalGrpcActor(call.metadata ?? new grpc.Metadata(), o.internalToken, { caller: 'core-svc' });
        if (!v.ok) {
          cb({ code: v.reason === 'token' ? grpc.status.UNAUTHENTICATED : grpc.status.PERMISSION_DENIED, details: '부를 수 없는 호출자다' });
          return;
        }
      }
      const ids = Array.isArray(call.request.account_ids) ? (call.request.account_ids as unknown[]).map(text) : [];
      uc.recipients!
        .run({ accountIds: ids, includeEmail: call.request.include_email === true })
        .then(
          (rows) =>
            cb(null, {
              recipients: rows.map((r) => ({
                account_id: r.accountId,
                status: STATUS[r.status] ?? 'RECIPIENT_STATUS_NOT_FOUND',
                verified: r.verified,
                locale: r.locale,
                ...(r.email === undefined ? {} : { email: r.email ?? '' }),
              })),
            }),
          (err: unknown) => {
            onError?.('BatchGetRecipients', err);
            const code = (err as RecipientsProblem | undefined)?.code === 'INVALID_ARGUMENT' ? grpc.status.INVALID_ARGUMENT : grpc.status.INTERNAL;
            cb({ code, details: code === grpc.status.INVALID_ARGUMENT ? '받는 사람 요청이 올바르지 않습니다' : '처리하지 못했다' });
          },
        );
    };
  }
  if (uc.resolvePhone) {
    handlers.ResolvePhone = (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      if (!allowed(call, 'ticket-svc', cb)) return;
      const digits = normalizePhoneDigits(text(call.request.phone_number));
      if (digits === undefined) {
        cb({ code: grpc.status.INVALID_ARGUMENT, details: '휴대폰 번호 모양이 올바르지 않습니다' });
        return;
      }
      uc.resolvePhone!(digits).then(
        (r) => cb(null, r === undefined ? { found: false } : { found: true, account_id: r.accountId, nickname: r.nickname }),
        (err: unknown) => {
          onError?.('ResolvePhone', err);
          // 번호 원문·계정 정보를 오류 글에 싣지 않는다
          cb({ code: grpc.status.INTERNAL, details: '휴대폰 번호를 찾지 못했습니다' });
        },
      );
    };
  }
  if (uc.resolveNicknames) {
    handlers.BatchGetNicknames = (call: grpc.ServerUnaryCall<Req, Req>, cb: grpc.sendUnaryData<Req>) => {
      if (!allowed(call, 'ticket-svc', cb)) return;
      const raw = Array.isArray(call.request.account_ids) ? (call.request.account_ids as unknown[]).map(text) : [];
      if (raw.length === 0 || raw.length > NICKNAME_BATCH_MAX) {
        cb({ code: grpc.status.INVALID_ARGUMENT, details: `계정 ID는 1~${NICKNAME_BATCH_MAX}개여야 합니다` });
        return;
      }
      const ids = [...new Set(raw.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()))];
      if (ids.length === 0) {
        cb(null, { recipients: [] });
        return;
      }
      uc.resolveNicknames!(ids).then(
        (found) => cb(null, { recipients: ids.flatMap((id) => (found.has(id) ? [{ account_id: id, nickname: found.get(id)! }] : [])) }),
        (err: unknown) => {
          onError?.('BatchGetNicknames', err);
          cb({ code: grpc.status.INTERNAL, details: '닉네임을 찾지 못했습니다' });
        },
      );
    };
  }
  return handlers;
}
