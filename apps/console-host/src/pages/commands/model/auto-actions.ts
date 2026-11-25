// 걸린 자동 조치 표시(F-03-7).
// 정본: docs/features/control-tower.md §12(늘 여는 흐름 autoAction), C-T44 ⑦(시간 조건 막대·깨지면 0·풀린 지 10분 '최근 풀림'),
// packages/console-contract HostState.autoActions({name,target,state,startedAt}). autoAction 본문 모양은 wbs 0.2.3 전이라
// 이름·상태만 쓰고 값이 없으면 '원천 연결 전'으로 둔다(0으로 그리지 않는다).

export const RECENTLY_CLEARED_MS = 10 * 60_000;

export interface AutoActionLike {
  name: string;
  target?: string;
  state: string;
  startedAt?: string;
  endedAt?: string;
  condition?: { startedAt?: string; durationMs?: number };
}

export interface AutoActionRow {
  name: string;
  target: string;
  state: string;
  startedAt: string | null;
  progress: { elapsedMs: number; remainingMs: number; ratio: number } | null;
}

const TERMINAL = new Set(['CLEARED', 'RELEASED', 'ENDED']);
const isTerminal = (a: AutoActionLike): boolean => TERMINAL.has(a.state) || typeof a.endedAt === 'string';

function progressOf(a: AutoActionLike, nowMs: number): AutoActionRow['progress'] {
  const c = a.condition;
  if (!c || typeof c.startedAt !== 'string' || !Number.isFinite(c.durationMs) || (c.durationMs ?? 0) <= 0) return null;
  const start = Date.parse(c.startedAt);
  if (!Number.isFinite(start)) return null;
  const duration = c.durationMs as number;
  const elapsedMs = Math.max(0, Math.min(duration, nowMs - start));
  return { elapsedMs, remainingMs: duration - elapsedMs, ratio: elapsedMs / duration };
}

export function autoActionView(list: readonly AutoActionLike[], nowMs: number): {
  stuck: AutoActionRow[];
  recentlyCleared: AutoActionRow[];
  unavailable: boolean;
  message: string;
} {
  const stuck: AutoActionRow[] = [];
  const recentlyCleared: AutoActionRow[] = [];
  for (const a of list) {
    const row: AutoActionRow = {
      name: a.name,
      target: a.target ?? '',
      state: a.state,
      startedAt: typeof a.startedAt === 'string' ? a.startedAt : null,
      progress: progressOf(a, nowMs),
    };
    if (isTerminal(a)) {
      const ended = a.endedAt ? Date.parse(a.endedAt) : Number.NaN;
      if (Number.isFinite(ended) && nowMs - ended >= 0 && nowMs - ended <= RECENTLY_CLEARED_MS) recentlyCleared.push(row);
    } else {
      stuck.push(row);
    }
  }
  return {
    stuck,
    recentlyCleared,
    unavailable: list.length === 0,
    message: list.length === 0 ? '걸린 자동 조치 원천 연결 전' : '',
  };
}
