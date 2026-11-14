// 승인된 운영 명령을 실제 대상에 보내는 어댑터(BAT-465 GAT-300).
// EVENT_CANCEL은 purchase-svc 내부 HTTP(환급), SCALE_CHANGE는 core-svc 관제 API(규모 올리기)를 부른다.
// 판매 중지·재개는 아직 purchase-svc/queue-svc의 판매 정지 사본을 바꾸는 API가 없어 target-not-wired로 남긴다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { Command, CommandExecutionActor, CommandExecutionResult } from '../modules/commands/domain/command.js';
import type { CommandExecutor } from '../modules/commands/domain/ports.js';

const FAULTS = new Set(['ORGANIZER', 'FORCE_MAJEURE', 'CONTENT_CHANGE']);
const SCALES = new Set(['LARGE', 'MEDIUM']);

export interface HttpCommandExecutorOptions {
  readonly purchase?: Pick<ExternalHttpClient, 'request'>;
  readonly core?: Pick<ExternalHttpClient, 'request'>;
  readonly internalToken?: string;
}

export class HttpCommandExecutor implements CommandExecutor {
  constructor(private readonly o: HttpCommandExecutorOptions) {}

  async execute(command: Command, actor: CommandExecutionActor): Promise<CommandExecutionResult> {
    if (command.type === 'EVENT_CANCEL') return this.#eventCancel(command, actor);
    if (command.type === 'SCALE_CHANGE') return this.#scaleChange(command, actor);
    return { status: 'FAILED', error: 'target-not-wired' };
  }

  async #eventCancel(command: Command, actor: CommandExecutionActor): Promise<CommandExecutionResult> {
    if (!this.o.purchase) return { status: 'FAILED', error: 'target-not-wired' };
    const eventId = command.params.eventId;
    const fault = command.params.fault;
    if (typeof eventId !== 'string' || typeof fault !== 'string' || !FAULTS.has(fault)) return { status: 'FAILED', error: 'invalid-event-cancel-params' };
    const confirmedBy = command.approvals[0] ?? actor.accountId;
    const fanNoticeReason = typeof command.params.fanNoticeReason === 'string' ? command.params.fanNoticeReason : undefined;
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
        ...(fanNoticeReason !== undefined ? { fanNoticeReason } : {}),
      }),
      timeoutCapMs: 30_000,
    });
    if (!res.ok) return { status: 'FAILED', error: `purchase-svc event refund ${res.status}` };
    return { status: 'SUCCEEDED', detail: { target: 'purchase-svc', status: res.status } };
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
