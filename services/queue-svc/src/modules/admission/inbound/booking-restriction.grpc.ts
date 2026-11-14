// 받는 층: gRPC BookingRestrictionService(queue.proto, docs/features/queue-admission.md §6 '예매 제한 확인', Q-T59).
// 부르는 쪽은 ops-svc만이고, 신원 확인은 메시 웨이포인트의 L7 허용 목록이 한다.
// 요청 모양이 틀리면 INVALID_ARGUMENT, 저장소에 닿지 못하면 UNAVAILABLE, 그 밖은 INTERNAL이다.
import * as grpc from '@grpc/grpc-js';
import { QueueStoreUnavailable } from '../../entry/index.js';
import type { BookingRestrictionApply, BookingRestrictionState } from '../domain/booking-restriction.js';
import type { BookingRestrictions } from '../domain/ports.js';

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);
const STATE: Readonly<Record<string, BookingRestrictionState>> = {
  BOOKING_RESTRICTION_STATE_ACTIVE: 'ACTIVE',
  BOOKING_RESTRICTION_STATE_LIFTED: 'LIFTED',
};
const ACCOUNT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function timestampMs(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object') return Number.NaN;
  const o = v as { seconds?: unknown; nanos?: unknown };
  const seconds = typeof o.seconds === 'number' ? o.seconds : Number(o.seconds);
  const nanos = o.nanos === undefined ? 0 : typeof o.nanos === 'number' ? o.nanos : Number(o.nanos);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return Number.NaN;
  if (!Number.isSafeInteger(nanos) || nanos < 0 || nanos >= 1_000_000_000) return Number.NaN;
  return seconds * 1000 + Math.floor(nanos / 1_000_000);
}

function parse(r: Req): BookingRestrictionApply {
  const state = STATE[text(r.state)];
  const accountId = text(r.account_id);
  const restrictionId = text(r.restriction_id);
  const version = int(r.version);
  const untilMs = timestampMs(r.ends_at);
  if (!state || !ACCOUNT_UUID.test(accountId) || restrictionId === '' || !Number.isSafeInteger(version) || version < 1) throw new RangeError('요청 모양이 틀렸다');
  if (untilMs !== undefined && (!Number.isSafeInteger(untilMs) || untilMs < 0)) throw new RangeError('끝 시각이 틀렸다');
  return { accountId, restrictionId, state, version, ...(untilMs !== undefined ? { untilMs } : {}) };
}

export function bookingRestrictionHandlers(store: Pick<BookingRestrictions, 'apply'>, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const SetBookingRestriction: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    let input: BookingRestrictionApply;
    try {
      input = parse(call.request);
    } catch {
      cb({ code: grpc.status.INVALID_ARGUMENT, details: '요청 모양이 틀렸다' });
      return;
    }
    store.apply(input).then(
      (x) => cb(null, { changed: x.changed }),
      (err: unknown) => {
        if (err instanceof QueueStoreUnavailable) return cb({ code: grpc.status.UNAVAILABLE, details: '지금 처리할 수 없다' });
        onError('SetBookingRestriction', err);
        cb({ code: grpc.status.INTERNAL, details: '처리하지 못했다' });
      },
    );
  };
  return { SetBookingRestriction };
}
