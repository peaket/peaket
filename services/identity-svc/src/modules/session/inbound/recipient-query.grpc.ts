// BAT-455 받는 층: gRPC RecipientQueryService.BatchGetRecipients(identity.proto, notify §2.1 E6, N-T24).
// 부르는 쪽은 core-svc 팬 알림 발송 워커(core-notify-sender) 하나다. 읽기라 멱등 키가 없다.
import * as grpc from '@grpc/grpc-js';
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

export function recipientQueryHandlers(uc: { recipients: Pick<GetRecipients, 'run'> }, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  return {
    BatchGetRecipients: (call: grpc.ServerUnaryCall<Req, object>, cb: grpc.sendUnaryData<object>) => {
      const ids = Array.isArray(call.request.account_ids) ? (call.request.account_ids as unknown[]).map(text) : [];
      uc.recipients
        .run({ accountIds: ids, includeEmail: call.request.include_email === true, includePhone: call.request.include_phone === true })
        .then(
          (rows) =>
            cb(null, {
              recipients: rows.map((r) => ({
                account_id: r.accountId,
                status: STATUS[r.status] ?? 'RECIPIENT_STATUS_NOT_FOUND',
                verified: r.verified,
                locale: r.locale,
                ...(r.email === undefined ? {} : { email: r.email ?? '' }),
                ...(r.phone === undefined ? {} : { phone: r.phone ?? '' }),
              })),
            }),
          (err: unknown) => {
            onError('BatchGetRecipients', err);
            const code = (err as RecipientsProblem | undefined)?.code === 'INVALID_ARGUMENT' ? grpc.status.INVALID_ARGUMENT : grpc.status.INTERNAL;
            cb({ code, details: code === grpc.status.INVALID_ARGUMENT ? '받는 사람 요청이 올바르지 않습니다' : '처리하지 못했다' });
          },
        );
    },
  };
}
