// F-04-15 core-svc FraudAppealViewService gRPC(ops-svc → core-svc). 동결 로컬.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { coreV1Core } from '@peaket/contracts/proto';
import { INTERNAL_GRPC_CALLER_HEADER, INTERNAL_GRPC_TOKEN_HEADER } from '@peaket/platform';
import { applyFraudAppealView } from '../application/support-appeals.js';
import type { FraudAppealViews } from '../domain/ports.js';

const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const ts = (v: unknown): number | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as { seconds?: number; nanos?: number };
  return typeof o.seconds === 'number' ? o.seconds * 1_000 + Math.floor((o.nanos ?? 0) / 1_000_000) : null;
};
const stateOf = (v: unknown): string => (typeof v === 'string' ? v.replace('FRAUD_APPEAL_VIEW_STATE_', '') : 'OPEN');
const requestOf = (r: Record<string, any>): Record<string, any> => {
  const cancelled = Array.isArray(r.cancelled_ticket_ids) ? r.cancelled_ticket_ids.map(String) : [];
  const restricted = ts(r.restricted_until);
  const actionResult = cancelled.length > 0 || restricted !== null ? { cancelledTicketIds: cancelled, ...(restricted === null ? {} : { restrictedUntilMs: restricted }) } : undefined;
  return {
    accountId: r.account_id,
    caseId: r.case_id,
    eventId: r.event_id,
    party: r.party || 'PAYER',
    reasonCategories: r.reason_categories ?? [],
    dueAtMs: ts(r.due_at),
    lockedTicketIds: r.locked_ticket_ids ?? [],
    heldTicketIds: r.held_ticket_ids ?? [],
    excludedTicketIds: r.excluded_ticket_ids ?? [],
    lockActive: r.lock_active === true,
    lockExpiresAtMs: ts(r.lock_expires_at),
    state: stateOf(r.state),
    objectionDueAtMs: ts(r.objection_due_at),
    objectionState: r.objection_state || 'NONE',
    objectionNote: r.objection_note || null,
    ...(actionResult ? { actionResult } : {}),
    priorityPurchases: (r.priority_purchases ?? []).map((p: any) => ({ grantId: p.grant_id, seatLabel: p.seat_label, price: p.price, expiresAtMs: ts(p.expires_at), status: p.status })),
    version: r.version ?? 0,
    ...(r.case_status ? { caseStatus: r.case_status } : {}),
  };
};

export function startSupportGrpc(o: { port: number; token?: string; views: FraudAppealViews; now?: () => number }): grpc.Server {
  const def = protoLoader.fromJSON(coreV1Core as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS);
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { core: { v1: Record<string, any> } } }).peaket.core.v1;
  const server = new grpc.Server();
  server.addService(pkg.FraudAppealViewService.service, {
    SetFraudAppealView: (call: grpc.ServerUnaryCall<Record<string, any>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      const token = call.metadata.get(INTERNAL_GRPC_TOKEN_HEADER)[0];
      if (o.token && token !== o.token) {
        cb({ name: 'Unauthenticated', message: 'internal token', code: grpc.status.UNAUTHENTICATED } as grpc.ServiceError);
        return;
      }
      const caller = call.metadata.get(INTERNAL_GRPC_CALLER_HEADER)[0];
      if (caller && caller !== 'ops-svc') {
        cb({ name: 'PermissionDenied', message: 'caller', code: grpc.status.PERMISSION_DENIED } as grpc.ServiceError);
        return;
      }
      void applyFraudAppealView(o.views, requestOf(call.request), (o.now ?? Date.now)())
        .then(() => cb(null, {}))
        .catch((e: unknown) => cb({ name: 'Internal', message: String(e), code: grpc.status.INTERNAL } as grpc.ServiceError));
    },
  });
  server.bindAsync(`0.0.0.0:${o.port}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) throw err;
    server.start();
    void port;
  });
  return server;
}
