// dry-run 센 값 원천이 아직 없는 동안의 어댑터(BAT-355 계획 '감독에게' 1 (가)). 모든 값을 세지 못함(source-not-wired)으로 돌려준다.
// 실제 원천(대기열 Redis·purchase DB·게이트웨이 집계)은 BAT-365(OPS-300)가 제어 gRPC 읽기 경로로 잇는다. 빈 결과를 0으로 적지 않는다.
import type { DryRunCountResult, DryRunSource, DryRunTarget } from '../domain/dry-run.js';

export const DRY_RUN_SOURCE_NOT_WIRED = 'source-not-wired';

export class UnavailableDryRunSource implements DryRunSource {
  constructor(private readonly source: string = 'not-wired') {}

  async count(_target: DryRunTarget, keys: readonly string[]): Promise<DryRunCountResult> {
    return { counted: [], unavailable: keys.map((key) => ({ key, source: this.source, reason: DRY_RUN_SOURCE_NOT_WIRED })) };
  }
}
