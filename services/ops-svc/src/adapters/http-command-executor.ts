// 승인된 운영 명령을 실제 대상에 보내는 어댑터(BAT-465 GAT-300, BAT-425 GAT-130).
// EVENT_CANCEL은 purchase-svc 회차 취소 일괄 환불을 gRPC(refund.proto)로 시작한다. gRPC 주소가 없으면 내부 HTTP 호환 경로로 물러난다.
// EVENT_REFUND_PAUSE·EVENT_REFUND_RESUME은 같은 gRPC로 멈추고 다시 시작한다(수동 재개 경로).
// SCALE_CHANGE는 core-svc 관제 API(규모 올리기)를 부른다. 판매 중지·재개는 아직 purchase-svc/queue-svc의 판매 정지 사본 API가 없어 target-not-wired로 남긴다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { Command, CommandExecutionActor, CommandExecutionResult } from '../modules/commands/domain/command.js';
import type { CommandExecutor } from '../modules/commands/domain/ports.js';
import type { EventRefundStarter, RefundFault, RefundKind, RefundPg } from './grpc-event-refunds.js';

const FAULTS = new Set(['ORGANIZER', 'FORCE_MAJEURE', 'CONTENT_CHANGE']);
const SCALES = new Set(['LARGE', 'MEDIUM']);
const PGS = new Set(['TOSS', 'PORTONE', 'SIMULATOR']);

export interface HttpCommandExecutorOptions {
  readonly purchase?: Pick<ExternalHttpClient, 'request'>;
  readonly core?: Pick<ExternalHttpClient, 'request'>;
  readonly refunds?: EventRefundStarter;
  readonly internalToken?: string;
}

export class HttpCommandExecutor implements CommandExecutor {
  constructor(private readonly o: HttpCommandExecutorOptions) {}

  async execute(command: Command, actor: CommandExecutionActor): Promise<CommandExecutionResult> {
    if (command.type === 'EVENT_CANCEL') return this.#eventCancel(command, actor);
    if (command.type === 'EVENT_REFUND_PAUSE') return this.#eventRefundPause(command);
    if (command.type === 'EVENT_REFUND_RESUME') return this.#eventRefundResume(command);
    if (command.type === 'SCALE_CHANGE') return this.#scaleChange(command, actor);
    return { status: 'FAILED', error: 'target-not-wired' };
  }

  async #eventCancel(command: Command, actor: CommandExecutionActor): Promise<CommandExecutionResult> {
    const eventId = command.params.eventId;
    const fault = command.params.fault;
    if (typeof eventId !== 'string' || typeof fault !== 'string' || !FAULTS.has(fault)) return { status: 'FAILED', error: 'invalid-event-cancel-params' };
    const confirmedBy = command.approvals[0] ?? actor.accountId;
    const fanNoticeReason = typeof command.params.fanNoticeReason === 'string' ? command.params.fanNoticeReason : undefined;
    const kind = command.params.kind === 'POSTPONE' ? ('POSTPONE' as RefundKind) : ('CANCEL' as RefundKind);
    const postponedToMs = typeof command.params.postponedToMs === 'number' ? command.params.postponedToMs : undefined;
    const refundWindowClosesAtMs = typeof command.params.refundWindowClosesAtMs === 'number' ? command.params.refundWindowClosesAtMs : undefined;
    if (kind === 'POSTPONE' && postponedToMs === undefined) return { status: 'FAILED', error: 'invalid-event-cancel-params' };
    if (this.o.refunds) {
      try {
        const r = await this.o.refunds.start({
          eventId,
          requestId: command.commandId,
          fault: fault as RefundFault,
          ruledBy: command.requestedBy,
          confirmedBy,
          kind,
          ...(fanNoticeReason !== undefined ? { fanNoticeReason } : {}),
          ...(postponedToMs !== undefined ? { postponedToMs } : {}),
          ...(refundWindowClosesAtMs !== undefined ? { refundWindowClosesAtMs } : {}),
        });
        return { status: 'SUCCEEDED', detail: { target: 'purchase-svc', transport: 'grpc', jobId: r.jobId, state: r.state, ...(r.refundWindowClosesAtMs !== undefined ? { refundWindowClosesAtMs: r.refundWindowClosesAtMs } : {}) } };
      } catch (err) {
        return { status: 'FAILED', error: `purchase-svc event refund grpc ${grpcCodeOf(err)}` };
      }
    }
    if (!this.o.purchase) return { status: 'FAILED', error: 'target-not-wired' };
    const res = await this.o.purchase.request({
      method: 'POST',
      path: '/internal/v1/event-refunds',
      headers: { 'content-type': 'application/json', ...(this.o.internalToken ? { 'x-peaket-internal-token': this.o.internalToken } : {}) },
      body: JSON.stringify({
        eventId,
        requestId: command.commandId,
        fault,
        ruledBy: command.requestedBy,
        confirmedBy,
        kind,
        ...(fanNoticeReason !== undefined ? { fanNoticeReason } : {}),
        ...(postponedToMs !== undefined ? { postponedToMs } : {}),
        ...(refundWindowClosesAtMs !== undefined ? { refundWindowClosesAtMs } : {}),
      }),
      timeoutCapMs: 30_000,
    });
    if (!res.ok) return { status: 'FAILED', error: `purchase-svc event refund ${res.status}` };
    return { status: 'SUCCEEDED', detail: { target: 'purchase-svc', transport: 'http', status: res.status } };
  }

  async #eventRefundPause(command: Command): Promise<CommandExecutionResult> {
    if (!this.o.refunds) return { status: 'FAILED', error: 'target-not-wired' };
    const requestId = command.params.requestId;
    if (typeof requestId !== 'string' || requestId === '') return { status: 'FAILED', error: 'invalid-event-refund-params' };
    const pg = typeof command.params.pg === 'string' && PGS.has(command.params.pg) ? (command.params.pg as RefundPg) : undefined;
    try {
      const r = await this.o.refunds.pause({ requestId, ...(pg ? { pg } : {}), reason: command.reason });
      return { status: 'SUCCEEDED', detail: { target: 'purchase-svc', transport: 'grpc', jobId: r.jobId, state: r.state } };
    } catch (err) {
      return { status: 'FAILED', error: `purchase-svc event refund pause grpc ${grpcCodeOf(err)}` };
    }
  }

  async #eventRefundResume(command: Command): Promise<CommandExecutionResult> {
    if (!this.o.refunds) return { status: 'FAILED', error: 'target-not-wired' };
    const requestId = command.params.requestId;
    if (typeof requestId !== 'string' || requestId === '') return { status: 'FAILED', error: 'invalid-event-refund-params' };
    const pg = typeof command.params.pg === 'string' && PGS.has(command.params.pg) ? (command.params.pg as RefundPg) : undefined;
    try {
      const r = await this.o.refunds.resume({ requestId, ...(pg ? { pg } : {}), reason: command.reason });
      return { status: 'SUCCEEDED', detail: { target: 'purchase-svc', transport: 'grpc', jobId: r.jobId, state: r.state } };
    } catch (err) {
      return { status: 'FAILED', error: `purchase-svc event refund resume grpc ${grpcCodeOf(err)}` };
    }
  }

  async #scaleChange(command: Command, actor: CommandExecutionActor): Promise<CommandExecutionResult> {
    if (!this.o.core) return { status: 'FAILED', error: 'target-not-wired' };
    const eventId = command.params.eventId;
    const scale = command.params.scale;
    if (typeof eventId !== 'string' || typeof scale !== 'string' || !SCALES.has(scale)) return { status: 'FAILED', error: 'invalid-scale-change-params' };
    const res = await this.o.core.request({
      method: 'POST',
      path: '/v1/ops/events/{eventId}/scale-changes',
      params: { eventId },
      headers: {
        'content-type': 'application/json',
        'x-user-id': actor.accountId,
        'x-session-id': actor.sessionId,
        'x-user-aud': 'ops',
        'x-user-scope': '',
      },
      body: JSON.stringify({ scale, reason: command.reason, intervalException: command.params.intervalException === true }),
      timeoutCapMs: 5_000,
    });
    if (!res.ok) return { status: 'FAILED', error: `core-svc scale change ${res.status}` };
    return { status: 'SUCCEEDED', detail: { target: 'core-svc', status: res.status } };
  }
}

const grpcCodeOf = (err: unknown): string => {
  const code = typeof err === 'object' && err !== null && 'code' in err ? Number((err as { code: unknown }).code) : undefined;
  return code !== undefined && Number.isFinite(code) ? String(code) : 'error';
};
