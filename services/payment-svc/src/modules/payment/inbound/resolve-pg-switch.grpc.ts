// PaymentService.ResolvePgSwitch 처리기(F-02-2 OPS-310, ADR-0366 결정 5). 부르는 쪽은 ops-svc뿐이다(메시 허용 표 deploy/platform/mesh/port-allow.yaml).
// 시작 파일이 paymentServiceHandlers의 처리기 묶음에 이 처리기를 더한다(withResolvePgSwitch). 입력 오류는 INVALID_ARGUMENT, 그 밖은 UNAVAILABLE과 고정 문구다
// (오류 글에는 SQL 문장 값이 실릴 수 있어 그대로 싣지 않는다. 시간 초과는 부르는 쪽 데드라인이 끊는다).
import type * as grpc from '@grpc/grpc-js';
import { status } from '@grpc/grpc-js';
import { MIN_CALL_REMAINING_MS, PaymentInputError } from '../domain/confirm-command.js';
import type { ResolvePgSwitch, ResolvePgSwitchAnswer } from '../application/resolve-pg-switch.js';

type Req = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 요청(proto 칸 이름) → 입력. 앞머리 PG_PROVIDER_를 뗀다 */
export function resolvePgSwitchInputOf(r: Req): { eventIds: string[]; toPg: string } {
  return { eventIds: Array.isArray(r.event_ids) ? r.event_ids.map(text) : [], toPg: text(r.to_pg).replace(/^PG_PROVIDER_/, '') };
}

/** 답 → ResolvePgSwitchResponse(proto 칸 이름) */
export function resolvePgSwitchResponseOf(a: ResolvePgSwitchAnswer): Record<string, unknown> {
  return {
    routes: a.routes.map((r) => ({ event_id: r.eventId, pg: `PG_PROVIDER_${r.pg}`, approvals_per_second: r.approvalsPerSecond })),
    approval_limits: a.approvalLimits.map((l) => ({ pg: `PG_PROVIDER_${l.pg}`, approvals_per_second: l.approvalsPerSecond })),
  };
}

const remainingMsOf = (deadline: grpc.Deadline): number => (deadline instanceof Date ? deadline.getTime() : deadline) - Date.now();

/** ResolvePgSwitch 처리기 하나를 묶음에 더한다 */
export function withResolvePgSwitch(handlers: grpc.UntypedServiceImplementation, useCase: Pick<ResolvePgSwitch, 'execute'>, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const ResolvePgSwitch: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    const remainingMs = remainingMsOf(call.getDeadline());
    if (remainingMs < MIN_CALL_REMAINING_MS) {
      cb({ code: status.DEADLINE_EXCEEDED, details: '시간 안에 처리하지 못했다' });
      return;
    }
    useCase.execute(resolvePgSwitchInputOf(call.request), { remainingMs }).then(
      (a) => cb(null, resolvePgSwitchResponseOf(a)),
      (err: unknown) => {
        if (err instanceof PaymentInputError) {
          cb({ code: status.INVALID_ARGUMENT, details: err.message });
          return;
        }
        onError('ResolvePgSwitch', err);
        cb({ code: status.UNAVAILABLE, details: '지금 처리할 수 없다' });
      },
    );
  };
  return { ...handlers, ResolvePgSwitch };
}
