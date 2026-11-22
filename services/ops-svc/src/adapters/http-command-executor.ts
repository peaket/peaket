// 승인된 운영 명령을 실제 대상에 보내는 어댑터(BAT-465 GAT-300·R-584, BAT-425 GAT-130).
// EVENT_CANCEL은 purchase-svc 회차 취소 일괄 환불을 gRPC(refund.proto)로 시작하고, gRPC 주소가 없으면 내부 HTTP 호환 경로로 물러난다.
// EVENT_REFUND_PAUSE·EVENT_REFUND_RESUME은 같은 gRPC로 멈추고 다시 시작한다(수동 재개 경로).
// SCALE_CHANGE는 core-svc 관제 API(규모 올리기)를 부른다.
// SALE_STOP·SALE_RESUME은 purchase-svc(원본 sale_control·좌석 사본)와 queue-svc(대기열 사본)를 차례로 부르고,
// 제어 gRPC 주소가 있으면 ControlReceiver.ApplyControl(판 번호 ack)이 정본이다(ADR-0102·0123).
import type { ExternalHttpClient } from '@peaket/platform';
import type { Command, CommandExecutionActor, CommandExecutionResult } from '../modules/commands/domain/command.js';
import type { CommandExecutor, ControlDeliverer } from '../modules/commands/domain/ports.js';
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
  /** 제어 gRPC 정본(ADR-0102). 있으면 판매 중지·재개는 이 길로 보낸다(주소 하나씩의 옛 길) */
  readonly control?: { readonly purchase?: ControlSender; readonly queue?: ControlSender };
  /**
   * 제어 gRPC 퍼뜨리기(F-02-1, ADR-0365 결정 3·4). 있으면 판매 중지·재개를 원장 판으로 준비된 모든 파드에 보내고 ack를 기다린다(control보다 먼저).
   * 차례(중지 purchase → queue, 재개 반대)는 그대로다(ADR-0123)
   */
  readonly controlDelivery?: ControlDeliverer;
  /** 지금 시각(퍼뜨리기의 시작 시각). 없으면 Date.now */
  readonly nowMs?: () => number;
  /**
   * core-svc 공연 판매 승인 상태까지 바꿀지(BAT-620). 기본 참(core가 있을 때).
   * 회차 취소 확정의 판매 멈춤 어댑터는 회차 하나만 멈추므로 `withoutCoreSaleReview()`로 끈다.
   */
  readonly coreSaleReview?: boolean;
}

export class HttpCommandExecutor implements CommandExecutor {
  constructor(private readonly o: HttpCommandExecutorOptions) {}

  /** 회차 취소 확정의 판매 멈춤처럼 회차 하나만 멈추는 길: core 공연 상태는 건드리지 않는다 */
  withoutCoreSaleReview(): HttpCommandExecutor {
    return new HttpCommandExecutor({ ...this.o, coreSaleReview: false });
  }

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
   * 판매 중지·재개 집행(ADR-0123). core-svc가 있으면 공연 판매 승인 상태(검색·홈)까지 함께 바꾼다(BAT-620).
   * 중지는 회차 목록을 먼저 받아 모든 회차의 판매를 막은 뒤 core 공연 상태를 내리고, 재개는 core를 먼저 올린 뒤
   * core가 준 '다시 열 회차'만 대기열 → 판매 차례로 연다(ADR-0123 결정 3·5). core가 없으면 purchase·queue만 부른다
   * (회차 취소 확정의 판매 멈춤 어댑터는 `withoutCoreSaleReview()`로 core를 뺀다).
   * 한 곳이라도 실패하면 FAILED이고 재시도가 같은 명령 ID로 다시 부른다(양쪽 다 멱등).
   */
  async #saleSuspension(command: Command): Promise<CommandExecutionResult> {
    const eventId = command.params.eventId;
    if (typeof eventId !== 'string') return { status: 'FAILED', error: 'invalid-sale-suspension-params' };
    const reasonCode = command.params.reasonCode;
    if (reasonCode !== undefined && (typeof reasonCode !== 'string' || !SUSPENSION_REASON_CODES.has(reasonCode))) return { status: 'FAILED', error: 'invalid-sale-suspension-params' };
    const action = command.type === 'SALE_STOP' ? 'SUSPEND' : 'RESUME';
    const coreEnabled = this.o.core !== undefined && this.o.coreSaleReview !== false;
    // core가 공연 상태를 내릴 때는 사유 코드가 꼭 있어야 한다(ADR-0123 결정 2). 없으면 아무것도 막기 전에 실패한다
    if (coreEnabled && action === 'SUSPEND' && reasonCode === undefined) return { status: 'FAILED', error: 'invalid-sale-suspension-params' };
    const approvalId = typeof command.params.suspensionRef === 'string' ? command.params.suspensionRef : command.commandId;

    const useFanout = this.o.controlDelivery !== undefined;
    const useGrpc = useFanout || (this.o.control?.purchase !== undefined && this.o.control.queue !== undefined);
    const useHttp = this.o.purchase !== undefined && this.o.queue !== undefined;
    if (!useGrpc && !useHttp) return { status: 'FAILED', error: 'target-not-wired' };
    const transport = useGrpc ? 'control-grpc' : 'purchase-svc+queue-svc';
    const apply = (id: string) => (useFanout ? this.#applyControlFanout(command, action, id) : useGrpc ? this.#applyControlGrpc(command, action, id) : this.#applyControlHttp(command, action, id));

    if (action === 'SUSPEND') {
      const scope = coreEnabled ? await this.#coreScope(eventId) : undefined;
      if (scope && 'error' in scope) return { status: 'FAILED', error: scope.error };
      const eventIds = scope?.eventIds ?? [eventId];
      let revision: number | undefined;
      for (const id of eventIds) {
        const r = await apply(id);
        if (!r.ok) return { status: 'FAILED', error: r.error };
        if (r.revision !== undefined) revision = r.revision;
      }
      if (!coreEnabled) {
        return { status: 'SUCCEEDED', detail: { target: transport, eventId, suspended: true, ...(revision !== undefined ? { revision } : {}) } };
      }
      const res = await this.#coreResult(eventId, 'SUSPENDED', approvalId, command.reason, reasonCode);
      if ('error' in res) return { status: 'FAILED', error: res.error };
      // 확인과 커밋 사이에 더한 회차가 있으면 그 회차도 막는다(공개를 내리기 전에)
      for (const id of res.eventIds) {
        if (eventIds.includes(id)) continue;
        const r = await apply(id);
        if (!r.ok) return { status: 'FAILED', error: r.error };
        if (r.revision !== undefined) revision = r.revision;
      }
      return { status: 'SUCCEEDED', detail: { target: `${transport}+core-svc`, eventIds: res.eventIds, suspended: true, ...(revision !== undefined ? { revision } : {}) } };
    }

    if (coreEnabled) {
      const res = await this.#coreResult(eventId, 'RESUMED', approvalId, command.reason);
      if ('error' in res) return { status: 'FAILED', error: res.error };
      let revision: number | undefined;
      // 오픈 시각이 지난 회차는 core가 다시 열 목록에 넣지 않는다(ADR-0123 결정 5)
      for (const id of res.resumeEventIds) {
        const r = await apply(id);
        if (!r.ok) return { status: 'FAILED', error: r.error };
        if (r.revision !== undefined) revision = r.revision;
      }
      return { status: 'SUCCEEDED', detail: { target: `${transport}+core-svc`, eventIds: res.resumeEventIds, suspended: false, ...(revision !== undefined ? { revision } : {}) } };
    }
    const r = await apply(eventId);
    if (!r.ok) return { status: 'FAILED', error: r.error };
    return { status: 'SUCCEEDED', detail: { target: transport, eventId, suspended: false, ...(r.revision !== undefined ? { revision: r.revision } : {}) } };
  }

  /**
   * 회차 하나의 제어 gRPC 퍼뜨리기(F-02-1, ADR-0365 결정 1·4): 판은 원장이 DISPATCHED 때 매긴 판(없으면 명령 기록의 바뀐 시각)이고,
   * 받는 쪽 서비스마다 준비된 모든 파드가 판 이상을 답해야 다음 서비스로 간다. 중지는 purchase → queue, 재개는 queue → purchase다
   */
  async #applyControlFanout(command: Command, action: 'SUSPEND' | 'RESUME', eventId: string): Promise<{ ok: true; revision: number } | { ok: false; error: string }> {
    const version = command.controlVersion ?? command.updatedAtMs;
    const desiredStateJson = JSON.stringify({ suspended: action === 'SUSPEND' });
    const services = action === 'SUSPEND' ? (['purchase-svc', 'queue-svc'] as const) : (['queue-svc', 'purchase-svc'] as const);
    for (const service of services) {
      const r = await this.o.controlDelivery!.deliver({
        commandId: command.commandId,
        version,
        deliveries: [{ service, scope: eventId, kind: 'CONTROL_KIND_SALE_SUSPENSION', desiredStateJson }],
        startedAtMs: this.o.nowMs?.() ?? Date.now(),
      });
      if (!r.ok) return { ok: false, error: r.error };
    }
    return { ok: true, revision: version };
  }

  /** 회차 하나의 제어 gRPC 집행(판 번호 ack 확인, 주소 하나씩의 옛 길). 중지는 purchase → queue, 재개는 queue → purchase다 */
  async #applyControlGrpc(command: Command, action: 'SUSPEND' | 'RESUME', eventId: string): Promise<{ ok: true; revision: number } | { ok: false; error: string }> {
    // 원장 판이 있으면 그 판이다(F-02-1, ADR-0365 결정 1). 없으면 명령 기록의 바뀐 시각(R-584)
    const version = command.controlVersion ?? command.updatedAtMs;
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
        return { ok: false, error: `control-unavailable:${t.name}:${err instanceof Error ? err.message : 'unknown'}` };
      }
      if (ack.appliedVersion < version) return { ok: false, error: `ack-pending:${t.name}:${ack.appliedVersion}` };
      applied = Math.max(applied, ack.appliedVersion);
    }
    return { ok: true, revision: applied };
  }

  /** 회차 하나의 내부 HTTP 집행(중지 purchase → queue, 재개 queue → purchase) */
  async #applyControlHttp(command: Command, action: 'SUSPEND' | 'RESUME', eventId: string): Promise<{ ok: true; revision?: number } | { ok: false; error: string }> {
    const suspensionRef = typeof command.params.suspensionRef === 'string' ? command.params.suspensionRef : command.commandId;
    const headers = { 'content-type': 'application/json', ...(this.o.internalToken ? { 'x-peaket-internal-token': this.o.internalToken } : {}) };
    const body = JSON.stringify({ action, commandId: command.commandId, reason: command.reason, suspensionRef });
    const path = `/internal/v1/event-sales/{eventId}/suspensions`;
    let revision: number | undefined;
    const callPurchase = async (): Promise<{ ok: false; error: string } | undefined> => {
      const res = await this.o.purchase!.request({ method: 'POST', path, params: { eventId }, headers, body, timeoutCapMs: 5_000 });
      if (!res.ok) return { ok: false, error: `purchase-svc sale suspension ${res.status}` };
      const parsed = await readSuspension(res);
      if (parsed) revision = parsed.revision;
      return undefined;
    };
    const callQueue = async (): Promise<{ ok: false; error: string } | undefined> => {
      const res = await this.o.queue!.request({ method: 'POST', path, params: { eventId }, headers, body: JSON.stringify({ action, commandId: command.commandId, reason: command.reason, ...(revision !== undefined ? { revision } : {}) }), timeoutCapMs: 5_000 });
      if (!res.ok) return { ok: false, error: `queue-svc sale suspension ${res.status}` };
      return undefined;
    };
    const order = action === 'SUSPEND' ? [callPurchase, callQueue] : [callQueue, callPurchase];
    for (const step of order) {
      const failed = await step();
      if (failed) return failed;
    }
    return { ok: true, ...(revision !== undefined ? { revision } : {}) };
  }

  async #coreScope(eventId: string): Promise<{ eventIds: string[] } | { error: string }> {
    const res = await this.o.core!.request({
      method: 'GET',
      path: '/internal/v1/events/{eventId}/sale-review-scope',
      params: { eventId },
      headers: this.#coreHeaders(),
      timeoutCapMs: 5_000,
    });
    if (!res.ok) return { error: `core-svc sale review scope ${res.status}` };
    const body = await readCoreScope(res);
    return body ?? { error: 'core-svc sale review scope invalid' };
  }

  async #coreResult(eventId: string, kind: 'SUSPENDED' | 'RESUMED', approvalId: string, reason: string, reasonCode?: string): Promise<{ eventIds: string[]; resumeEventIds: string[] } | { error: string }> {
    const res = await this.o.core!.request({
      method: 'POST',
      path: '/internal/v1/events/{eventId}/sale-review-result',
      params: { eventId },
      headers: { ...this.#coreHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ kind, approvalId, ...(kind === 'SUSPENDED' ? { reasonCode, reason } : {}) }),
      timeoutCapMs: 5_000,
    });
    if (!res.ok) return { error: `core-svc sale review ${res.status}` };
    const body = await readCoreResult(res);
    return body ?? { error: 'core-svc sale review invalid' };
  }

  #coreHeaders(): Record<string, string> {
    return this.o.internalToken ? { 'x-peaket-internal-token': this.o.internalToken } : {};
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

/** core-svc 회차 목록 답(BAT-620). 모양이 틀리면 undefined(집행하지 않는다) */
async function readCoreScope(res: Response): Promise<{ eventIds: string[] } | undefined> {
  const v = await jsonObject(res);
  const eventIds = stringArray(v?.eventIds);
  return eventIds ? { eventIds } : undefined;
}

/** core-svc 판매 중지·재개 답(BAT-620). 모양이 틀리면 undefined(집행하지 않는다) */
async function readCoreResult(res: Response): Promise<{ eventIds: string[]; resumeEventIds: string[] } | undefined> {
  const v = await jsonObject(res);
  const eventIds = stringArray(v?.eventIds);
  const resumeEventIds = stringArray(v?.resumeEventIds);
  return eventIds && resumeEventIds ? { eventIds, resumeEventIds } : undefined;
}

async function jsonObject(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const v: unknown = await res.json();
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined;
}

const grpcCodeOf = (err: unknown): string => {
  const code = typeof err === 'object' && err !== null && 'code' in err ? Number((err as { code: unknown }).code) : undefined;
  return code !== undefined && Number.isFinite(code) ? String(code) : 'error';
};
