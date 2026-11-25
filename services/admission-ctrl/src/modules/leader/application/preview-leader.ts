// 빈 뼈대(F-02-5 확인용): 심볼과 꼴만 있고 셈은 아직 없다. 다음 구현 커밋이 실제 값을 채운다.
export const ADMISSION_PREVIEW_KEYS: readonly string[] = [];
export const PREVIEW_MAX_KEYS = 16;

export interface PreviewLeaderResult {
  readonly status: 'OK' | 'NOT_LEADER';
  readonly counts: readonly unknown[];
  readonly unavailable: readonly unknown[];
}

export class LeaderCycleSnapshots {
  record(_scope: string, _atMs: number, _values: Record<string, number>): void {}

  latest(_scope: string): unknown {
    return undefined;
  }
}

export class PreviewLeader {
  constructor(_o: unknown) {}

  run(_q: { scope: string; keys: readonly string[] }): PreviewLeaderResult {
    return { status: 'OK', counts: [], unavailable: [] };
  }
}
