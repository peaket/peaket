// 로컬·시험용 롤아웃 원천. 운영은 Argo Rollouts API를 읽는다(구간 5, INF-020).
import { readFile } from 'node:fs/promises';
import { ROLLOUT_PHASES, type RolloutPhase, type RolloutSource, type RolloutView } from '../guard.js';

const PHASES = new Set<string>(ROLLOUT_PHASES);

export class FileRolloutSource implements RolloutSource {
  constructor(private readonly file: string) {}

  async list(): Promise<readonly RolloutView[]> {
    const raw: unknown = JSON.parse(await readFile(this.file, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('롤아웃 파일은 배열이어야 합니다');
    return raw.map((item, i) => {
      if (item === null || typeof item !== 'object') throw new Error(`롤아웃[${i}]가 객체가 아닙니다`);
      const r = item as Record<string, unknown>;
      const { name, namespace, workload, phase } = r;
      if (typeof name !== 'string' || !name) throw new Error(`롤아웃[${i}].name이 없습니다`);
      if (typeof namespace !== 'string' || !namespace) throw new Error(`롤아웃[${i}].namespace가 없습니다`);
      if (typeof workload !== 'string' || !workload) throw new Error(`롤아웃[${i}].workload가 없습니다`);
      if (typeof phase !== 'string' || !PHASES.has(phase)) throw new Error(`롤아웃[${i}].phase가 모르는 값입니다`);
      return { name, namespace, workload, phase: phase as RolloutPhase };
    });
  }
}
