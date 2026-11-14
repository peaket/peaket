// 받는 층: gRPC BookingRestrictionService(purchase account.proto, docs/features/payment.md §2, Q-T59).
// 부르는 쪽은 ops-svc만이고, 신원 확인은 메시 웨이포인트의 L7 허용 목록이 한다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Account } from '@peaket/contracts/proto';
import { OrderSeatStoreUnavailable, type BookingRestrictionApply, type BookingRestrictions } from '../domain/ports.js';

export interface BookingRestrictionPackage {
  BookingRestrictionService: grpc.ServiceClientConstructor;
}
const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
let pkg: BookingRestrictionPackage | undefined;
export function bookingRestrictionPackage(): BookingRestrictionPackage {
  if (!pkg) {
    const def = protoLoader.fromJSON(purchaseV1Account as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS);
    pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: BookingRestrictionPackage } } }).peaket.purchase.v1;
  }
  return pkg;
}

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);
const STATE: Readonly<Record<string, BookingRestrictionApply['state']>> = {
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
        if (err instanceof OrderSeatStoreUnavailable) return cb({ code: grpc.status.UNAVAILABLE, details: '지금 처리할 수 없다' });
        onError('SetBookingRestriction', err);
        cb({ code: grpc.status.INTERNAL, details: '처리하지 못했다' });
      },
    );
  };
  return { SetBookingRestriction };
}
