// 파드 메모리의 판매 일시정지(명령 3)·판매 중지 상태(F-02-1 OPS-300, ADR-0365 결정 7·8). 받는 쪽 쓰기(SetSalePause·SetSaleSuspension)와
// 2초 [가정] 다시 맞춤(SaleControlReconciler)이 채우고, 결제 시도·결제 접수의 정지 확인과 구매 세션 정리의 유휴 시계가 읽는다.
// 판 번호가 지금보다 클 때만 바꾼다(종류마다 따로, ADR-0365 결정 6). 그래서 늦게 끝난 다시 맞춤이 방금 받은 제어를 되돌리지 못한다.
import type { SalePauseView } from '../domain/ports.js';
import type { SaleControlSnapshot } from '../domain/sale-control.js';

interface PauseCell {
  readonly paused: boolean;
  readonly revision: number;
  readonly changedAtMs?: number;
}

interface SuspensionCell {
  readonly suspended: boolean;
  readonly revision: number;
}

export class SaleControlMemory implements SalePauseView {
  readonly #pauses = new Map<string, PauseCell>();
  readonly #suspensions = new Map<string, SuspensionCell>();
  #platform: PauseCell | undefined;
  #loaded = false;

  /** 원본을 한 번이라도 읽었는가 */
  get loaded(): boolean {
    return this.#loaded;
  }

  /** 명령 3을 반영한다(eventId가 없으면 전체 범위). 바꿨으면 참 */
  applyPause(eventId: string | undefined, cell: PauseCell): boolean {
    const cur = eventId === undefined ? this.#platform : this.#pauses.get(eventId);
    if (cur && cell.revision <= cur.revision) return false;
    const next: PauseCell = { paused: cell.paused, revision: cell.revision, ...(cell.changedAtMs !== undefined ? { changedAtMs: cell.changedAtMs } : {}) };
    if (eventId === undefined) this.#platform = next;
    else this.#pauses.set(eventId, next);
    return true;
  }

  /** 판매 중지를 반영한다. 바꿨으면 참 */
  applySuspension(eventId: string, cell: SuspensionCell): boolean {
    const cur = this.#suspensions.get(eventId);
    if (cur && cell.revision <= cur.revision) return false;
    this.#suspensions.set(eventId, { suspended: cell.suspended, revision: cell.revision });
    return true;
  }

  /** 원본 전체를 반영한다(다시 맞춤 한 번) */
  load(s: SaleControlSnapshot): void {
    for (const row of s.events) {
      const pausedRevision = row.pausedRevision ?? 0;
      if (pausedRevision > 0) this.applyPause(row.eventId, { paused: row.paused, revision: pausedRevision, ...(row.pausedChangedAtMs !== undefined ? { changedAtMs: row.pausedChangedAtMs } : {}) });
      this.applySuspension(row.eventId, { suspended: row.suspended, revision: row.revision });
    }
    if (s.platform && s.platform.pausedRevision > 0) {
      this.applyPause(undefined, { paused: s.platform.paused, revision: s.platform.pausedRevision, ...(s.platform.pausedChangedAtMs !== undefined ? { changedAtMs: s.platform.pausedChangedAtMs } : {}) });
    }
    this.#loaded = true;
  }

  stopped(eventId: string): boolean {
    return this.#platform?.paused === true || this.#pauses.get(eventId)?.paused === true || this.#suspensions.get(eventId)?.suspended === true;
  }

  idleRule(eventId: string): { readonly paused: true } | { readonly paused: false; readonly releasedAtMs?: number } {
    const event = this.#pauses.get(eventId);
    const platform = this.#platform;
    if (event?.paused === true || platform?.paused === true) return { paused: true };
    // 풀린 시각: 정지였다가 지금 풀린 범위(회차·전체)의 바뀐 시각 가운데 늦은 것
    const released = [event, platform].flatMap((c) => (c !== undefined && c.changedAtMs !== undefined ? [c.changedAtMs] : []));
    return released.length > 0 ? { paused: false, releasedAtMs: Math.max(...released) } : { paused: false };
  }
}
