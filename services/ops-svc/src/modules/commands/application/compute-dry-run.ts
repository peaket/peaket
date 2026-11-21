// dry-run 계산(ADR-0340 결정 2). 미리보기(저장하지 않음)와 접수(DRY_RUN 사건에 기록)가 같은 함수를 쓴다.
// 센 값은 유형별 DryRunSource로 세고, 원천이 없거나 실패하면 unavailable에 적는다(접수를 막지 않는다). 예측 식은 명령 1만이다.
import { DEFAULT_PROTECTED_RANGES, type ProtectedRangeList } from '../domain/protected-ranges.js';
import { blockApprovalOfParams, reauthRequiredFor, approvalModeOf, type CommandType } from '../domain/command.js';
import { DRY_RUN_KEYS, DRY_RUN_VERSION, limitsOf, predictionsOf, type CommandDryRun, type DryRunCountResult, type DryRunSource, type DryRunTarget } from '../domain/dry-run.js';
import { noCommandSignals, type CommandSignals } from '../domain/ports.js';

export interface ComputeDryRunDeps {
  /** 유형별 센 값 원천. 없는 유형은 기본 원천(fallback)을 쓴다 */
  readonly sources?: Partial<Record<CommandType, DryRunSource>>;
  /** 등록하지 않은 유형의 원천(기본 unavailable 어댑터) */
  readonly fallback?: DryRunSource;
  readonly protectedRanges?: ProtectedRangeList;
  readonly signals?: CommandSignals;
}

export class ComputeDryRun {
  readonly protectedRanges: ProtectedRangeList;

  constructor(private readonly deps: ComputeDryRunDeps = {}) {
    this.protectedRanges = deps.protectedRanges ?? DEFAULT_PROTECTED_RANGES;
  }

  /** 유형별로 세는 값 이름 */
  keysOf(type: CommandType): readonly string[] {
    return DRY_RUN_KEYS[type] ?? [];
  }

  sourceOf(type: CommandType): DryRunSource | undefined {
    return this.deps.sources?.[type] ?? this.deps.fallback;
  }

  /** 원천으로 센다. 원천이 없거나 던지면 모든 값을 unavailable로 적는다(빈 결과를 0으로 읽지 않는다) */
  async count(target: DryRunTarget, nowMs: number): Promise<DryRunCountResult> {
    const keys = this.keysOf(target.type);
    if (keys.length === 0) return { counted: [], unavailable: [] };
    const source = this.sourceOf(target.type);
    let r: DryRunCountResult;
    if (!source) {
      r = { counted: [], unavailable: keys.map((key) => ({ key, source: 'not-wired', reason: 'source-not-wired' })) };
    } else {
      try {
        r = await source.count(target, keys, nowMs);
      } catch (e) {
        r = { counted: [], unavailable: keys.map((key) => ({ key, source: 'source', reason: `source-error:${e instanceof Error ? e.name : 'unknown'}` })) };
      }
    }
    // 원천이 답하지 않은 값도 세지 못한 것으로 남긴다
    const answered = new Set([...r.counted.map((c) => c.key), ...r.unavailable.map((u) => u.key)]);
    const unavailable = [...r.unavailable, ...keys.filter((k) => !answered.has(k)).map((key) => ({ key, source: 'source', reason: 'not-answered' }))];
    for (const u of unavailable) (this.deps.signals ?? noCommandSignals).dryRunUnavailable(target.type, u.key);
    return { counted: r.counted.filter((c) => keys.includes(c.key) && Number.isFinite(c.value)), unavailable };
  }

  /** 그 명령의 CommandDryRun(판 1). params는 접수 검사를 지난 값이어야 한다 */
  async compute(target: DryRunTarget, nowMs: number): Promise<CommandDryRun> {
    const counted = await this.count(target, nowMs);
    const prediction = predictionsOf(target.type, target.params, counted.counted);
    const approvalMode = approvalModeOf(target.type, target.params as Record<string, unknown>, this.protectedRanges);
    const block = target.type === 'BLOCK_ASN_IP' ? blockApprovalOfParams(target.params as Record<string, unknown>, this.protectedRanges) : undefined;
    return {
      version: DRY_RUN_VERSION,
      approvalMode,
      reauthRequired: reauthRequiredFor(target.type, target.params as Record<string, unknown>, this.protectedRanges),
      counted: counted.counted,
      predicted: prediction.predicted,
      unavailable: [...counted.unavailable, ...prediction.unavailable],
      limits: limitsOf(target.type),
      ...(block ? { protectedRangeHits: block.hits, protectedRangesVersion: this.protectedRanges.version } : {}),
    };
  }
}
