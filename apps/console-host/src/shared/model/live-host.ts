// 호스트 실시간 상태(docs/frontend.md §3.10, ADR-0092 결정 3, ADR-0360). 늘 여는 흐름(GET /v1/ops/live)이 채우는 슬라이스:
// alerts(경보, 500건 [가정]·풀린 지 60분 [가정]. 처음 열 때와 reset 뒤 경보 목록 REST로 갈아 끼운다, F-03-3), presence(고른 회차의 접속자), commands(내 승인 대기),
// control(늘 여는 흐름 control 사건 본문 그대로, F-03-3 OPS-380)·autoActions(원천 기능이 사건을 내면 채운다).
// 원격 위젯은 이 저장소를 바꾸지 못하고 HostView(@peaket/console-contract)로만 읽는다. 퍼블리싱 목업 저장소(features/preview-host)와 따로 둔다.
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { HostAlert, HostOperator, HostState } from '@peaket/console-contract';

/** 경보 상한 500건 [가정](frontend §3.10 '들고 있는 양의 상한') */
export const ALERTS_MAX = 500;
/** 풀린 경보를 두는 시간 60분 [가정] */
export const RESOLVED_KEEP_MS = 60 * 60_000;
/** 들고 있는 자동 조치 상한(들고 있는 양의 상한, frontend §3.10) */
export const AUTO_ACTIONS_MAX = 50;
/** 풀린 자동 조치를 '최근 풀림'으로 두는 시간 10분 [가정](C-T44 ⑦) */
export const AUTO_ACTION_KEEP_MS = 10 * 60_000;

export interface PendingApproval {
  commandId: string;
  type: string;
  state: string;
  eventId?: string;
  approvalExpiresAt?: string;
}

/** 경보 한 건(asyncapi OpsAlert의 콘솔 몫). 원격에 넘기는 HostAlert 칸에 경보 패널이 쓰는 칸을 더한다 */
export interface LiveAlert extends HostAlert {
  sourceKind?: string;
  journey?: string;
  foldedUnder?: string;
  runbookUrl?: string;
  dashboardUrl?: string;
  exploreUrl?: string;
  dependency?: string;
}

/** 자동 제어 상태(asyncapi OpsControl 본문 그대로, 원격에는 kind·updatedAt이 HostState.control 모양으로 보인다) */
type HostControl = HostState['control'];
export interface LiveControl extends HostControl {
  eventId?: string;
  since?: string;
  inputStaleKinds?: readonly string[];
  targetNow?: number;
  budgetHoldAt?: string;
  lastDecrease?: { reason?: string; journey?: string; from?: number; to?: number; exposureReduction?: boolean };
}

/** 늘 여는 흐름 autoAction 사건의 콘솔 몫. 본문 모양은 wbs 0.2.3 전이라 console-contract의 칸과 끝난 시각만 읽는다 */
export interface LiveAutoAction {
  name: string;
  target?: string;
  state: string;
  startedAt?: string;
  endedAt?: string;
}

export interface LiveHostState extends HostState {
  control: LiveControl;
  alerts: readonly LiveAlert[];
  /** 늘 여는 흐름이 열려 있는가 */
  connected: boolean;
  /** 내 승인 대기(approval 사건으로 들어오고, 그 명령의 command 사건이 승인 대기가 아니면 빠진다) */
  commands: { pending: readonly PendingApproval[] };
  /** reset을 받거나 다시 연 뒤 화면이 REST로 다시 읽을 때 올리는 번호 */
  resyncSeq: number;
}

export const INITIAL_HOST: LiveHostState = {
  scope: { eventId: null },
  control: { kind: 'unknown' },
  autoActions: [],
  alerts: [],
  presence: [],
  connected: false,
  commands: { pending: [] },
  resyncSeq: 0,
};

/** 경보 하나를 합친다(같은 alertId는 바꾼다). 풀린 지 오래된 것부터 버려 상한을 지킨다 */
export function mergeAlert(list: readonly LiveAlert[], a: LiveAlert, nowMs: number): LiveAlert[] {
  const rest = list.filter((x) => x.alertId !== a.alertId);
  const next = [a, ...rest].filter((x) => x.status === 'firing' || !x.endsAt || nowMs - Date.parse(x.endsAt) <= RESOLVED_KEEP_MS);
  if (next.length <= ALERTS_MAX) return next;
  const firing = next.filter((x) => x.status === 'firing');
  const resolved = next.filter((x) => x.status !== 'firing').sort((p, q) => Date.parse(q.endsAt ?? q.startsAt) - Date.parse(p.endsAt ?? p.startsAt));
  return [...firing, ...resolved].slice(0, ALERTS_MAX);
}

/** 경보 목록 REST로 슬라이스를 갈아 끼운다(같은 규칙으로 상한·60분을 지킨다) */
export function alertsFromList(items: readonly LiveAlert[], nowMs: number): LiveAlert[] {
  let next: LiveAlert[] = [];
  for (const a of [...items].reverse()) next = mergeAlert(next, a, nowMs);
  return next;
}

const AUTO_ACTION_TERMINAL = new Set(['CLEARED', 'RELEASED', 'ENDED']);

/** 자동 조치 하나를 합친다(같은 이름·대상은 바꾼다). 풀린 지 10분이 지난 것과 상한 밖은 버린다 */
export function mergeAutoAction(list: readonly LiveAutoAction[], a: LiveAutoAction, nowMs: number): LiveAutoAction[] {
  const rest = list.filter((x) => !(x.name === a.name && (x.target ?? '') === (a.target ?? '')));
  const next = [a, ...rest].filter((x) => {
    const terminal = AUTO_ACTION_TERMINAL.has(x.state) || typeof x.endedAt === 'string';
    if (!terminal) return true;
    const ended = x.endedAt ? Date.parse(x.endedAt) : Number.NaN;
    return Number.isFinite(ended) && nowMs - ended <= AUTO_ACTION_KEEP_MS;
  });
  return next.slice(0, AUTO_ACTIONS_MAX);
}

const PENDING = new Set(['PENDING_APPROVAL', 'REVERT_PENDING']);

/** 명령 사건으로 승인 대기 목록을 고친다(승인 대기가 아닌 상태가 오면 뺀다) */
export function settlePending(list: readonly PendingApproval[], commandId: string, state: string): PendingApproval[] {
  return PENDING.has(state) ? [...list] : list.filter((p) => p.commandId !== commandId);
}

export const hostStore = createStore<LiveHostState>()(() => INITIAL_HOST);

/** 사건마다 고치는 동작(이름은 frontend §4.7 동작 이름 규칙: 슬라이스/동작) */
export const hostActions = {
  connected(on: boolean): void {
    hostStore.setState({ connected: on });
  },
  scope(eventId: string | null): void {
    const s = hostStore.getState();
    if (s.scope.eventId === eventId) return;
    hostStore.setState({ scope: { ...s.scope, eventId }, presence: [] });
  },
  alert(a: LiveAlert, nowMs = Date.now()): void {
    hostStore.setState((s) => ({ alerts: mergeAlert(s.alerts, a, nowMs) }));
  },
  /** 경보 목록(REST)으로 갈아 끼우고, 그 뒤에 온 사건(after)을 차례대로 다시 얹는다 */
  replaceAlerts(items: readonly LiveAlert[], after: readonly LiveAlert[] = [], nowMs = Date.now()): void {
    let next = alertsFromList(items, nowMs);
    for (const a of after) next = mergeAlert(next, a, nowMs);
    hostStore.setState({ alerts: next });
  },
  presence(eventId: string, operators: readonly HostOperator[]): void {
    const s = hostStore.getState();
    if (s.scope.eventId !== eventId) return;
    hostStore.setState({ presence: [...operators] });
  },
  approval(p: PendingApproval): void {
    hostStore.setState((s) => ({ commands: { pending: [p, ...s.commands.pending.filter((x) => x.commandId !== p.commandId)] } }));
  },
  /** reset 뒤 REST로 다시 읽은 승인 대기로 바꾼다 */
  replacePending(list: readonly PendingApproval[]): void {
    hostStore.setState({ commands: { pending: [...list] } });
  },
  command(commandId: string, state: string): void {
    hostStore.setState((s) => ({ commands: { pending: settlePending(s.commands.pending, commandId, state) } }));
  },
  /** control 사건 본문 그대로 넣는다 */
  control(body: LiveControl): void {
    hostStore.setState({ control: body });
  },
  /** autoAction 사건(걸린 자동 조치·풀림)을 넣는다. 같은 이름·대상은 바꾸고, 풀린 지 10분이 지나면 버린다 */
  autoAction(a: LiveAutoAction, nowMs = Date.now()): void {
    hostStore.setState((s) => ({ autoActions: mergeAutoAction(s.autoActions as readonly LiveAutoAction[], a, nowMs) }));
  },
  resync(): void {
    hostStore.setState((s) => ({ resyncSeq: s.resyncSeq + 1 }));
  },
};

/** 화면이 읽는다 */
export function useLiveHost<T>(select: (s: LiveHostState) => T): T {
  return useStore(hostStore, select);
}
