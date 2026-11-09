// pid 키 전환 명령(docs/features/identity.md §5 'pid 키 전환의 첫 구현', BUILD_ORDER BOT-025, I-T49, ADR-0050 결정 5, ADR-0127).
// 서비스와 같은 이미지를 다른 시작 명령으로 한 번 띄우는 작업이 부른다(src/pid-rotation.ts). 시작은 저장된 ci_hmac으로 새 pid를 계산해 넣고 옛 값을 pid_prev로 옮기며,
// 끝내기는 전환 끝 시각 뒤에 pid_prev를 지운다. KMS 호출은 트랜잭션 밖에서 묶음마다 하고, 줄마다 따로 바꿔 도중에 멈추면 다시 돌려 이어 한다.
import type { Clock } from '@peaket/platform';
import { ACCESS_TOKEN_TTL_MS } from '../../session/index.js';
import type { IdentityHashers, PidRotationRecord, PidRotationStore } from '../domain/ports.js';
import { KeyServiceUnavailable } from '../domain/verification.js';

/** 한 번에 계산하는 줄 수 [가정](KMS 대칭·HMAC 연산은 계정 전체가 초당 10,000건을 나눠 쓴다, identity §5) */
export const PID_ROTATION_BATCH = 100;
/** 전환 작업의 KMS 호출 초당 상한 [가정](운영 본인확인·관리자 로그인의 KMS 몫을 깎지 않게, identity §5, BOT-025가 넘긴 것) */
export const PID_ROTATION_KMS_RPS = 200;
/** 한 번에 지우는 pid_prev 줄 수 [가정] */
const CLEAR_BATCH = 1_000;
/** 전환 끝 시각은 적어도 지금 + 1일이다(가장 늦은 판매 종료 + 1일, identity §5 pid 키 교체 2) */
export const MIN_TRANSITION_MS = 86_400_000;

export type PidRotationCode =
  | 'IN_PROGRESS'
  | 'NOTHING_TO_MOVE'
  | 'VERSION_NOT_NEWER'
  | 'UNTIL_REQUIRED'
  | 'UNTIL_TOO_SOON'
  | 'UNTIL_MISMATCH'
  | 'NOT_STARTED'
  | 'TRANSITION_NOT_OVER'
  | 'NOT_MOVED'
  | 'KEY_SERVICE_DOWN';

export class PidRotationError extends Error {
  constructor(
    readonly code: PidRotationCode,
    message: string,
    /** KEY_SERVICE_DOWN: 이번에 옮긴 줄 수와 남은 줄 수 */
    readonly moved = 0,
    readonly remaining = 0,
  ) {
    super(message);
    this.name = 'PidRotationError';
  }
}

export interface PidRotationReport {
  toVersion: number;
  /** 이번에 옮긴 줄 수 */
  moved: number;
  /** pid 판이 새 판보다 작게 남은 줄 수(0이면 다 옮김) */
  remaining: number;
  transitionEndsAt: number;
  movedAt: number | null;
  /** 새 회차의 대기열·로비를 열어도 되는 시각(다 옮긴 시각 + 액세스 토큰 수명). 그 전에 받은 토큰은 옛 pid만 실어, 그 토큰으로 선 줄은 옛 키에만 남는다 */
  safeToOpenAt: number | null;
}

/** 다 옮긴 시각에서 옛 pid만 실린 액세스 토큰이 모두 끝나는 시각(identity §5 'pid 키 전환의 첫 구현', 새 맥락 리뷰 중간 1) */
const safeToOpenAtOf = (movedAt: number | null): number | null => (movedAt === null ? null : movedAt + ACCESS_TOKEN_TTL_MS);

export class PidRotation {
  readonly #batch: number;
  readonly #kmsPerSecond: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly store: PidRotationStore,
    private readonly hashers: IdentityHashers,
    private readonly clock: Clock,
    o: { batch?: number; kmsPerSecond?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.#kmsPerSecond = o.kmsPerSecond ?? PID_ROTATION_KMS_RPS;
    if (!Number.isFinite(this.#kmsPerSecond) || this.#kmsPerSecond <= 0) throw new RangeError('KMS 초당 상한은 0보다 큰 수다');
    // 한 묶음은 함께 보내므로 묶음 크기를 초당 상한 이하로 둔다: 평균이 아니라 어느 1초에도 상한을 넘지 않게(재검토 2026-11-05)
    this.#batch = Math.max(1, Math.min(o.batch ?? PID_ROTATION_BATCH, Math.floor(this.#kmsPerSecond)));
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** 전환을 시작하거나(until 필요) 닫지 않은 같은 판의 전환을 이어 한다(until은 없거나 처음 값) */
  async start(i: { until?: number }): Promise<PidRotationReport> {
    const now = this.clock.now();
    const target = this.hashers.pidVersion();
    let open = await this.store.openPidRotation();
    if (open && open.toVersion !== target) {
      throw new PidRotationError('IN_PROGRESS', `닫지 않은 전환(판 ${open.toVersion})이 있다. 그 전환을 끝내기 전에는 판 ${target}로 시작하지 않는다(처음 옛 pid를 잃는다)`);
    }
    if (open) {
      if (i.until !== undefined && i.until !== open.transitionEndsAt) {
        throw new PidRotationError('UNTIL_MISMATCH', `이어 하는 전환의 끝 시각은 처음 값(${new Date(open.transitionEndsAt).toISOString()})이다`);
      }
    } else {
      const versions = await this.store.pidKeyVersionsInUse();
      const newer = versions.filter((v) => v > target);
      if (newer.length > 0) throw new PidRotationError('VERSION_NOT_NEWER', `기록이 설정 판 ${target}보다 큰 pid 판 ${newer.join('·')}을(를) 쓴다. 설정을 확인한다`);
      if (!versions.some((v) => v < target)) throw new PidRotationError('NOTHING_TO_MOVE', `pid 판이 설정 판 ${target}보다 작은 기록이 없다. 새 키·새 판을 먼저 배포한다`);
      if (i.until === undefined) throw new PidRotationError('UNTIL_REQUIRED', '전환 끝 시각(--until)이 필요하다');
      if (i.until < now + MIN_TRANSITION_MS) throw new PidRotationError('UNTIL_TOO_SOON', '전환 끝 시각은 지금 + 1일 이후다');
      await this.store.beginPidRotation({ toVersion: target, startedAt: now, transitionEndsAt: i.until });
      open = { toVersion: target, startedAt: now, transitionEndsAt: i.until, movedAt: null, finishedAt: null };
    }
    const moved = await this.#move(target);
    const remaining = await this.store.pidRowsBelow(target);
    // 다 옮긴 시각: 처음 다 옮겼거나, 다 옮긴 뒤 옛 판 기록이 다시 생겨 이번에 옮겼으면 지금으로 늦춘다(옛 설정 파드, 새 맥락 리뷰 다시 보기 중간)
    let movedAt = open.movedAt;
    if (remaining === 0 && (movedAt === null || moved > 0)) {
      movedAt = this.clock.now();
      await this.store.markPidMoved(target, movedAt);
    }
    return { toVersion: target, moved, remaining, transitionEndsAt: open.transitionEndsAt, movedAt, safeToOpenAt: remaining === 0 ? safeToOpenAtOf(movedAt) : null };
  }

  /** 전환 끝 시각 뒤에 pid_prev를 모두 지우고 전환을 닫는다. 그 뒤 옛 KMS 키를 파기 예약한다(운영자) */
  async finish(): Promise<{ toVersion: number; cleared: number }> {
    const open = await this.store.openPidRotation();
    if (!open) throw new PidRotationError('NOT_STARTED', '닫지 않은 전환이 없다');
    const now = this.clock.now();
    if (now < open.transitionEndsAt) throw new PidRotationError('TRANSITION_NOT_OVER', `전환 끝 시각(${new Date(open.transitionEndsAt).toISOString()}) 전이다`);
    const remaining = await this.store.pidRowsBelow(open.toVersion);
    if (open.movedAt === null || remaining > 0) throw new PidRotationError('NOT_MOVED', `옮기지 못한 줄이 ${remaining}개 남았다. start로 이어 한다`, 0, remaining);
    let cleared = 0;
    for (;;) {
      const n = await this.store.clearPidPrev(CLEAR_BATCH);
      cleared += n;
      if (n === 0) break;
    }
    await this.store.finishPidRotation(open.toVersion, now);
    return { toVersion: open.toVersion, cleared };
  }

  async status(): Promise<{ open: PidRotationRecord | null; configuredVersion: number; versions: number[]; remaining: number; safeToOpenAt: number | null }> {
    const open = await this.store.openPidRotation();
    const configuredVersion = this.hashers.pidVersion();
    const remaining = await this.store.pidRowsBelow(open?.toVersion ?? configuredVersion);
    // 남은 줄이 있으면(옛 설정 파드가 옛 판 기록을 만듦) 열어도 되는 시각을 주지 않는다. start로 다시 옮기면 그때부터 센다
    return { open, configuredVersion, versions: await this.store.pidKeyVersionsInUse(), remaining, safeToOpenAt: remaining === 0 ? safeToOpenAtOf(open?.movedAt ?? null) : null };
  }

  /** pid 판이 target보다 작고 pid_prev가 빈 줄을 묶음마다 옮긴다. KMS가 답하지 않으면 그 묶음의 계산된 줄까지 옮기고 멈춘다 */
  async #move(target: number): Promise<number> {
    let moved = 0;
    let after = '';
    for (;;) {
      const rows = await this.store.pidRowsToMove(target, after, this.#batch);
      if (rows.length === 0) return moved;
      // 시간은 KMS에 보내기 직전부터 잰다(줄 읽기에 걸린 시간을 쉬는 시간으로 치면 두 묶음이 1초 안에 몰린다, 재검토 2026-11-05)
      const started = this.clock.now();
      after = rows[rows.length - 1]!.accountId;
      const pids = await Promise.allSettled(rows.map((r) => this.hashers.pid(r.ciHmac)));
      let failure: unknown;
      for (const [k, r] of rows.entries()) {
        const p = pids[k]!;
        if (p.status === 'rejected') {
          failure ??= p.reason;
          continue;
        }
        if (p.value.version !== target) throw new Error(`pid 키 판이 바뀌었다(설정 ${target}, 계산 ${p.value.version})`);
        if (await this.store.movePid(r.accountId, p.value.pid, target)) moved++;
      }
      if (failure !== undefined) {
        if (failure instanceof KeyServiceUnavailable) {
          const remaining = await this.store.pidRowsBelow(target);
          throw new PidRotationError('KEY_SERVICE_DOWN', `KMS가 답하지 않아 멈췄다(옮김 ${moved}, 남음 ${remaining}). 다시 돌리면 남은 줄부터 한다`, moved, remaining);
        }
        throw failure;
      }
      // 초당 상한: 이 묶음의 KMS 호출 수가 상한에 맞는 시간보다 빨리 끝났으면 모자란 만큼 쉰다
      const short = (rows.length * 1000) / this.#kmsPerSecond - (this.clock.now() - started);
      if (short > 0) await this.#sleep(short);
    }
  }
}

export type PidRotationCommand = { command: 'start'; until?: number } | { command: 'finish' } | { command: 'status' };

/** 명령 줄: start [--until <ISO 8601 시각>] | finish | status. 틀리면 던진다(작업은 2로 끝난다) */
export function parsePidRotationArgs(argv: readonly string[]): PidRotationCommand {
  const [command, ...rest] = argv;
  if (command === 'finish' || command === 'status') {
    if (rest.length > 0) throw new Error(`${command}은(는) 인자를 받지 않는다`);
    return { command };
  }
  if (command !== 'start') throw new Error('쓰는 법: pid-rotation start [--until <ISO 8601 시각>] | finish | status');
  if (rest.length === 0) return { command };
  if (rest.length !== 2 || rest[0] !== '--until') throw new Error('start는 --until <ISO 8601 시각>만 받는다');
  const until = Date.parse(rest[1]!);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(rest[1]!) || Number.isNaN(until) || !/(Z|[+-]\d{2}:\d{2})$/.test(rest[1]!)) throw new Error('--until은 시간대가 있는 ISO 8601 시각이다(예: 2026-12-01T00:00:00+09:00)');
  return { command, until };
}
