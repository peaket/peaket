// 예매 제한 gRPC 사본 보내기(F-06-4). queue-svc·purchase-svc BookingRestrictionService와 core-svc BookingRestrictionViewService.
// 부르는 쪽은 ops-svc 하나이고(메시 L7 허용 목록), 내부 토큰과 x-peaket-caller: ops-svc를 싣는다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { coreV1Core, purchaseV1Account, queueV1Queue } from '@peaket/contracts/proto';
import type { RestrictionCopyInput } from '../domain/booking-restriction.js';
import type { RestrictionCopies } from '../domain/ports.js';

const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Def = Parameters<typeof protoLoader.fromJSON>[0];
type Ctor = grpc.ServiceClientConstructor;
const load = (desc: unknown) => grpc.loadPackageDefinition(protoLoader.fromJSON(desc as Def, OPTIONS)) as unknown as Record<string, Record<string, Record<string, Ctor>>>;

const qPkg = (load(queueV1Queue) as unknown as { peaket: { queue: { v1: Record<string, Ctor> } } }).peaket.queue.v1;
const pPkg = (load(purchaseV1Account) as unknown as { peaket: { purchase: { v1: Record<string, Ctor> } } }).peaket.purchase.v1;
const cPkg = (load(coreV1Core) as unknown as { peaket: { core: { v1: Record<string, Ctor> } } }).peaket.core.v1;

const ts = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });
const stateOf = (state: 'ACTIVE' | 'LIFTED') => (state === 'ACTIVE' ? 'BOOKING_RESTRICTION_STATE_ACTIVE' : 'BOOKING_RESTRICTION_STATE_LIFTED');
const viewStateOf = (state: 'ACTIVE' | 'LIFTED') => (state === 'ACTIVE' ? 'BOOKING_RESTRICTION_VIEW_STATE_ACTIVE' : 'BOOKING_RESTRICTION_VIEW_STATE_LIFTED');

const metadata = (token: string) => {
  const md = new grpc.Metadata();
  md.set('x-peaket-internal-token', token);
  md.set('x-peaket-caller', 'ops-svc');
  return md;
};

const call = (client: grpc.Client, method: string, req: Record<string, unknown>, token: string) =>
  new Promise<{ changed: boolean }>((resolve, reject) => {
    (client as unknown as Record<string, (r: unknown, m: grpc.Metadata, cb: (e: unknown, v?: unknown) => void) => void>)[method]!(req, metadata(token), (e, v) => {
      if (e) return reject(e);
      resolve({ changed: Boolean((v as { changed?: unknown } | undefined)?.changed) });
    });
  });

export interface GrpcRestrictionCopiesOptions {
  readonly queueUrl: string;
  readonly purchaseUrl: string;
  readonly coreUrl: string;
  readonly token: string;
  readonly deadlineMs?: number;
}

export function grpcRestrictionCopies(o: GrpcRestrictionCopiesOptions): RestrictionCopies & { close(): void } {
  const creds = grpc.credentials.createInsecure();
  const deadline = o.deadlineMs ?? 1_000;
  const make = (url: string, service: Ctor) => new service(url, creds);
  const queue = make(o.queueUrl, qPkg.BookingRestrictionService!) as grpc.Client;
  const purchase = make(o.purchaseUrl, pPkg.BookingRestrictionService!) as grpc.Client;
  const view = make(o.coreUrl, cPkg.BookingRestrictionViewService!) as grpc.Client;
  const withDeadline = (p: Promise<{ changed: boolean }>) =>
    new Promise<{ changed: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('restriction-copy-timeout')), deadline);
      p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
  const base = (i: RestrictionCopyInput) => ({
    account_id: i.accountId,
    restriction_id: i.restrictionId,
    state: stateOf(i.state),
    version: i.version,
    ...(i.endsAtMs !== undefined ? { ends_at: ts(i.endsAtMs) } : {}),
  });
  return {
    queue: (i) => withDeadline(call(queue, 'SetBookingRestriction', base(i), o.token)),
    purchase: (i) => withDeadline(call(purchase, 'SetBookingRestriction', base(i), o.token)),
    view: (i) =>
      withDeadline(
        call(view, 'SetBookingRestrictionView', {
          ...base(i),
          state: viewStateOf(i.state),
          reason_code: i.reasonCode,
          ...(i.startsAtMs !== undefined ? { starts_at: ts(i.startsAtMs) } : {}),
          ...(i.appealDueAtMs !== undefined ? { appeal_due_at: ts(i.appealDueAtMs) } : {}),
        }, o.token),
      ),
    close: () => {
      queue.close();
      purchase.close();
      view.close();
    },
  };
}
