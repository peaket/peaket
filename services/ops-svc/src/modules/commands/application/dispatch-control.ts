// 제어 gRPC 퍼뜨리기와 ack(F-02-1 OPS-300, ADR-0365 결정 1·3·4, ADR-0103 결정 5, ADR-0073 결정 17).
// - ControlFanout.deliver: 받는 쪽마다 대상 찾기 포트로 주소를 풀고(부를 때마다 다시), 데드라인 1초로 동시에 부른다. applied_version이 판 이상이면 그 파드의 ack다.
//   실패·낮은 판은 1초 [가정]마다 같은 명령 ID·판으로 다시 보낸다. 모든 주소가 ack하면 주소를 다시 풀어 그사이 준비된 파드도 부르고, 다시 푼 목록에
//   ack하지 않은 파드가 없으면 성공이다. 보내기 시작한 때부터 10초 정각이 되면 실패(ack-timeout:<서비스>)다. 파드마다의 ack는 command_delivery에 남긴다.
// - ControlDispatcher: 카탈로그 명령 1·2·3·7·11은 DISPATCHED를 커밋한 뒤 같은 프로세스의 배경 작업이 보낸다(응답은 DISPATCHED). 끝나면 같은 판일 때만
//   ACKED·FAILED를 쓴다. 정비 바퀴는 DISPATCHED로 남은 명령을 같은 판으로 이어 보낸다. 되돌리기·연장·만료 되돌림은 원장의 새 판이다.
// 명령 6 결제 갈래(F-02-2 OPS-310, ADR-0366): 대체 결제사 전환은 처음 DISPATCHED 전에 물은 갈 곳(PgSwitchRoutes)으로 payment-svc 모든 파드·리더에 보내고,
//   ACKED와 같은 트랜잭션에 표시용 설정 사건 DEGRADED_MODE(대상 PAYMENT_PG_FALLBACK, occurredAt = 판)를 범위마다 하나 쓴다(결정 6). 되돌리기는 새 판의 끄기 뒤
//   해제 원장(PLATFORM, ENTRY_PAUSE_RELEASE)의 새 판으로 TOSS·PORTONE 해제를 보낸다(결정 7). 해제 갈래는 요청자 관리 계정 ID를 행위자로 싣는다(결정 9).
// 주소는 설정(대상 찾기 포트)에서만 온다. 명령 값에서 읽지 않는다(ASVS 1.3.6). 로그는 명령 ID·판·서비스·결과만 싣는다(계정·가명 참조 없음).
import { ProblemError, requestContext } from '@peaket/platform';
import { SYSTEM_ACTOR_REF, type Command, type CommandExecutionActor, type CommandExecutionResult } from '../domain/command.js';
import { CommandInputRejected, isPgFallbackParams, PAYMENT_PG_FALLBACK } from '../domain/command-params.js';
import { writeFailed, writeSucceeded } from '../domain/command-writes.js';
import { CONTROL_SCOPE_PLATFORM, controlDeliveriesOf, controlKindOf, controlScopesOf, isDispatchedControl, type ControlDelivery, type ControlPhase } from '../domain/control-kinds.js';
import { ENTRY_PAUSE_RELEASE_KIND, entryReleaseStates, REVERT_RELEASE_PGS, type PgSwitchRoutes } from '../domain/pg-switch.js';
import type { CommandExecutor, CommandSendResult, CommandStore, CommandWriter, ControlDeliverer, ControlDeliverResult, ControlDeliveries, ControlTargets, ControlTransport } from '../domain/ports.js';
import type { PgSwitchPlanner } from './pg-switch-plan.js';

/** 다시 보내는 간격 1초 [가정](ADR-0365 결정 4) */
export const CONTROL_RETRY_MS = 1_000;
/** ack 시한 10초(처음 보낸 때부터, ADR-0073 결정 17) */
export const CONTROL_ACK_TIMEOUT_MS = 10_000;

export interface ControlLog {
  info(o: object, msg: string): void;
  warn(o: object, msg: string): void;
}

export interface ControlFanoutDeps {
  readonly targets: ControlTargets;
  readonly transport: ControlTransport;
  /** 파드마다의 ack 기록. 없으면 남기지 않는다(기록 실패는 보내기를 막지 않는다) */
  readonly deliveries?: ControlDeliveries;
  readonly clock: { now(): number };
  /** 기다리기(시험은 가짜 시계와 함께 바꾼다) */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: ControlLog;
  readonly retryMs?: number;
  readonly ackTimeoutMs?: number;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
// 같은 서비스·범위에 종류·바라는 상태가 다른 받기가 여럿일 수 있다(되돌리기의 결제사별 해제, ADR-0366 결정 7)
const keyOf = (d: ControlDelivery, address: string): string => `${d.service}|${d.scope}|${d.kind}|${d.desiredStateJson}|${address}`;
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');

export class ControlFanout implements ControlDeliverer {
  readonly #retryMs: number;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ControlFanoutDeps) {
    this.#retryMs = deps.retryMs ?? CONTROL_RETRY_MS;
    this.#timeoutMs = deps.ackTimeoutMs ?? CONTROL_ACK_TIMEOUT_MS;
    this.#sleep = deps.sleep ?? realSleep;
  }

  get ackTimeoutMs(): number {
    return this.#timeoutMs;
  }

  async #resolve(service: string): Promise<string[]> {
    try {
      return [...new Set(await this.deps.targets.resolve(service))].sort();
    } catch (e) {
      this.deps.logger?.warn({ kind: 'control-targets', service, err: errName(e) }, '제어 대상 주소를 풀지 못했다(다음 바퀴에 다시)');
      return [];
    }
  }

  async #record(q: { commandId: string; version: number }, d: ControlDelivery, address: string, ack?: { podName: string; appliedVersion: number }, ackedAtMs?: number): Promise<void> {
    if (!this.deps.deliveries) return;
    try {
      await this.deps.deliveries.record({
        commandId: q.commandId,
        version: q.version,
        service: d.service,
        scope: d.scope,
        target: address,
        ...(ack && ack.podName !== '' ? { podName: ack.podName } : {}),
        ...(ack ? { appliedVersion: ack.appliedVersion } : {}),
        ...(ackedAtMs !== undefined ? { ackedAtMs } : {}),
        nowMs: this.deps.clock.now(),
      });
    } catch (e) {
      this.deps.logger?.warn({ kind: 'control-delivery', commandId: q.commandId, version: q.version, service: d.service, err: errName(e) }, 'ack 기록을 남기지 못했다');
    }
  }

  async #call(q: { commandId: string; version: number }, d: ControlDelivery, address: string, acked: Map<string, true>): Promise<void> {
    try {
      const ack = await this.deps.transport.apply(d.service, address, { commandId: q.commandId, scope: d.scope, kind: d.kind, version: q.version, desiredStateJson: d.desiredStateJson });
      // ack는 받는 쪽이 판 이상을 적용했다는 답이다(ADR-0103 결정 5). 낮은 판은 아직이다
      const ok = Number.isSafeInteger(ack.appliedVersion) && ack.appliedVersion >= q.version;
      if (ok) acked.set(keyOf(d, address), true);
      await this.#record(q, d, address, ack, ok ? this.deps.clock.now() : undefined);
    } catch {
      await this.#record(q, d, address);
    }
  }

  async deliver(q: { readonly commandId: string; readonly version: number; readonly deliveries: readonly ControlDelivery[]; readonly startedAtMs: number; readonly untilMs?: number }): Promise<ControlDeliverResult> {
    // 명령 하나에 시한 하나: 처음 보낸 때 + 10초와 부르는 쪽 시한 가운데 짧은 것(RV-06)
    const deadline = Math.min(q.startedAtMs + this.#timeoutMs, q.untilMs ?? Number.POSITIVE_INFINITY);
    const acked = new Map<string, true>();
    const services = [...new Set(q.deliveries.map((d) => d.service))];
    let confirming = false;
    for (;;) {
      const addresses = new Map<string, string[]>();
      for (const s of services) addresses.set(s, await this.#resolve(s));
      const calls: Promise<void>[] = [];
      for (const d of q.deliveries) for (const a of addresses.get(d.service) ?? []) if (!acked.has(keyOf(d, a))) calls.push(this.#call(q, d, a, acked));
      await Promise.all(calls);
      const now = this.deps.clock.now();
      const missing = q.deliveries.find((d) => {
        const list = addresses.get(d.service) ?? [];
        return list.length === 0 || list.some((a) => !acked.has(keyOf(d, a)));
      });
      if (!missing && now < deadline) {
        // 모두 ack했다: 주소를 한 번 더 풀어 그사이 준비된 파드도 부른다. 다시 푼 목록도 모두 ack면 끝이다
        if (confirming) return { ok: true, ackedAtMs: now, acked: acked.size };
        confirming = true;
        continue;
      }
      confirming = false;
      if (now >= deadline) return { ok: false, error: `ack-timeout:${(missing ?? q.deliveries[0])?.service ?? 'none'}` };
      await this.#sleep(Math.max(0, Math.min(this.#retryMs, deadline - now)));
    }
  }
}

export interface ControlDispatcherDeps {
  readonly store: CommandStore;
  readonly fanout: ControlFanout;
  readonly clock: { now(): number };
  readonly logger?: ControlLog;
  /** 명령 6 대체 결제사 전환의 갈 곳 묻기(ADR-0366 결정 5). 이어 보내기에서 메모리의 갈 곳이 없을 때 다시 묻는다. 없으면 그 명령은 FAILED pg-check-unavailable이다 */
  readonly pgSwitch?: PgSwitchPlanner;
}

/** 명령 6 대체 결제사 전환의 표시용 설정 사건 종류(asyncapi SettingChanged key, 값 DegradedModeValue, ADR-0366 결정 6) */
export const DEGRADED_MODE_SETTING = 'DEGRADED_MODE';

/** 해제 갈래의 행위자: 요청자 관리 계정 ID(대응이 지워졌으면 명령 ID. SYSTEM이 아니어야 서킷이 닫힌다, ADR-0366 결정 9) */
const releaseActorOf = (c: Pick<Command, 'requestedBy' | 'commandId'>): string => (c.requestedBy !== '' ? c.requestedBy : c.commandId);

/**
 * 응답 안에서 기다리는 부름의 시한(RV-06, ASVS 15.1.3): 지금 요청의 남은 시간이 끝나는 시각(clock.now 기준). 요청 밖(정비 바퀴)이면 없다
 */
export function requestUntilMs(nowMs: number): number | undefined {
  const deadline = requestContext()?.deadline;
  return deadline ? nowMs + deadline.remainingMs() : undefined;
}

/** 정비 바퀴가 한 번에 보는 DISPATCHED 명령 쪽 수 상한(쪽마다 100) */
const RESUME_PAGES = 5;

export class ControlDispatcher {
  readonly #inFlight = new Map<string, Promise<void>>();
  /** 처음 DISPATCHED 전에 물은 명령 6 갈 곳(같은 판을 다시 보낼 때 같은 값). 보내기가 끝나면 지운다 */
  readonly #pgRoutes = new Map<string, PgSwitchRoutes>();

  constructor(private readonly deps: ControlDispatcherDeps) {}

  /** 지금 이 프로세스가 보내는 중인가 */
  inFlight(commandId: string): boolean {
    return this.#inFlight.has(commandId);
  }

  /** 보내는 중인 것을 모두 기다린다(종료·시험) */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight.values()]);
  }

  /** DISPATCHED를 커밋한 명령을 배경에서 보낸다(같은 명령이 이미 돌면 아무것도 하지 않는다). 기다리지 않는다. 명령 6 전환은 물은 갈 곳을 넘긴다 */
  dispatch(command: Pick<Command, 'commandId'>, o: { readonly pgRoutes?: PgSwitchRoutes } = {}): void {
    if (o.pgRoutes && !this.#inFlight.has(command.commandId)) this.#pgRoutes.set(command.commandId, o.pgRoutes);
    void this.resume(command.commandId);
  }

  /** 같은 판으로 (이어) 보내고 끝을 기다린다. 이미 돌고 있으면 그 끝을 기다린다 */
  resume(commandId: string): Promise<void> {
    const running = this.#inFlight.get(commandId);
    if (running) return running;
    const p = this.#run(commandId)
      .catch((e: unknown) => this.deps.logger?.warn({ kind: 'control-dispatch', commandId, err: errName(e) }, '제어 명령 보내기가 오류로 멈췄다(정비 바퀴가 이어 보낸다)'))
      .finally(() => {
        this.#inFlight.delete(commandId);
        this.#pgRoutes.delete(commandId);
      });
    this.#inFlight.set(commandId, p);
    return p;
  }

  /**
   * 정비 바퀴(ADR-0365 결정 4): DISPATCHED로 남은 제어 명령 가운데 이 프로세스가 보내지 않고 ack 시한이 지난 것(보내던 프로세스가 멈춘 것)을 같은 판으로 이어 보낸다.
   * 기다리지 않는다. 고른 수
   */
  async resumeDispatched(nowMs: number): Promise<number> {
    let n = 0;
    let cursor: string | undefined;
    for (let page = 0; page < RESUME_PAGES; page += 1) {
      const p = await this.deps.store.list({ states: ['DISPATCHED'], limit: 100, ...(cursor !== undefined ? { cursor } : {}) });
      for (const c of p.items) {
        if (!isDispatchedControl(c.type, c.params) || c.controlVersion === undefined || this.inFlight(c.commandId)) continue;
        if (c.controlSentAtMs !== undefined && nowMs - c.controlSentAtMs < this.deps.fanout.ackTimeoutMs) continue;
        this.dispatch(c);
        n += 1;
      }
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    return n;
  }

  async #run(commandId: string): Promise<void> {
    const c = await this.deps.store.find(commandId);
    if (!c || c.state !== 'DISPATCHED' || c.controlVersion === undefined || !isDispatchedControl(c.type, c.params)) return;
    const version = c.controlVersion;
    const startedAtMs = c.controlSentAtMs ?? this.deps.clock.now();
    let pgRoutes: PgSwitchRoutes | undefined;
    if (isPgFallbackParams(c.type, c.params)) {
      // 메모리의 갈 곳이 없으면(ops-svc가 다시 떠 이어 보내기) 다시 묻는다. 묻지 못하면 보내지 않고 FAILED다(다시 하기는 같은 판)
      pgRoutes = this.#pgRoutes.get(commandId);
      if (!pgRoutes) {
        if (!this.deps.pgSwitch) return this.#finish(commandId, version, { ok: false, error: 'pg-check-unavailable' });
        try {
          pgRoutes = await this.deps.pgSwitch.routes(c);
        } catch (e) {
          if (!(e instanceof ProblemError)) throw e;
          return this.#finish(commandId, version, { ok: false, error: e.slug });
        }
      }
    }
    let deliveries: ControlDelivery[];
    try {
      deliveries = controlDeliveriesOf(c, 'APPLY', { sentAtMs: startedAtMs, ...(pgRoutes ? { pgRoutes } : {}), actorAccountId: releaseActorOf(c) });
    } catch (e) {
      if (!(e instanceof CommandInputRejected)) throw e;
      return this.#finish(commandId, version, { ok: false, error: 'invalid-command' });
    }
    const r = await this.deps.fanout.deliver({ commandId, version, deliveries, startedAtMs });
    await this.#finish(commandId, version, r);
  }

  /** 같은 판의 DISPATCHED일 때만 끝 상태를 쓴다(그사이 다른 프로세스가 끝냈거나 다시 하기로 새 판이면 건드리지 않는다) */
  async #finish(commandId: string, version: number, r: ControlDeliverResult): Promise<void> {
    const nowMs = this.deps.clock.now();
    const done = await this.deps.store.mutate(commandId, async (w) => {
      if (w.current.state !== 'DISPATCHED' || w.current.controlVersion !== version) return false;
      if (r.ok) {
        await writeSucceeded(w, { result: { transport: 'control-grpc', controlVersion: version, acked: r.acked }, ackedAtMs: r.ackedAtMs, nowMs });
        // 명령 6 전환: 표시용 설정 사건(Outbox 행은 트랜잭션의 마지막 쓰기, ADR-0366 결정 6)
        await this.#pgFallbackSettings(w, version);
      } else await writeFailed(w, { reason: r.error, nowMs });
      return true;
    });
    if (done) this.deps.logger?.info({ kind: 'control-dispatch', commandId, version, result: r.ok ? 'ACKED' : r.error }, '제어 명령 보내기가 끝났다');
  }

  /**
   * 명령 6 전환의 ACKED와 같은 트랜잭션에 범위마다 DEGRADED_MODE 사건 하나(대상 PAYMENT_PG_FALLBACK, 값 {enabled: true}, occurredAt = 판 밀리초)를 쓴다.
   * 받는 쪽은 이 사건으로 pg_switch·ctl을 쓰지 않는다(효력은 제어 gRPC, ADR-0366 결정 6). 설정 사건을 쓰지 못하는 저장소면 건너뛴다(효력은 이미 ack됐다)
   */
  async #pgFallbackSettings(w: CommandWriter, version: number): Promise<void> {
    const c = w.current;
    if (!isPgFallbackParams(c.type, c.params)) return;
    if (!w.setting) {
      this.deps.logger?.warn({ kind: 'control-dispatch', commandId: c.commandId, version }, '설정 사건을 쓰지 못하는 저장소라 명령 6 표시용 설정 사건을 건너뛴다');
      return;
    }
    for (const scope of controlScopesOf(c)) {
      await w.setting({ kind: DEGRADED_MODE_SETTING, scope, target: PAYMENT_PG_FALLBACK, value: { enabled: true }, commandId: c.commandId, actorRef: c.requesterRef ?? SYSTEM_ACTOR_REF, occurredAtMs: version });
    }
  }

  /** 명령 6 전환 되돌리기의 해제 둘(TOSS·PORTONE, ADR-0366 결정 7): 해제 원장(PLATFORM, ENTRY_PAUSE_RELEASE)의 새 판으로 끄기와 같은 시한 안에 보낸다 */
  #revertReleases(command: Command, version: number, actor: string, startedAtMs: number, untilMs: number | undefined): Promise<ControlDeliverResult> {
    return this.deps.fanout.deliver({ commandId: command.commandId, version, deliveries: entryReleaseStates(REVERT_RELEASE_PGS, actor), startedAtMs, ...(untilMs !== undefined ? { untilMs } : {}) });
  }

  /**
   * 되돌리기·연장·만료 되돌림(ADR-0365 결정 1·4): 원장의 새 판을 매겨 명령 기록에 남긴 뒤 응답 안에서 보내고 ack를 기다린다(10초까지).
   * 명령 6 전환의 되돌리기는 끄기(새 판) 뒤 해제 둘(해제 원장의 새 판)을 같은 시한 안에 보내고 둘 다 ack해야 성공이다(ADR-0366 결정 7). 던지지 않는다
   * @param o.actorAccountId 되돌린 사람의 관리 계정 ID(명령 6 해제의 행위자)
   */
  async sendNew(command: Command, phase: Exclude<ControlPhase, 'APPLY'>, o: { readonly expiresAtMs?: number; readonly actorAccountId?: string } = {}): Promise<CommandSendResult> {
    const kind = controlKindOf(command.type, command.params);
    if (!kind || !isDispatchedControl(command.type, command.params)) return { status: 'FAILED', error: 'target-not-wired' };
    if (kind === ENTRY_PAUSE_RELEASE_KIND) return { status: 'FAILED', error: 'not-revertible' };
    const pgRevert = phase === 'REVERT' && isPgFallbackParams(command.type, command.params);
    let scopes: string[];
    let deliveries: ControlDelivery[];
    const nowMs = this.deps.clock.now();
    try {
      scopes = controlScopesOf(command);
      deliveries = controlDeliveriesOf(command, phase, { sentAtMs: nowMs, ...(o.expiresAtMs !== undefined ? { expiresAtMs: o.expiresAtMs } : {}) });
    } catch (e) {
      if (e instanceof CommandInputRejected) return { status: 'FAILED', error: 'invalid-command' };
      throw e;
    }
    const versions = await this.deps.store.mutate(command.commandId, async (w) => {
      if (!w.assignControlVersion) return undefined;
      const v = await w.assignControlVersion({ scopes, kind, nowMs });
      // 해제는 다른 원장(PLATFORM, ENTRY_PAUSE_RELEASE)의 판이다. 같은 트랜잭션에서 매긴다(명령 기록의 판은 끄기 판)
      const release = pgRevert ? await w.assignControlVersion({ scopes: [CONTROL_SCOPE_PLATFORM], kind: ENTRY_PAUSE_RELEASE_KIND, nowMs }) : undefined;
      await w.patch({ controlVersion: v, controlSentAtMs: nowMs, nowMs });
      return { v, release };
    });
    if (versions === undefined) return { status: 'FAILED', error: 'control-ledger-not-wired' };
    const version = versions.v;
    // 되돌리기·연장은 응답 안의 ack를 기다린다(openapi 200·502). 시한은 처음 보낸 때 + 10초와 요청 남은 시간 가운데 짧은 것(RV-06)
    const untilMs = requestUntilMs(nowMs);
    let r = await this.deps.fanout.deliver({ commandId: command.commandId, version, deliveries, startedAtMs: nowMs, ...(untilMs !== undefined ? { untilMs } : {}) });
    if (r.ok && versions.release !== undefined) {
      const actor = o.actorAccountId !== undefined && o.actorAccountId !== '' ? o.actorAccountId : releaseActorOf(command);
      r = await this.#revertReleases(command, versions.release, actor, nowMs, untilMs);
    }
    this.deps.logger?.info({ kind: 'control-dispatch', commandId: command.commandId, version, phase, result: r.ok ? 'ACKED' : r.error }, '제어 명령 되돌림·연장을 보냈다');
    return r.ok ? { status: 'ACKED', ackedAtMs: r.ackedAtMs } : { status: 'FAILED', error: r.error };
  }
}

/**
 * 되돌림·연장의 실행기(RevertCommand·ExtendCommand·DecideCommand가 부른다). 제어 gRPC 명령은 ControlDispatcher.sendNew(새 판)로,
 * 그 밖은 원래 실행기로 보낸다. 실행(execute)은 원래 실행기 그대로다(제어 명령의 실행은 ExecuteCommand가 배경 작업에 넘긴다)
 */
export class ControlAwareExecutor implements CommandExecutor {
  constructor(
    private readonly inner: CommandExecutor | undefined,
    private readonly dispatcher: ControlDispatcher,
  ) {}

  execute(command: Command, actor: CommandExecutionActor): Promise<CommandExecutionResult> {
    return this.inner ? this.inner.execute(command, actor) : Promise.resolve({ status: 'FAILED', error: 'target-not-wired' });
  }

  revert(command: Command, actor: CommandExecutionActor): Promise<CommandSendResult> {
    if (isDispatchedControl(command.type, command.params)) return this.dispatcher.sendNew(command, 'REVERT', { actorAccountId: actor.accountId });
    return this.inner?.revert ? this.inner.revert(command, actor) : Promise.resolve({ status: 'FAILED', error: 'target-not-wired' });
  }

  extend(command: Command, expiresAtMs: number, actor: CommandExecutionActor): Promise<CommandSendResult> {
    if (command.type === 'ADMISSION_PAUSE') return this.dispatcher.sendNew(command, 'EXTEND', { expiresAtMs });
    return this.inner?.extend ? this.inner.extend(command, expiresAtMs, actor) : Promise.resolve({ status: 'FAILED', error: 'target-not-wired' });
  }
}
