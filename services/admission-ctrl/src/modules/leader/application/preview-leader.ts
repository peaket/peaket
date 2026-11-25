// 사전 모의(PreviewControl)를 위한 admission-ctrl 리더 주기 값(F-02-5 OPS-300, ADR-0365 결정 11·16, C-T6 ①).
// 리더가 회차마다 주기 끝에 남긴 마지막 값을 메모리에 둔다. 읽기 전용이고, 리더가 아니면 답하지 않는다.
import type { PreviewUnavailable } from '../domain/preview-types.js';

export const ADMISSION_PREVIEW_KEYS = ['currentTarget', 'slotsUsed', 'soonAdmitted', 'inFlight', 'admitRatio', 'avgDwellSeconds', 'servingRateCap', 'servingRate'] as const;
export const PREVIEW_MAX_KEYS = 16;

interface Cycle {
  readonly atMs: number;
  readonly values: Readonly<Record<string, number>>;
}

/** 회차마다 마지막 리더 주기 값(파드 메모리). 리더가 바뀌면 새 파드는 이 값을 갖지 않는다(no-cycle) */
export class LeaderCycleSnapshots {
  readonly #latest = new Map<string, Cycle>();

  record(eventId: string, atMs: number, values: Readonly<Record<string, number>>): void {
    this.#latest.set(eventId, { atMs, values: { ...values } });
  }

  latest(eventId: string): Cycle | undefined {
    return this.#latest.get(eventId);
  }

  forget(eventId: string): void {
    this.#latest.delete(eventId);
  }
}

export type PreviewLeaderResult =
  | { readonly status: 'OK'; readonly counts: readonly { key: string; value: number; source: string; measuredAtMs: number }[]; readonly unavailable: readonly PreviewUnavailable[] }
  | { readonly status: 'NOT_LEADER' };

/** 리더만 답하는 읽기 전용 사전 모의 */
export class PreviewLeader {
  constructor(private readonly deps: { readonly elector: { isLeader(): boolean }; readonly snapshots: LeaderCycleSnapshots }) {}

  run(q: { readonly scope: string; readonly keys: readonly string[] }): PreviewLeaderResult {
    if (!this.deps.elector.isLeader()) return { status: 'NOT_LEADER' };
    const cycle = this.deps.snapshots.latest(q.scope);
    const counts: { key: string; value: number; source: string; measuredAtMs: number }[] = [];
    const unavailable: PreviewUnavailable[] = [];
    for (const key of q.keys) {
      if (!(ADMISSION_PREVIEW_KEYS as readonly string[]).includes(key)) {
        unavailable.push({ key, reason: 'unknown-key' });
        continue;
      }
      if (!cycle) {
        unavailable.push({ key, reason: 'no-cycle' });
        continue;
      }
      const value = cycle.values[key];
      if (value === undefined) unavailable.push({ key, reason: 'no-source' });
      else counts.push({ key, value, source: 'leader-cycle', measuredAtMs: cycle.atMs });
    }
    return { status: 'OK', counts, unavailable };
  }
}
