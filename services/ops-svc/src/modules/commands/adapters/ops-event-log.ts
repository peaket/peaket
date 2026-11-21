// 운영 사건 줄 ops_event(ADR-0349 결정 8, ADR-0078 결정 3, docs/observability.md '운영 사건 줄').
// 명령 사건이 커밋된 뒤 표본 없이 한 줄을 남긴다. 칸은 opsEvent(`<번호>:<유형>`, 카탈로그 밖은 `-:<유형>`)·stage·eventId·actorRole·commandId뿐이고,
// 관리 계정 ID·이름·가명 참조는 싣지 않는다. 대시보드가 Loki 주석 조회로 읽는다.
// 내는 자리는 한 곳이다: 명령 저장소를 감싼 OpsEventStore가 쓰기(insert·mutate·mutateDue)의 트랜잭션이 끝난(커밋된) 뒤에만 낸다.
// 던져서 되돌아간 쓰기는 줄을 남기지 않는다. 단계는 REQUESTED(사람 접수)·AUTO_ACTION_STARTED(시스템 자동 조치)와 아래 사건 이름이다.
import type { PlatformLogger } from '@peaket/platform';
import { CATALOG_COMMAND_TYPES, SYSTEM_ROLE, approvalModeOf, type Command, type CommandIdempotency, type CommandType, type NewCommand } from '../domain/command.js';
import type { CommandDueKind, CommandListQuery, CommandPage, CommandStore, CommandTimelineEntry, CommandWriter } from '../domain/ports.js';
import type { PostReviewAlertKind, PostReviewRow } from '../domain/post-review.js';
import { CommandStoreBase } from './command-store-base.js';

/** 줄로 남기는 명령 사건(그 밖의 사건은 남기지 않는다) */
export const OPS_EVENT_STAGES = ['REQUESTED', 'APPROVED', 'REJECTED', 'ACKED', 'FAILED', 'EXTENDED', 'REVERT_REQUESTED', 'REVERTED', 'AUTO_EXPIRED', 'AUTO_ACTION_STARTED'] as const;
export type OpsEventStage = (typeof OPS_EVENT_STAGES)[number];
const EVENT_STAGES: ReadonlySet<string> = new Set(['APPROVED', 'REJECTED', 'ACKED', 'FAILED', 'EXTENDED', 'REVERT_REQUESTED', 'REVERTED', 'AUTO_EXPIRED']);

export interface OpsEventLine {
  readonly opsEvent: string;
  readonly stage: OpsEventStage;
  /** 회차(회차 하나에 건 명령만, 그 밖은 null) */
  readonly eventId: string | null;
  /** operator·commander·SYSTEM */
  readonly actorRole: string;
  readonly commandId: string;
}

/** 명령 번호와 유형(`3:KILL_SWITCH`). 카탈로그 명령 1~12 밖은 `-:<유형>` */
export function opsEventNameOf(type: CommandType): string {
  const i = CATALOG_COMMAND_TYPES.indexOf(type);
  return `${i >= 0 ? i + 1 : '-'}:${type}`;
}

const roleOf = (role: string): string => (role === SYSTEM_ROLE ? 'SYSTEM' : role);

export function opsEventLineOf(c: Pick<Command, 'commandId' | 'type' | 'eventId'>, stage: OpsEventStage, actorRole: string): OpsEventLine {
  return { opsEvent: opsEventNameOf(c.type), stage, eventId: c.eventId ?? null, actorRole: roleOf(actorRole), commandId: c.commandId };
}

/** 줄을 받는 쪽(기본은 서비스 로거, 없으면 표준 출력 JSON 한 줄) */
export type OpsEventSink = (line: OpsEventLine) => void;

export class OpsEventLog {
  #logger: PlatformLogger | undefined;

  constructor(private readonly sink?: OpsEventSink) {}

  /** 모듈을 조립한 뒤 서비스 로거를 붙인다 */
  attach(logger: PlatformLogger | undefined): this {
    if (logger) this.#logger = logger;
    return this;
  }

  /** 한 줄을 남긴다. 로그를 쓰지 못해도 명령 흐름을 막지 않는다 */
  emit(line: OpsEventLine): void {
    try {
      const fields = { kind: 'ops_event', opsEvent: line.opsEvent, stage: line.stage, eventId: line.eventId, actorRole: line.actorRole, commandId: line.commandId };
      if (this.sink) this.sink(line);
      else if (this.#logger) this.#logger.info(fields, 'ops_event');
      else process.stdout.write(`${JSON.stringify({ level: 'info', service: 'ops-svc', ...fields, msg: 'ops_event' })}\n`);
    } catch {
      // 관측 줄이 명령을 실패시키지 않는다
    }
  }
}

/**
 * 명령 저장소를 감싸 커밋된 사건마다 ops_event를 낸다. 상태 쓰기는 모두 mutate·mutateDue·insert를 지나므로(CommandStoreBase의 승인·실행 쓰기 포함) 빠지는 길이 없다.
 * 시험이 읽는 저장소(COMMAND_STORE)는 감싸지 않은 원래 저장소다.
 */
export class OpsEventStore extends CommandStoreBase {
  constructor(
    private readonly inner: CommandStore,
    private readonly log: OpsEventLog,
  ) {
    super();
  }

  async insert(input: NewCommand): Promise<{ readonly command: Command; readonly replayed: boolean }> {
    const out = await this.inner.insert(input);
    if (!out.replayed) {
      this.log.emit(opsEventLineOf(out.command, input.system ? 'AUTO_ACTION_STARTED' : 'REQUESTED', input.system ? SYSTEM_ROLE : input.requestedRole));
      // 두 번째 승인이 없는 사람 접수(1인·즉시 실행)는 만들 때 요청자의 APPROVED 사건을 같은 트랜잭션에 쓴다(planCreation과 같은 판정). 그 사건의 줄도 낸다(B23)
      if (!input.system && (input.approvalMode ?? approvalModeOf(input.type, input.params)) !== 'TWO') this.log.emit(opsEventLineOf(out.command, 'APPROVED', input.requestedRole));
      // 시스템 자동 조치는 만들 때 DISPATCHED라 그 뒤 사건은 mutate가 낸다
    }
    return out;
  }

  /** 쓰기 하나가 남긴 사건(차례대로). 끝나면(커밋되면) 낸다 */
  #observe(w: CommandWriter, seen: { type: string; actorRole: string }[]): CommandWriter {
    return new Proxy(w, {
      get(target, prop) {
        if (prop === 'event') {
          return async (e: Parameters<CommandWriter['event']>[0]) => {
            await target.event(e);
            seen.push({ type: e.type, actorRole: e.actorRole });
          };
        }
        // 게터(current)와 메서드는 원래 쓰기 객체를 this로 부른다(사후 검토·설정 사건 등 덧붙은 칸도 그대로 넘긴다)
        const v: unknown = Reflect.get(target, prop, target);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }

  #flush(c: Command | undefined, seen: readonly { type: string; actorRole: string }[]): void {
    if (!c) return;
    for (const e of seen) if (EVENT_STAGES.has(e.type)) this.log.emit(opsEventLineOf(c, e.type as OpsEventStage, e.actorRole));
  }

  async mutate<T>(commandId: string, fn: (w: CommandWriter) => Promise<T>): Promise<T | undefined> {
    const seen: { type: string; actorRole: string }[] = [];
    let last: Command | undefined;
    const out = await this.inner.mutate(commandId, async (w) => {
      const r = await fn(this.#observe(w, seen));
      last = w.current;
      return r;
    });
    this.#flush(last, seen);
    return out;
  }

  async mutateDue(kind: CommandDueKind, nowMs: number, fn: (w: CommandWriter) => Promise<void>): Promise<boolean> {
    const seen: { type: string; actorRole: string }[] = [];
    let last: Command | undefined;
    const out = await this.inner.mutateDue(kind, nowMs, async (w) => {
      await fn(this.#observe(w, seen));
      last = w.current;
    });
    this.#flush(last, seen);
    return out;
  }

  replayOf(idem: CommandIdempotency, nowMs: number): Promise<string | undefined> {
    return this.inner.replayOf(idem, nowMs);
  }

  find(commandId: string): Promise<Command | undefined> {
    return this.inner.find(commandId);
  }

  list(query: CommandListQuery): Promise<CommandPage> {
    return this.inner.list(query);
  }

  dueForCompare(nowMs: number, limit: number): Promise<readonly string[]> {
    return this.inner.dueForCompare(nowMs, limit);
  }

  purgeActors(beforeMs: number): Promise<number> {
    return this.inner.purgeActors(beforeMs);
  }

  postReviewOf(commandId: string): Promise<PostReviewRow | undefined> {
    return this.inner.postReviewOf ? this.inner.postReviewOf(commandId) : Promise.resolve(undefined);
  }

  postReviewsDue(nowMs: number, limit: number): Promise<readonly { readonly commandId: string; readonly kind: PostReviewAlertKind }[]> {
    return this.inner.postReviewsDue ? this.inner.postReviewsDue(nowMs, limit) : Promise.resolve([]);
  }

  postReviewsToOpen(limit: number): Promise<readonly string[]> {
    return this.inner.postReviewsToOpen ? this.inner.postReviewsToOpen(limit) : Promise.resolve([]);
  }

  timelineOf(commandId: string): Promise<readonly CommandTimelineEntry[]> {
    return this.inner.timelineOf ? this.inner.timelineOf(commandId) : Promise.resolve([]);
  }
}
