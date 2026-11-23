// SCR-030 명령 dry-run·보내기·승인·반려·다시 시도·되돌리기의 요청 흐름(F-03-4, OPS-390, C-T4·C-T5·C-T7 ②·C-T46 ③④).
// - 재인증(act OPS_COMMAND, control-tower §3 '위험 명령 재인증의 첫 구현')은 화면이 넘긴 reauth(act)가 대화상자로 받는다. 토큰은 그 요청 하나의
//   X-Reauth-Token에만 싣고 버린다(jti 한 번). 403 reauth-required면 새 토큰으로 한 번만 다시 보낸다(docs/frontend.md §4.1).
// - 접수는 제출(Submission) 하나에 멱등 키 하나. 네트워크 오류의 자동 다시 보내기는 api-client가 같은 키·같은 본문으로 한다.
// - 화면 막힘은 편의다(권한은 서버). 막힌 동작은 재인증·요청을 하나도 보내지 않는다.
// - 주소에는 명령 ID만, 사유·매개변수는 본문, 토큰은 머리(ASVS v5.0.0-14.2.1). 저장소·쿠키에 아무것도 쓰지 않는다(3.3.4).
import { ensureConsoleApi } from '@/shared/api';
import { reauthErrorMessage } from '@/features/admin-reauth/api';
import { commandAvailability, commandBodyOf, PHONE_BLOCKED, type CommandBody, type CommandDraft, type ConsoleLayoutKind, type ConsoleRole, type Submission } from './command-form';
import { dryRunView, type DryRunView, type RawDryRun } from './dry-run';
import { commandProblemMessage } from './problems';
import type { RawCommand } from './commands';

export type ReauthPrompt = (act: 'OPS_COMMAND') => Promise<string | null>;

/** 상세(openapi CommandState)에서 이 파일이 읽는 칸 */
export type CommandDetail = RawCommand & { dryRun?: RawDryRun | null; approvalExpiresAt?: string | null };

export type ActionResult =
  | { kind: 'done'; status: number; command: CommandDetail }
  | { kind: 'problem'; status: number; type: string; message: string }
  | { kind: 'cancelled' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'invalid' }
  | { kind: 'busy' };

export type DryRunResult = { kind: 'ok'; view: DryRunView } | Extract<ActionResult, { kind: 'problem' | 'blocked' | 'invalid' }>;

const VIEWER_BLOCKED = 'viewer는 명령을 보기만 합니다';
const REQUESTER_BLOCKED = '요청자 본인은 승인할 수 없습니다';

/** 되돌리기에 commander·재인증이 드는 명령(명령 3·6·11, openapi createOpsCommandReversion) */
const COMMANDER_REVERT = new Set(['KILL_SWITCH', 'DEGRADED_MODE', 'AUTOMATION_STOP']);
/** 상세에 dry-run 기록이 없을 때 재인증이 드는 것으로 보는 명령 */
const RISKY = new Set(['KILL_SWITCH', 'DEGRADED_MODE', 'AUTOMATION_STOP']);

const canOperate = (role: ConsoleRole) => role === 'operator' || role === 'commander';

/** 되돌리기 화면 막힘(카드의 되돌리기 단추도 이 함수로 정한다) */
export function revertAvailability(o: { role: ConsoleRole; layout: ConsoleLayoutKind; type: string | undefined }): { canRequest: boolean; reason?: string; reauth: boolean } {
  const reauth = COMMANDER_REVERT.has(o.type ?? '');
  if (o.layout === 'phone') return { canRequest: false, reason: PHONE_BLOCKED, reauth };
  if (!canOperate(o.role)) return { canRequest: false, reason: VIEWER_BLOCKED, reauth };
  if (reauth && o.role !== 'commander') {
    return { canRequest: false, reason: o.type === 'KILL_SWITCH' ? '판매 재개 요청은 commander만 할 수 있습니다' : '되돌리기는 commander만 할 수 있습니다', reauth };
  }
  return { canRequest: true, reauth };
}

/** 다시 시도에 재인증이 드는가: 접수 때 남긴 dry-run의 reauthRequired(없으면 명령 종류로) */
export function retryNeedsReauth(detail: CommandDetail): boolean {
  const recorded = detail.dryRun?.reauthRequired;
  return typeof recorded === 'boolean' ? recorded : RISKY.has(detail.type ?? '');
}

type Problemish = { status?: unknown; type?: unknown; detail?: unknown };

function toProblem(e: unknown): Extract<ActionResult, { kind: 'problem' }> {
  const p = (typeof e === 'object' && e !== null ? e : {}) as Problemish;
  const status = typeof p.status === 'number' ? p.status : 0;
  const type = typeof p.type === 'string' ? p.type : status === 0 ? 'network' : `http-${status}`;
  return { kind: 'problem', status, type, message: commandProblemMessage({ status, type, ...(typeof p.detail === 'string' ? { detail: p.detail } : {}) }) };
}

const isReauthRequired = (e: unknown) => (e as Problemish | null)?.status === 403 && (e as Problemish).type === 'reauth-required';

async function ops() {
  if (!ensureConsoleApi()) throw Object.assign(new Error('관제 API 주소가 없다'), { status: 0, type: 'config' });
  return import('@peaket/api-client/endpoints/ops');
}

export function createCommandActions(o: { role: ConsoleRole; layout: ConsoleLayoutKind; reauth: ReauthPrompt }) {
  const inFlight = new WeakSet<Submission>();

  /** 재인증 토큰을 받는다. 닫으면 null, 재인증 자체가 실패하면 문제 결과 */
  async function token(): Promise<{ token: string } | { cancelled: true } | { problem: Extract<ActionResult, { kind: 'problem' }> }> {
    try {
      const t = await o.reauth('OPS_COMMAND');
      return t ? { token: t } : { cancelled: true };
    } catch (e) {
      const p = toProblem(e);
      return { problem: { ...p, type: 'reauth-failed', message: reauthErrorMessage(e) } };
    }
  }

  /**
   * 요청 하나를 보낸다. reauth면 먼저 토큰을 받아 그 요청의 머리에 싣고, 서버가 403 reauth-required면 새 토큰으로 한 번만 다시 보낸다.
   * send(headers)는 그 시도의 머리로 생성 호출을 부른다(같은 멱등 키는 부르는 쪽이 넣는다).
   */
  async function guarded(reauth: boolean, send: (headers: Record<string, string>) => Promise<{ data: unknown; status: number }>, base: Record<string, string> = {}): Promise<ActionResult> {
    let needToken = reauth;
    for (let attempt = 0; ; attempt += 1) {
      const headers: Record<string, string> = { ...base };
      if (needToken) {
        const t = await token();
        if ('cancelled' in t) return { kind: 'cancelled' };
        if ('problem' in t) return t.problem;
        headers['X-Reauth-Token'] = t.token;
      }
      try {
        const r = await send(headers);
        return { kind: 'done', status: r.status, command: r.data as CommandDetail };
      } catch (e) {
        if (attempt === 0 && isReauthRequired(e)) {
          needToken = true;
          continue;
        }
        return toProblem(e);
      }
    }
  }

  return {
    /** 실행 전 모의(POST /v1/ops/command-dry-runs). 재인증·멱등 키 없이 접수와 같은 본문으로 부른다 */
    async dryRun(draft: CommandDraft): Promise<DryRunResult> {
      const a = commandAvailability({ role: o.role, layout: o.layout, kind: draft.kind });
      if (!a.canRequest) return { kind: 'blocked', reason: a.reason ?? VIEWER_BLOCKED };
      const body = commandBodyOf(draft);
      if (!body) return { kind: 'invalid' };
      try {
        const { createOpsCommandDryRun } = await ops();
        const r = await createOpsCommandDryRun(body as never);
        return { kind: 'ok', view: dryRunView(r.data as RawDryRun) };
      } catch (e) {
        return toProblem(e);
      }
    },

    /** 접수(POST /v1/ops/commands). 같은 Submission이 가는 중이면 곧바로 busy */
    async submit(draft: CommandDraft, submission: Submission, opts: { reauth: boolean }): Promise<ActionResult> {
      const a = commandAvailability({ role: o.role, layout: o.layout, kind: draft.kind });
      if (!a.canRequest) return { kind: 'blocked', reason: a.reason ?? VIEWER_BLOCKED };
      const body: CommandBody | null = commandBodyOf(draft);
      if (!body) return { kind: 'invalid' };
      if (inFlight.has(submission)) return { kind: 'busy' };
      inFlight.add(submission);
      try {
        return await guarded(
          opts.reauth,
          async (headers) => {
            const { createOpsCommand } = await ops();
            return createOpsCommand(body as never, { headers }) as Promise<{ data: unknown; status: number }>;
          },
          { 'Idempotency-Key': submission.idempotencyKey },
        );
      } finally {
        inFlight.delete(submission);
      }
    },

    /** 승인(POST …/approvals). PENDING_APPROVAL·REVERT_PENDING 모두 재인증 뒤 토큰을 싣는다. 휴대폰도 승인한다(control-tower §12) */
    async approve(detail: CommandDetail): Promise<ActionResult> {
      if (!canOperate(o.role)) return { kind: 'blocked', reason: VIEWER_BLOCKED };
      if (detail.canApprove === false) return { kind: 'blocked', reason: REQUESTER_BLOCKED };
      const id = detail.commandId;
      if (!id) return { kind: 'invalid' };
      return guarded(true, async (headers) => {
        const { createOpsCommandApproval } = await ops();
        return createOpsCommandApproval(id, { headers }) as Promise<{ data: unknown; status: number }>;
      });
    },

    /** 반려(POST …/rejections). 사유는 본문에만, 재인증 없음 */
    async reject(detail: CommandDetail, reason: string): Promise<ActionResult> {
      if (!canOperate(o.role)) return { kind: 'blocked', reason: VIEWER_BLOCKED };
      const id = detail.commandId;
      const r = reason.trim();
      if (!id || r === '') return { kind: 'invalid' };
      return guarded(false, async (headers) => {
        const { createOpsCommandRejection } = await ops();
        return createOpsCommandRejection(id, { reason: r }, { headers }) as Promise<{ data: unknown; status: number }>;
      });
    },

    /** 다시 시도(POST …/retries). 위험 명령(접수 dry-run reauthRequired)은 재인증 뒤 토큰을 싣는다(C-T7 ②) */
    async retry(detail: CommandDetail): Promise<ActionResult> {
      if (o.layout === 'phone') return { kind: 'blocked', reason: PHONE_BLOCKED };
      if (!canOperate(o.role)) return { kind: 'blocked', reason: VIEWER_BLOCKED };
      const id = detail.commandId;
      if (!id) return { kind: 'invalid' };
      return guarded(retryNeedsReauth(detail), async (headers) => {
        const { createOpsCommandRetry } = await ops();
        return createOpsCommandRetry(id, { headers }) as Promise<{ data: unknown; status: number }>;
      });
    },

    /** 되돌리기(POST …/reversions). 명령 3·6은 commander·재인증(명령 3은 202 REVERT_PENDING), 명령 1은 재인증 없음 */
    async revert(detail: CommandDetail, reason: string): Promise<ActionResult> {
      const a = revertAvailability({ role: o.role, layout: o.layout, type: detail.type });
      if (!a.canRequest) return { kind: 'blocked', reason: a.reason ?? VIEWER_BLOCKED };
      const id = detail.commandId;
      const r = reason.trim();
      if (!id || r === '') return { kind: 'invalid' };
      return guarded(a.reauth, async (headers) => {
        const { createOpsCommandReversion } = await ops();
        return createOpsCommandReversion(id, { reason: r }, { headers }) as Promise<{ data: unknown; status: number }>;
      });
    },
  };
}

export type CommandActions = ReturnType<typeof createCommandActions>;
