// 새 결제 진입 정지 지표(docs/observability.md 운영 확인 표, ADR-0105 결정 9, BUILD_ORDER PRF-202). 다른 Prom 신호와 같은 꼴이다.
// 단계 지표는 모든 파드가 캐시한 행에서 수집 때 낸다. 행을 읽지 못하면 값을 내지 않는다(값이 없으면 '모름'이다, 열림의 0과 구분한다).
import { Counter, Gauge, type Registry } from '@peaket/platform';
import type { EntryPauseStage } from '../domain/entry-pause.js';
import type { EntryPauseProbeOutcome } from '../domain/entry-pause-judge.js';
import type { PgName } from '../domain/payment-gateway.js';
import { PG_NAMES } from '../domain/pg-call-guard.js';
import type { EntryPauseJudgeErrorWhat, EntryPauseJudgeSignals, EntryPauseReader, EntryTrialOutcome, EntryTrialSignals } from '../domain/ports.js';

const STAGE_VALUE: Readonly<Record<EntryPauseStage, number>> = { OPEN: 0, PROBING: 1, TRIAL: 2 };
const PROBE_OUTCOMES: readonly EntryPauseProbeOutcome[] = ['ok', 'fail', 'skipped'];
const TRIAL_OUTCOMES: readonly EntryTrialOutcome[] = ['admitted', 'rejected', 'success', 'failure'];
const JUDGE_ERRORS: readonly EntryPauseJudgeErrorWhat[] = ['read', 'write', 'channel', 'trial'];

export class PromEntryPauseSignals implements EntryPauseJudgeSignals, EntryTrialSignals {
  readonly #probe = new Counter({ name: 'payment_pg_probe_total', help: '정지 중 확인 호출(결제사·결과: ok 정상, fail 실패, skipped 부르지 않음)', labelNames: ['pg', 'outcome'] as const, registers: [] });
  readonly #trial = new Counter({ name: 'payment_entry_trial_total', help: '시험 재개(결제사·결과: admitted 받음, rejected 못 받음, success 5초 안 결론, failure 그 밖)', labelNames: ['pg', 'outcome'] as const, registers: [] });
  readonly #conflicts = new Counter({ name: 'payment_entry_pause_write_conflicts_total', help: '판 번호 조건에 걸려 버린 정지 행 쓰기', labelNames: ['pg'] as const, registers: [] });
  readonly #errors = new Counter({ name: 'payment_entry_pause_judge_errors_total', help: '정지 판정 틱의 읽기·쓰기 실패', labelNames: ['what'] as const, registers: [] });
  readonly #trialWrites = new Counter({ name: 'payment_entry_trial_write_failed_total', help: '시험 재개 행을 쓰지 못한 수(admit 받기, call 첫 호출 시작 시각, result 첫 승인 결과)', labelNames: ['step'] as const, registers: [] });
  readonly #leader = new Gauge({ name: 'payment_entry_pause_judge_leader', help: '이 파드가 정지 판정자인가(1 판정자, 0 아님). 모든 파드의 합이 0이면 판정자가 없다', registers: [] });

  constructor() {
    // 처음 일어나기 전에도 값을 보게 0으로 미리 보인다
    for (const pg of PG_NAMES) {
      for (const outcome of PROBE_OUTCOMES) this.#probe.inc({ pg, outcome }, 0);
      for (const outcome of TRIAL_OUTCOMES) this.#trial.inc({ pg, outcome }, 0);
      this.#conflicts.inc({ pg }, 0);
    }
    for (const what of JUDGE_ERRORS) this.#errors.inc({ what }, 0);
    for (const step of ['admit', 'call', 'result'] as const) this.#trialWrites.inc({ step }, 0);
    this.#leader.set(0);
  }

  /** 지표를 registry에 붙이고 자신을 돌려준다. 단계 지표는 pauses(파드 캐시)를 수집 때 읽는다 */
  register(registry: Registry, pauses: EntryPauseReader): this {
    registry.registerMetric(this.#probe);
    registry.registerMetric(this.#trial);
    registry.registerMetric(this.#conflicts);
    registry.registerMetric(this.#errors);
    registry.registerMetric(this.#trialWrites);
    registry.registerMetric(this.#leader);
    registry.registerMetric(
      new Gauge({
        name: 'payment_new_entry_pause_stage',
        help: '새 결제 진입 정지 단계(0 열림, 1 확인 호출, 2 시험 재개)',
        labelNames: ['pg'] as const,
        registers: [],
        async collect() {
          this.reset();
          try {
            const rows = await pauses.read({ remainingMs: 150 });
            for (const pg of PG_NAMES) this.set({ pg }, STAGE_VALUE[rows.get(pg)?.stage ?? 'OPEN']);
          } catch {
            // 값을 내지 않는다('모름')
          }
        },
      }),
    );
    return this;
  }

  probe(pg: PgName, outcome: EntryPauseProbeOutcome): void {
    this.#probe.inc({ pg, outcome });
  }

  writeConflict(pg: PgName): void {
    this.#conflicts.inc({ pg });
  }

  judgeError(what: EntryPauseJudgeErrorWhat): void {
    this.#errors.inc({ what });
  }

  trial(pg: PgName, outcome: EntryTrialOutcome): void {
    this.#trial.inc({ pg, outcome });
  }

  trialWriteFailed(step: 'admit' | 'call' | 'result'): void {
    this.#trialWrites.inc({ step });
  }

  /** Lease의 onChange가 부른다. 값이 바뀔 때만 불리므로 파드가 뜬 뒤 리더가 된 적 없으면 처음 0 그대로다 */
  judgeLeader(leader: boolean): void {
    this.#leader.set(leader ? 1 : 0);
  }
}
