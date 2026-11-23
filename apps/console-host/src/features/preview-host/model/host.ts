// 호스트 상태(docs/frontend.md §3.10). 슬라이스: session·scope·control·autoActions·alerts·commands·presence.
// 퍼블리싱 단계라 값은 목업(entities)이다. 목업 entities에 기대므로 shared가 아니라 features 층에 둔다. 화면은 usePreviewHost()로 보드 상태에 맞는 값을 잠깐 덮어쓴다.
// 늘 여는 흐름이 열리면 접속자·승인 대기·경보 수·자동 제어는 실제 값(shared/model/live-host)으로 덮는다(OPS-340, ADR-0360). 경보 수는 펼친 걸린 경보만 센다
// (접힌 경보는 빼고, F-03-3 shared/model/alert-fold). 나머지 칸은 데이터 연결 단계에서 채우고 preview 층은 걷어 낸다(ADR-0170).
import { useLayoutEffect } from 'react';
import { useSearchParams } from 'react-router';
import { create } from 'zustand';
import type { ConsoleRole, ControlStatus } from '@peaket/ds/ConsoleShell';
import { designationsOf, isDesignationChoice, isRole, OPERATORS, type Designation, type DesignationChoice } from '@/entities/operator';
import { CURRENT_RUN } from '@/entities/event-run';
import { useLiveHost, type LiveControl } from '@/shared/model/live-host';
import { firingCounts, foldAlerts } from '@/shared/model/alert-fold';

export interface HostState {
  /** 환경 배지(운영 환경 · 데모 환경) */
  env: { label: string; short: string };
  session: { name: string; initial: string; email: string; role: ConsoleRole; designations: readonly Designation[] };
  scope: { eventId: string | null; event: { label: string; short: string } | null; stage?: string; tab?: string };
  /** null이면 위 상태 바에 자동 제어 표시를 두지 않는다(활성 회차 없음) */
  control: ControlStatus | null;
  autoActions: { count: number; needsHuman: boolean };
  alerts: { sev1: number; sev2: number; sev3: number; note?: string };
  commands: { myApprovals: number };
  presence: { operators: number };
  /** 위 상태 바의 KST 시계(목업 고정 값) */
  clock: string;
}

export type HostPatch = {
  [K in keyof HostState]?: K extends 'control' ? ControlStatus | null : HostState[K] extends object ? Partial<HostState[K]> : HostState[K];
};

const BASE: HostState = {
  env: { label: '운영 환경', short: '운영' },
  session: { ...OPERATORS.commander, designations: [] },
  scope: { eventId: CURRENT_RUN.id, event: { label: CURRENT_RUN.label, short: CURRENT_RUN.short }, stage: '판매 중' },
  control: { kind: 'ok' },
  autoActions: { count: 0, needsHuman: false },
  alerts: { sev1: 0, sev2: 1, sev3: 4 },
  commands: { myApprovals: 1 },
  presence: { operators: 3 },
  clock: '20:41:07 KST',
};

interface HostStore {
  /** 주소의 ?role=로 고른 역할(이동해도 남는다) */
  role: ConsoleRole;
  /** 주소의 ?designation=으로 고른 지정(이동해도 남는다). null이면 고르지 않음 */
  designation: DesignationChoice | null;
  /** 화면이 보드 상태에 맞춰 덮어쓴 값(화면을 떠나면 지운다) */
  preview: HostPatch;
  setRole(role: ConsoleRole): void;
  setDesignation(choice: DesignationChoice): void;
  setPreview(patch: HostPatch): void;
  clearPreview(): void;
}

export const useHostStore = create<HostStore>()((set) => ({
  role: 'commander',
  designation: null,
  preview: {},
  setRole: (role) => set({ role }),
  setDesignation: (designation) => set({ designation }),
  setPreview: (preview) => set({ preview }),
  clearPreview: () => set({ preview: {} }),
}));

/** 셸·화면이 읽는 호스트 상태(기본값 ← 역할 ← 화면 덮어쓰기) */
export function useHost(): HostState {
  const role = useHostStore((s) => s.role);
  const p = useHostStore((s) => s.preview);
  const designation = useHostStore((s) => s.designation);
  const roleSession = OPERATORS[role];
  // 지정은 화면 덮어쓰기(보드의 사람)보다 주소에서 고른 값이 이긴다
  const chosen = designation ? { designations: designationsOf(designation) } : {};
  // 늘 여는 흐름이 열려 있으면 접속자 수·내 승인 대기 수·걸린 경보 수를 실제 값으로 덮는다(화면 덮어쓰기가 이긴다, ADR-0360)
  const connected = useLiveHost((s) => s.connected);
  const livePresence = useLiveHost((s) => s.presence.length);
  const livePending = useLiveHost((s) => s.commands.pending.length);
  const liveAlerts = useLiveHost((s) => s.alerts);
  const liveControl = useLiveHost((s) => s.control);
  const counts = firingCounts(foldAlerts(liveAlerts).shown);
  const live = connected
    ? { presence: { operators: livePresence }, myApprovals: livePending, alerts: counts, control: controlStatusOf(liveControl) }
    : { presence: {}, myApprovals: undefined, alerts: {}, control: undefined };
  const session = { ...BASE.session, ...roleSession, designations: [] as readonly Designation[], ...p.session, ...chosen };
  return {
    env: { ...BASE.env, ...p.env },
    session,
    scope: { ...BASE.scope, ...p.scope },
    control: p.control !== undefined ? p.control : live.control !== undefined ? live.control : BASE.control,
    autoActions: { ...BASE.autoActions, ...p.autoActions },
    alerts: { ...BASE.alerts, ...live.alerts, ...p.alerts },
    commands: { myApprovals: session.role === 'viewer' ? 0 : (live.myApprovals ?? BASE.commands.myApprovals), ...p.commands },
    presence: { ...BASE.presence, ...live.presence, ...p.presence },
    clock: p.clock ?? BASE.clock,
  };
}

/** 호스트 control 슬라이스를 위 상태 바 배지 값으로(모르면 배지를 두지 않는다) */
function controlStatusOf(c: LiveControl): ControlStatus | null {
  switch (c.kind) {
    case 'ok':
    case 'raise-stopped':
    case 'no-input':
    case 'emergency-stop':
      return { kind: c.kind };
    case 'paused':
      return { kind: 'paused', remaining: '' };
    default:
      return null;
  }
}

/**
 * 화면이 보드 상태에 맞춰 위 상태 바 값을 바꾼다. 화면을 떠나면 되돌린다.
 * 예: usePreviewHost({ control: { kind: 'no-input' }, alerts: { sev2: 2 } }, [state])
 */
export function usePreviewHost(patch: HostPatch, deps: unknown[]) {
  const setPreview = useHostStore((s) => s.setPreview);
  const clear = useHostStore((s) => s.clearPreview);
  useLayoutEffect(() => {
    setPreview(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useLayoutEffect(() => clear, [clear]);
}

/** 고른 지정(?designation= 또는 앞서 고른 값). 고르지 않았으면 null */
export function useChosenDesignation(): DesignationChoice | null {
  const [params] = useSearchParams();
  const stored = useHostStore((s) => s.designation);
  const p = params.get('designation');
  if (isDesignationChoice(p)) return p;
  return stored;
}

/**
 * 고른 역할. 주소의 ?role= 또는 앞서 고른 역할(이동해도 남는다)이다. 고르지 않았으면 null(보드의 역할을 쓴다).
 * 처음 값 commander를 다시 고르고 다른 화면으로 옮기면 고르지 않은 것과 같게 본다(퍼블리싱 한계).
 */
export function useChosenRole(): ConsoleRole | null {
  const [params] = useSearchParams();
  const stored = useHostStore((s) => s.role);
  const p = params.get('role');
  if (isRole(p)) return p;
  return stored !== 'commander' ? stored : null;
}
