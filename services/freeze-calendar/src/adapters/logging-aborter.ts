// 로컬·시험용 중단 어댑터. 실제 Argo Rollouts 패치 대신 로그만 남긴다.
// 운영 어댑터(롤아웃 읽기·중단 패치, RBAC)는 구간 5(INF-020)다.
import type { RolloutAborter, RolloutView } from '../guard.js';

export class LoggingAborter implements RolloutAborter {
  constructor(private readonly log: (line: Record<string, unknown>) => void = () => {}) {}

  async abort(rollout: RolloutView): Promise<void> {
    this.log({ kind: 'deploy', event: 'freeze_guard_dry_run', namespace: rollout.namespace, rollout: rollout.name, workload: rollout.workload });
  }
}
