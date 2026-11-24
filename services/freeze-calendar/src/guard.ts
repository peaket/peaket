// 변경 동결 자동 중단(freeze-guard, F-02-3, docs/devops.md §8.1·§8.2, D-T3).
// 대형·중형은 T-45분, 소형은 T-15분에 아직 도는 롤아웃을 중단한다. 권한은 롤아웃 읽기와 중단뿐이다(구간 5에서 RBAC).
import type { FreezeCalendar, FreezeWindow } from './calendar.js';

export const ROLLOUT_PHASES = ['Progressing', 'Paused', 'Healthy', 'Degraded', 'Aborted'] as const;
export type RolloutPhase = (typeof ROLLOUT_PHASES)[number];

export interface RolloutView {
  readonly name: string;
  readonly namespace: string;
  /** 핫패스 판정에 쓰는 배포 단위 이름(예: queue-svc) */
  readonly workload: string;
  readonly phase: RolloutPhase;
}

/** 소형 창에서 막는 핫패스 배포 단위(docs/devops.md §8.1의 목록을 배포 단위 이름으로 옮긴 것) */
export const HOTPATH_WORKLOADS = new Set([
  'gw-queue',
  'gw-fan',
  'queue-svc',
  'admission-ctrl',
  'purchase-svc',
  'payment-svc',
  'realtime-gw',
  'identity-svc',
  'web',
  'queue-room',
]);

/** 중단할 수 있는 상태(진행 중). 이미 끝난 롤아웃은 건드리지 않는다 */
const ABORTABLE = new Set<RolloutPhase>(['Progressing', 'Paused']);

const inAbortWindow = (w: FreezeWindow, nowMs: number): boolean => Date.parse(w.abortAt) <= nowMs && nowMs < Date.parse(w.endsAt);

/**
 * 지금 중단할 롤아웃. `abortAt ≤ now < endsAt`인 창의 범위 안에서만 고른다.
 * 대형·중형(`scope=all`)은 모든 롤아웃, 소형(`scope=hotpath`)은 핫패스 배포 단위만.
 */
export function guardPlan(calendar: FreezeCalendar, rollouts: readonly RolloutView[], nowMs: number): RolloutView[] {
  const windows = calendar.windows.filter((w) => inAbortWindow(w, nowMs));
  if (windows.length === 0) return [];
  const all = windows.some((w) => w.scope === 'all');
  const hotpath = windows.some((w) => w.scope === 'hotpath');
  const seen = new Set<string>();
  const out: RolloutView[] = [];
  for (const r of rollouts) {
    if (!ABORTABLE.has(r.phase)) continue;
    if (!all && !(hotpath && HOTPATH_WORKLOADS.has(r.workload))) continue;
    const key = `${r.namespace}/${r.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export interface FreezeCalendarSource {
  read(): Promise<FreezeCalendar>;
}

export interface RolloutSource {
  list(): Promise<readonly RolloutView[]>;
}

export interface RolloutAborter {
  abort(rollout: RolloutView): Promise<void>;
}

export interface GuardDeps {
  readonly calendar: FreezeCalendarSource;
  readonly rollouts: RolloutSource;
  readonly aborter: RolloutAborter;
  readonly now: () => number;
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface GuardRun {
  readonly result: 'no-window' | 'aborted' | 'idle' | 'failed';
  readonly aborted: readonly string[];
  readonly errors?: readonly string[];
}

/**
 * 가드 한 번 실행(1분 주기 CronJob이 부른다, devops §8.2).
 * 창 밖이면 롤아웃 목록을 부르지 않는다. 목록·중단 실패는 실패로 남기고 다른 롤아웃을 대신 건드리지 않는다.
 */
export async function runGuardOnce(deps: GuardDeps): Promise<GuardRun> {
  const log = deps.log ?? (() => {});
  const nowMs = deps.now();
  let calendar: FreezeCalendar;
  try {
    calendar = await deps.calendar.read();
  } catch (err) {
    log({ kind: 'deploy', event: 'freeze_guard_failed', reason: 'calendar-unreadable', message: err instanceof Error ? err.message : String(err) });
    return { result: 'failed', aborted: [], errors: ['calendar-unreadable'] };
  }
  const windows = calendar.windows.filter((w) => inAbortWindow(w, nowMs));
  if (windows.length === 0) return { result: 'no-window', aborted: [] };

  let rollouts: readonly RolloutView[];
  try {
    rollouts = await deps.rollouts.list();
  } catch (err) {
    log({ kind: 'deploy', event: 'freeze_guard_failed', reason: 'rollouts-unavailable', message: err instanceof Error ? err.message : String(err) });
    return { result: 'failed', aborted: [], errors: ['rollouts-unavailable'] };
  }
  const plan = guardPlan(calendar, rollouts, nowMs);
  if (plan.length === 0) return { result: 'idle', aborted: [] };

  const aborted: string[] = [];
  const errors: string[] = [];
  for (const r of plan) {
    try {
      await deps.aborter.abort(r);
      aborted.push(r.name);
      log({ kind: 'deploy', event: 'freeze_rollout_aborted', namespace: r.namespace, rollout: r.name, workload: r.workload });
    } catch (err) {
      errors.push(`${r.namespace}/${r.name}`);
      log({
        kind: 'deploy',
        event: 'freeze_guard_abort_failed',
        namespace: r.namespace,
        rollout: r.name,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return errors.length > 0 ? { result: 'failed', aborted, errors } : { result: 'aborted', aborted };
}
