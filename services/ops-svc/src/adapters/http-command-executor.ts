// 승인된 운영 명령을 실제 대상에 보내는 어댑터(BAT-465 GAT-300·R-584, BAT-425 GAT-130).
// EVENT_CANCEL은 purchase-svc 회차 취소 일괄 환불을 gRPC(refund.proto)로 시작하고, gRPC 주소가 없으면 내부 HTTP 호환 경로로 물러난다.
// EVENT_REFUND_PAUSE·EVENT_REFUND_RESUME은 같은 gRPC로 멈추고 다시 시작한다(수동 재개 경로).
// SCALE_CHANGE는 core-svc 관제 API(규모 올리기)를 부른다.
// SALE_STOP·SALE_RESUME은 purchase-svc(원본 sale_control·좌석 사본)와 queue-svc(대기열 사본)를 차례로 부르고,
// 제어 gRPC 주소가 있으면 ControlReceiver.ApplyControl(판 번호 ack)이 정본이다(ADR-0102·0123).
import type { ExternalHttpClient } from '@peaket/platform';
import type { Command, CommandExecutionActor, CommandExecutionResult } from '../modules/commands/domain/command.js';
import type { CommandExecutor } from '../modules/commands/domain/ports.js';
import type { EventRefundStarter, RefundFault, RefundKind, RefundPg } from './grpc-event-refunds.js';
import type { ControlSender } from './grpc-control-sender.js';

const FAULTS = new Set(['ORGANIZER', 'FORCE_MAJEURE', 'CONTENT_CHANGE']);
const SCALES = new Set(['LARGE', 'MEDIUM']);
const PGS = new Set(['TOSS', 'PORTONE', 'SIMULATOR']);
/** 판매 중지 사유 코드(ADR-0123 결정 2) */
const SUSPENSION_REASON_CODES = new Set(['SELLER_IDENTITY', 'LEGAL_REQUEST', 'FRAUD_SUSPECTED', 'OTHER']);

export interface HttpCommandExecutorOptions {
  readonly purchase?: Pick<ExternalHttpClient, 'request'>;
  readonly core?: Pick<ExternalHttpClient, 'request'>;
  readonly refunds?: EventRefundStarter;
  readonly queue?: Pick<ExternalHttpClient, 'request'>;
  readonly internalToken?: string;
  /** 제어 gRPC 정본(ADR-0102). 있으면 판매 중지·재개는 이 길로 보낸다 */
  readonly control?: { readonly purchase?: ControlSender; readonly queue?: ControlSender };
}

export class HttpCommandExecutor implements CommandExecutor {
  constructor(private readonly o: HttpCommandExecutorOptions) {}

  async execute(command: Command, actor: CommandExecutionActor): Promise<CommandExecutionResult> {
    if (command.type === 'EVENT_CANCEL') return this.#eventCancel(command, actor);
    if (command.type === 'EVENT_REFUND_PAUSE') return this.#eventRefundPause(command);
    if (command.type === 'EVENT_REFUND_RESUME') return this.#eventRefundResume(command);
    if (command.type === 'SCALE_CHANGE') return this.#scaleChange(command, actor);
    if (command.type === 'SALE_STOP' || command.type === 'SALE_RESUME') return this.#saleSuspension(command);
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

  /**
   * 판매 중지·재개 집행(ADR-0123). purchase-svc가 원본과 좌석 사본을 쓰고, queue-svc가 대기열 사본을 쓴다.
   * 중지는 purchase → queue(먼저 막고 대기 상태를 바꾼다), 재개는 queue → purchase(대기 상태를 먼저 열고 판매를 연다).
   * 한 곳이라도 실패하면 FAILED이고 재시도가 같은 명령 ID로 두 곳을 다시 부른다(양쪽 다 멱등).
   */
  async #saleSuspension(command: Command): Promise<CommandExecutionResult> {
    const eventId = command.params.eventId;
    if (typeof eventId !== 'string') return { status: 'FAILED', error: 'invalid-sale-suspension-params' };
    const reasonCode = command.params.reasonCode;
    if (reasonCode !== undefined && (typeof reasonCode !== 'string' || !SUSPENSION_REASON_CODES.has(reasonCode))) return { status: 'FAILED', error: 'invalid-sale-suspension-params' };
    const action = command.type === 'SALE_STOP' ? 'SUSPEND' : 'RESUME';
    if (this.o.control?.purchase && this.o.control.queue) return this.#saleSuspensionGrpc(command, action, eventId);
    if (!this.o.purchase) return { status: 'FAILED', error: 'target-not-wired' };
    if (!this.o.queue) return { status: 'FAILED', error: 'target-not-wired' };
    const suspensionRef = typeof command.params.suspensionRef === 'string' ? command.params.suspensionRef : command.commandId;
    const headers = { 'content-type': 'application/json', ...(this.o.internalToken ? { 'x-peaket-internal-token': this.o.internalToken } : {}) };
    const body = JSON.stringify({ action, commandId: command.commandId, reason: command.reason, suspensionRef });
    const path = `/internal/v1/event-sales/{eventId}/suspensions`;

    let revision: number | undefined;
    const callPurchase = async (): Promise<CommandExecutionResult | undefined> => {
      const res = await this.o.purchase!.request({ method: 'POST', path, params: { eventId }, headers, body, timeoutCapMs: 5_000 });
      if (!res.ok) return { status: 'FAILED', error: `purchase-svc sale suspension ${res.status}` };
      const parsed = await readSuspension(res);
      if (parsed) revision = parsed.revision;
      return undefined;
    };
    const callQueue = async (): Promise<CommandExecutionResult | undefined> => {
      const res = await this.o.queue!.request({ method: 'POST', path, params: { eventId }, headers, body: JSON.stringify({ action, commandId: command.commandId, reason: command.reason, ...(revision !== undefined ? { revision } : {}) }), timeoutCapMs: 5_000 });
      if (!res.ok) return { status: 'FAILED', error: `queue-svc sale suspension ${res.status}` };
      return undefined;
    };

    const order = action === 'SUSPEND' ? [callPurchase, callQueue] : [callQueue, callPurchase];
    for (const step of order) {
      const failed = await step();
      if (failed) return failed;
    }
    return { status: 'SUCCEEDED', detail: { target: 'purchase-svc+queue-svc', eventId, suspended: action === 'SUSPEND', ...(revision !== undefined ? { revision } : {}) } };
  }

  /**
   * 제어 gRPC 정본(ADR-0102). 판 번호는 명령의 마지막 변경 시각(ms)을 쓴다: 같은 범위·종류에서 늘어나기만 하면 되고,
   * 다시 실행해도 받는 쪽이 같은 판 이하를 거른다. 중지는 purchase → queue, 재개는 queue → purchase 차례다.
   * ack의 applied_version이 요청한 판보다 작으면 아직 그 파드가 적용하지 않은 것이다(FAILED, 재시도 가능).
   */
  async #saleSuspensionGrpc(command: Command, action: 'SUSPEND' | 'RESUME', eventId: string): Promise<CommandExecutionResult> {
    const version = command.updatedAtMs;
    const desiredStateJson = JSON.stringify({ suspended: action === 'SUSPEND' });
    const targets = [
      { name: 'purchase-svc', sender: this.o.control!.purchase! },
      { name: 'queue-svc', sender: this.o.control!.queue! },
    ];
    const order = action === 'SUSPEND' ? targets : [...targets].reverse();
    let applied = 0;
    for (const t of order) {
      let ack;
      try {
        ack = await t.sender.apply({ commandId: command.commandId, scope: eventId, kind: 'CONTROL_KIND_SALE_SUSPENSION', version, desiredStateJson });
      } catch (err) {
        return { status: 'FAILED', error: `control-unavailable:${t.name}:${err instanceof Error ? err.message : 'unknown'}` };
      }
      if (ack.appliedVersion < version) return { status: 'FAILED', error: `ack-pending:${t.name}:${ack.appliedVersion}` };
      applied = Math.max(applied, ack.appliedVersion);
    }
    return { status: 'SUCCEEDED', detail: { target: 'control-grpc', eventId, suspended: action === 'SUSPEND', appliedVersion: applied } };
  }
}

/** purchase-svc 답의 revision(모르는 모양이면 undefined). 답을 읽지 못해도 집행은 성공이다(판 번호는 결과 장식일 뿐이다) */
async function readSuspension(res: Response): Promise<{ revision: number } | undefined> {
  try {
    const v: unknown = await res.json();
    if (typeof v !== 'object' || v === null) return undefined;
    const revision = (v as { revision?: unknown }).revision;
    return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? { revision } : undefined;
  } catch {
    return undefined;
  }
}

const grpcCodeOf = (err: unknown): string => {
  const code = typeof err === 'object' && err !== null && 'code' in err ? Number((err as { code: unknown }).code) : undefined;
  return code !== undefined && Number.isFinite(code) ? String(code) : 'error';
};
