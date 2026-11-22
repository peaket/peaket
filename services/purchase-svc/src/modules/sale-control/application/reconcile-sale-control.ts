// purchase-svc 제어 상태 시작 작업과 2초 [가정] 다시 맞춤(F-02-1 OPS-300, ADR-0365 결정 7, ADR-0103 결정 2, C-T50).
// - 시작: 준비 표시에 'control-state'를 걸고 sale_control 전체를 읽어야 끝낸다(읽지 못하면 1초 [가정]마다 다시, 그동안 준비 상태가 아니다)
// - 그 뒤 2초마다 다시 읽어 파드 메모리(결제 시도·결제 접수의 정지 확인)를 맞추고, 정지가 걸린 행의 좌석 Redis 사본 s:{event:E}:ctl을 원본대로 다시 쓴다
//   (회차 명령 3·판매 중지는 그 회차, 전체 명령 3은 회차 목록 s:ctl:events의 모든 회차). 명령 3 사본 쓰기는 판이 칸보다 클 때만이라 지워진 사본만 다시 선다
// 플랫폼 제어 동기화(startServiceControlSync)는 Kafka가 없는 local·ci에서 뜨지 않아, 이 서비스가 같은 주기(platform CONTROL_SYNC_DEFAULTS)로 따로 돈다.
// platform의 ControlStateSource 꼴(read)도 내놓는다.
import { CONTROL_SYNC_DEFAULTS, type ControlEntry, type ControlStateSource } from '@peaket/platform';
import type { SaleControlCopies, SaleControlStore } from '../domain/ports.js';
import type { SaleControlMemory } from './sale-control-memory.js';

/** 준비 표시에 거는 작업 이름(플랫폼 시작 작업의 제어 상태와 같은 이름) */
export const SALE_CONTROL_READINESS_TASK = 'control-state';

export interface ReconcileTimer {
  /** ms 뒤 한 번 fn을 부른다. 돌려준 함수로 취소한다 */
  after(ms: number, fn: () => void): () => void;
}

const systemTimer: ReconcileTimer = {
  after(ms, fn) {
    const t = setTimeout(fn, ms);
    t.unref();
    return () => clearTimeout(t);
  },
};

export interface SaleControlReconcilerDeps {
  readonly store: Pick<SaleControlStore, 'snapshot'>;
  readonly memory: SaleControlMemory;
  readonly copies?: SaleControlCopies;
  readonly logger?: { warn(o: object, msg: string): void };
  readonly timer?: ReconcileTimer;
  /** 다시 맞춤 주기(기본 CONTROL_SYNC_DEFAULTS.reconcileMs)와 첫 읽기 다시 하기 간격(기본 retryMs). 시험만 바꾼다 */
  readonly reconcileMs?: number;
  readonly retryMs?: number;
}

export class SaleControlReconciler implements ControlStateSource {
  #cancel: (() => void) | undefined;
  #stopped = false;
  #running: Promise<void> | undefined;

  constructor(private readonly deps: SaleControlReconcilerDeps) {}

  /** 한 번 다시 맞춘다: 원본을 읽어 메모리를 맞추고 정지 행의 사본을 다시 쓴다. 원본을 읽지 못하거나 사본 쓰기가 실패하면 던진다 */
  async runOnce(): Promise<void> {
    const s = await this.deps.store.snapshot();
    this.deps.memory.load(s);
    const copies = this.deps.copies;
    if (!copies) return;
    for (const row of s.events) {
      const pausedRevision = row.pausedRevision ?? 0;
      if (row.paused && pausedRevision > 0) {
        await copies.writePause?.({ eventId: row.eventId, paused: true, revision: pausedRevision, ...(row.pausedCommandId !== undefined ? { commandId: row.pausedCommandId } : {}) });
      }
      if (row.suspended) {
        await copies.write({ eventId: row.eventId, suspended: true, revision: row.revision, ...(row.commandId !== undefined ? { commandId: row.commandId } : {}), ...(row.suspensionRef !== undefined ? { suspensionRef: row.suspensionRef } : {}) });
      }
    }
    if (s.platform?.paused === true && s.platform.pausedRevision > 0) {
      await copies.writePlatformPause?.({ paused: true, revision: s.platform.pausedRevision, ...(s.platform.pausedCommandId !== undefined ? { commandId: s.platform.pausedCommandId } : {}) });
    }
  }

  /** platform ControlStateSource: 원본을 판 번호가 있는 칸들로 돌려준다(키 '<범위>:<종류>') */
  async read(): Promise<ControlEntry[]> {
    const s = await this.deps.store.snapshot();
    const out: ControlEntry[] = [];
    for (const row of s.events) {
      out.push({ key: `${row.eventId}:SALE_SUSPENSION`, version: row.revision, value: { suspended: row.suspended } });
      if ((row.pausedRevision ?? 0) > 0) out.push({ key: `${row.eventId}:SALE_PAUSE`, version: row.pausedRevision!, value: { paused: row.paused } });
    }
    if (s.platform && s.platform.pausedRevision > 0) out.push({ key: 'PLATFORM:SALE_PAUSE', version: s.platform.pausedRevision, value: { paused: s.platform.paused } });
    return out;
  }

  /**
   * 시작 작업을 걸고 반복을 켠다(듣기 전에 부른다). 첫 읽기가 성공하면 준비 표시를 끝내고, 실패하면 retryMs 뒤 다시 한다.
   * 그 뒤 reconcileMs마다 runOnce를 부른다(실패는 경고 한 줄 뒤 다음 주기에 다시). 두 번 불러도 한 번만 켠다
   */
  start(readiness: { register(task: string): void; complete(task: string): void }): void {
    if (this.#cancel || this.#running || this.#stopped) return;
    const timer = this.deps.timer ?? systemTimer;
    const reconcileMs = this.deps.reconcileMs ?? CONTROL_SYNC_DEFAULTS.reconcileMs;
    const retryMs = this.deps.retryMs ?? CONTROL_SYNC_DEFAULTS.retryMs;
    readiness.register(SALE_CONTROL_READINESS_TASK);
    let first = true;
    const step = async (): Promise<void> => {
      this.#cancel = undefined;
      if (this.#stopped) return;
      try {
        await this.runOnce();
        if (first) readiness.complete(SALE_CONTROL_READINESS_TASK);
        first = false;
      } catch (err) {
        this.deps.logger?.warn({ kind: 'sale-control-reconcile', err: err instanceof Error ? err.name : 'unknown' }, first ? '판매 정지 원본을 읽지 못했다(준비 상태가 되지 않는다)' : '판매 정지 다시 맞춤 실패');
      }
      if (this.#stopped) return;
      this.#cancel = timer.after(first ? retryMs : reconcileMs, () => {
        this.#running = step().finally(() => (this.#running = undefined));
      });
    };
    this.#running = step().finally(() => (this.#running = undefined));
  }

  /** 반복을 멈추고 돌던 한 번을 기다린다 */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#cancel?.();
    this.#cancel = undefined;
    await this.#running?.catch(() => undefined);
  }
}
