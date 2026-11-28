// F-02-6(동결 로컬) 명령 4·6의 엣지/외부 설정 실행기. WAF·엣지 저장소·CloudFront 설정 포트를 부른다.
// 실제 AWS 호출은 미실행·[가정]이고, 이 실행기는 포트 인터페이스에만 기댄다(control-tower §5, ADR-0078 결정 2, ADR-0234 결정 5).
// 그 밖의 명령 유형은 next(기존 실행기)에 넘긴다.
import type { Command, CommandExecutionActor, CommandExecutionResult } from '../domain/command.js';
import type { CdnEdgeSettings, EntryModeStore, WafBlockApplyError, WafBlocks } from '../domain/edge-ports.js';
import type { CommandExecutor, CommandSendResult } from '../domain/ports.js';

export interface EdgeCommandExecutorDeps {
  readonly waf: WafBlocks;
  readonly entryMode: EntryModeStore;
  readonly cdn: CdnEdgeSettings;
  /** 그 밖의 명령을 맡길 실행기(없으면 target-not-wired) */
  readonly next?: CommandExecutor;
  readonly nowMs?: () => number;
}

export type EdgeCommandResult = CommandExecutionResult;

/** 엣지 실행의 ACKED에 실을 detail(되돌리기는 detail 없이 보낸다) */
type EdgeSendResult =
  | { readonly status: 'ACKED'; readonly ackedAtMs?: number; readonly detail?: Record<string, unknown> }
  | { readonly status: 'FAILED'; readonly error: string };

/** 명령 4·6의 엣지/외부 설정 실행기 */
export class EdgeCommandExecutor implements CommandExecutor {
  readonly #nowMs: () => number;

  constructor(private readonly deps: EdgeCommandExecutorDeps) {
    this.#nowMs = deps.nowMs ?? (() => Date.now());
  }

  async execute(command: Command, actor: CommandExecutionActor): Promise<EdgeCommandResult> {
    if (command.type === 'BLOCK_ASN_IP') return this.#block(command);
    if (command.type === 'DEGRADED_MODE') {
      const mode = command.params.mode;
      if (mode === 'ENTRY_DEGRADED') return this.#entry(command, true);
      if (mode === 'STATE_MIRROR_FIXED' || mode === 'SOLD_OUT_STATIC') return this.#cdn(command, true);
    }
    return this.deps.next ? this.deps.next.execute(command, actor) : { status: 'FAILED', error: 'target-not-wired' };
  }

  async revert(command: Command, actor: CommandExecutionActor): Promise<CommandSendResult> {
    if (command.type === 'BLOCK_ASN_IP') {
      try {
        await this.deps.waf.release(command.commandId);
        return { status: 'ACKED', ackedAtMs: this.#nowMs() };
      } catch {
        return { status: 'FAILED', error: 'waf-unavailable' };
      }
    }
    if (command.type === 'DEGRADED_MODE') {
      const mode = command.params.mode;
      if (mode === 'ENTRY_DEGRADED') return this.#entry(command, false);
      if (mode === 'STATE_MIRROR_FIXED' || mode === 'SOLD_OUT_STATIC') return this.#cdn(command, false);
    }
    return this.deps.next?.revert ? this.deps.next.revert(command, actor) : { status: 'FAILED', error: 'target-not-wired' };
  }

  async #block(command: Command): Promise<EdgeCommandResult> {
    const cidrs = Array.isArray(command.params.cidrs) ? command.params.cidrs.filter((v): v is string => typeof v === 'string') : [];
    const asns = Array.isArray(command.params.asns) ? command.params.asns.filter((v): v is number => typeof v === 'number') : [];
    const expiresAt = command.params.expiresAt;
    const expiresAtMs = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
    if (!Number.isFinite(expiresAtMs)) return { status: 'FAILED', error: 'invalid-command' };
    try {
      await this.deps.waf.apply(command.commandId, { cidrs, asns, expiresAtMs });
      return { status: 'ACKED', ackedAtMs: this.#nowMs(), detail: { transport: 'waf', cidrs: cidrs.length, asns: asns.length } };
    } catch (e) {
      const part = (e as Partial<WafBlockApplyError> | undefined)?.part;
      return { status: 'FAILED', error: part === 'cidr' || part === 'asn' ? `waf-unavailable:${part}` : 'waf-unavailable' };
    }
  }

  async #entry(command: Command, on: boolean): Promise<EdgeSendResult> {
    if (!on) {
      await this.deps.entryMode.write({ on: false, expireAtMs: this.#nowMs() });
      return { status: 'ACKED', ackedAtMs: this.#nowMs(), detail: { transport: 'edge-store', on: false } };
    }
    const expiresAt = command.params.expiresAt;
    const expireAtMs = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
    if (!Number.isFinite(expireAtMs)) return { status: 'FAILED', error: 'invalid-command' };
    try {
      await this.deps.entryMode.write({ on: true, expireAtMs });
      return { status: 'ACKED', ackedAtMs: this.#nowMs(), detail: { transport: 'edge-store', on: true, expireAtMs } };
    } catch {
      return { status: 'FAILED', error: 'edge-mode-unavailable' };
    }
  }

  async #cdn(command: Command, on: boolean): Promise<EdgeSendResult> {
    const mode = command.params.mode;
    const change = mode === 'STATE_MIRROR_FIXED' ? { stateMirrorFixed: on } : { soldOutStatic: on };
    try {
      await this.deps.cdn.apply(change);
      return { status: 'ACKED', ackedAtMs: this.#nowMs(), detail: { transport: 'cloudfront-settings', mode, on } };
    } catch {
      return { status: 'FAILED', error: 'cdn-settings-unavailable' };
    }
  }
}
