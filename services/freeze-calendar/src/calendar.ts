// 변경 동결 달력의 순수 계산·렌더(F-02-3, OPS-320).
// 정본: docs/devops.md §8.1(규모별 창·자동 중단 시각), §8.2(일정 파일→freeze.json→ArgoCD/Karpenter),
// §8.5(배포 가능 시간), §14 D-T1·D-T4. 시각의 기준은 UTC이고, 크론은 UTC 5칸이다.
// 실제 S3·ArgoCD·Karpenter 연결은 포트 뒤에 두고, 이 파일은 계산과 파일 쓰기만 한다(구간 5, INF-020).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const SCALES = ['large', 'medium', 'small'] as const;
export type Scale = (typeof SCALES)[number];
export type Scope = 'all' | 'hotpath';

/** 규모별 창의 기준(분). 정본 docs/devops.md §8.1의 시각 근거와 같다 */
export const WINDOW_MINUTES = Object.freeze({
  large: { before: 90, after: 60, abortBefore: 45, scope: 'all' as Scope },
  medium: { before: 90, after: 60, abortBefore: 45, scope: 'all' as Scope },
  small: { before: 50, after: 60, abortBefore: 15, scope: 'hotpath' as Scope },
});

/** ArgoCD 가상 팀 프로젝트 아홉(docs/devops.md §5.2) */
export const ARGOCD_PROJECTS = [
  'peaket-queue',
  'peaket-purchase',
  'peaket-ticket',
  'peaket-trust',
  'peaket-core',
  'peaket-frontend',
  'peaket-data',
  'peaket-observability',
  'peaket-platform',
] as const;

/** 봇이 쓰는 경로(devops §8.2 '봇 쓰기 범위'). 바깥은 건드리지 않는다 */
export const CALENDAR_FILE = 'deploy/calendar/freeze.json';
export const ARGOCD_WINDOWS_FILE = 'deploy/calendar/rendered/argocd-windows.json';
export const KARPENTER_BUDGETS_FILE = 'deploy/calendar/rendered/karpenter-budgets.json';

/** 일정 파일이 30분 넘게 낡으면 산출물을 바꾸지 않는다(docs/devops.md §8.2 '닫힘 실패') */
export const SOURCE_STALE_MS = 30 * 60_000;
/** 앞으로 7일의 창만 계산한다 */
export const HORIZON_MS = 7 * 24 * 60 * 60_000;
/** 7일 전체 시간(시간) */
const HORIZON_HOURS = 7 * 24;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const TOP_KEYS = new Set(['revision', 'generatedAt', 'onsales']);
const ENTRY_KEYS = new Set(['eventId', 'opensAt', 'scale', 'approved']);

export interface OnsaleEntry {
  readonly eventId: string;
  readonly opensAt: string;
  readonly scale: Scale;
  /** 일정 파일은 승인된 회차만 담는다. 표시가 있으면 true만 받는다 */
  readonly approved?: true;
}

export interface OnsaleSchedule {
  readonly revision: number;
  readonly generatedAt: string;
  readonly onsales: readonly OnsaleEntry[];
}

export interface ArgoWindow {
  readonly kind: 'deny';
  readonly schedule: string;
  readonly duration: string;
  readonly manualSync: true;
  readonly applications: readonly string[];
  readonly namespaces: readonly string[];
  readonly clusters: readonly string[];
}

export interface KarpenterBudget {
  readonly schedule: string;
  readonly duration: string;
  readonly nodes: '0';
}

export interface FreezeWindow {
  readonly eventId: string;
  readonly scale: Scale;
  readonly scope: Scope;
  readonly opensAt: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly abortAt: string;
  readonly argocd: ArgoWindow;
  readonly karpenter: KarpenterBudget;
}

export interface FreezeCalendar {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly renderedAt: string;
  readonly windows: readonly FreezeWindow[];
  readonly deployableHoursNext7d: { readonly all: number; readonly hotpath: number };
}

export interface CalendarRender {
  readonly calendar: FreezeCalendar;
  readonly argocd: { readonly projects: readonly { readonly project: string; readonly windows: readonly ArgoWindow[] }[] };
  readonly karpenter: { readonly allNodePools: true; readonly budgets: readonly KarpenterBudget[] };
}

export class ScheduleError extends Error {
  override readonly name = 'ScheduleError';
  constructor(
    readonly code: 'json' | 'shape',
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function isoMs(text: string, where: string): number {
  if (typeof text !== 'string' || !ISO.test(text)) throw new ScheduleError('shape', `${where}는 ISO 8601 시각이어야 합니다: ${String(text)}`);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new ScheduleError('shape', `${where}를 읽을 수 없습니다: ${text}`);
  return ms;
}

/**
 * `ops-calendar/upcoming-onsales.json`을 엄격하게 읽는다. 모르는 칸·겹친 eventId·승인 아님·모르는 규모는 거절한다.
 * 빈 목록은 허용한다(창 0개).
 */
export function parseSchedule(text: string): OnsaleSchedule {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ScheduleError('json', '온세일 일정 파일이 JSON이 아닙니다');
  }
  if (!isRecord(doc)) throw new ScheduleError('shape', '온세일 일정 파일은 객체여야 합니다');
  for (const key of Object.keys(doc)) if (!TOP_KEYS.has(key)) throw new ScheduleError('shape', `모르는 칸이 있습니다: ${key}`);
  const revision = doc.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw new ScheduleError('shape', 'revision은 0 이상 안전한 정수여야 합니다');
  }
  const generatedAt = doc.generatedAt;
  if (typeof generatedAt !== 'string') throw new ScheduleError('shape', 'generatedAt이 없습니다');
  isoMs(generatedAt, 'generatedAt');
  if (!Array.isArray(doc.onsales)) throw new ScheduleError('shape', 'onsales는 배열이어야 합니다');

  const seen = new Set<string>();
  const onsales: OnsaleEntry[] = doc.onsales.map((raw, i) => {
    if (!isRecord(raw)) throw new ScheduleError('shape', `onsales[${i}]는 객체여야 합니다`);
    for (const key of Object.keys(raw)) if (!ENTRY_KEYS.has(key)) throw new ScheduleError('shape', `onsales[${i}]에 모르는 칸이 있습니다: ${key}`);
    const eventId = raw.eventId;
    if (typeof eventId !== 'string' || !UUID.test(eventId)) throw new ScheduleError('shape', `onsales[${i}].eventId는 소문자 UUID여야 합니다`);
    if (seen.has(eventId)) throw new ScheduleError('shape', `eventId ${eventId}가 겹칩니다`);
    seen.add(eventId);
    const opensAt = raw.opensAt;
    if (typeof opensAt !== 'string') throw new ScheduleError('shape', `onsales[${i}].opensAt이 없습니다`);
    isoMs(opensAt, `onsales[${i}].opensAt`);
    const scale = raw.scale;
    if (typeof scale !== 'string' || !(SCALES as readonly string[]).includes(scale)) {
      throw new ScheduleError('shape', `onsales[${i}].scale은 ${SCALES.join('·')} 가운데 하나여야 합니다`);
    }
    if (raw.approved !== undefined && raw.approved !== true) throw new ScheduleError('shape', `onsales[${i}]는 승인된 회차만 담습니다`);
    return { eventId, opensAt, scale: scale as Scale, ...(raw.approved === true ? { approved: true as const } : {}) };
  });
  return { revision, generatedAt, onsales };
}

/** UTC 5칸 크론(분 시 일 월 *). ArgoCD와 Karpenter 모두 UTC만 받는다 */
export function cronOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCMinutes()} ${d.getUTCHours()} ${d.getUTCDate()} ${d.getUTCMonth() + 1} *`;
}

const minutesOf = (ms: number) => `${Math.round(ms / 60_000)}m`;

function windowOf(entry: OnsaleEntry): FreezeWindow {
  const cfg = WINDOW_MINUTES[entry.scale];
  const opensAtMs = Date.parse(entry.opensAt);
  const startsAtMs = opensAtMs - cfg.before * 60_000;
  const endsAtMs = opensAtMs + cfg.after * 60_000;
  const abortAtMs = opensAtMs - cfg.abortBefore * 60_000;
  const schedule = cronOf(startsAtMs);
  const duration = minutesOf(endsAtMs - startsAtMs);
  return {
    eventId: entry.eventId,
    scale: entry.scale,
    scope: cfg.scope,
    opensAt: new Date(opensAtMs).toISOString(),
    startsAt: new Date(startsAtMs).toISOString(),
    endsAt: new Date(endsAtMs).toISOString(),
    abortAt: new Date(abortAtMs).toISOString(),
    argocd: { kind: 'deny', schedule, duration, manualSync: true, applications: ['*'], namespaces: ['*'], clusters: ['*'] },
    karpenter: { schedule, duration, nodes: '0' },
  };
}

/**
 * 지금 기준으로 계산할 창. 이미 끝난 창은 빼고, 오픈 시각이 7일 뒤보다 먼 회차도 뺀다.
 * 창이 이미 시작했고 아직 끝나지 않았으면 남긴다(동결 중 다시 렌더해도 창이 사라지지 않는다).
 */
export function windowsOf(schedule: OnsaleSchedule, nowMs: number): FreezeWindow[] {
  if (!Number.isFinite(nowMs)) throw new Error('nowMs가 유한한 수가 아닙니다');
  const horizonEnd = nowMs + HORIZON_MS;
  return schedule.onsales
    .filter((e) => {
      const opens = Date.parse(e.opensAt);
      return opens <= horizonEnd && opens + WINDOW_MINUTES[e.scale].after * 60_000 > nowMs;
    })
    .map(windowOf)
    .sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : a.eventId < b.eventId ? -1 : 1));
}

/** 지금 창 안에 있는 창들(`startsAt ≤ now < endsAt`) */
export function activeWindowsAt(calendar: FreezeCalendar, nowMs: number): FreezeWindow[] {
  return calendar.windows.filter((w) => Date.parse(w.startsAt) <= nowMs && nowMs < Date.parse(w.endsAt));
}

/** 창 합집합을 [from, to)에 겹치는 만큼만 더한 시간(ms) */
function blockedMs(windows: readonly FreezeWindow[], from: number, to: number): number {
  const intervals = windows
    .map((w) => [Math.max(from, Date.parse(w.startsAt)), Math.min(to, Date.parse(w.endsAt))] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of intervals) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) curEnd = e;
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

function deployableHours(windows: readonly FreezeWindow[], nowMs: number, scopes: readonly Scope[]): number {
  const relevant = windows.filter((w) => scopes.includes(w.scope));
  const blocked = blockedMs(relevant, nowMs, nowMs + HORIZON_MS);
  return Math.round((HORIZON_HOURS - blocked / 3_600_000) * 1e6) / 1e6;
}

/** 달력 문서와 ArgoCD/Karpenter가 원하는 상태를 만든다. 쓰기는 runCalendarOnce가 한다 */
export function renderCalendar(schedule: OnsaleSchedule, nowMs: number): CalendarRender {
  const windows = windowsOf(schedule, nowMs);
  const calendar: FreezeCalendar = {
    schemaVersion: 1,
    revision: schedule.revision,
    renderedAt: new Date(nowMs).toISOString(),
    windows,
    deployableHoursNext7d: {
      all: deployableHours(windows, nowMs, ['all']),
      hotpath: deployableHours(windows, nowMs, ['all', 'hotpath']),
    },
  };
  return {
    calendar,
    argocd: { projects: ARGOCD_PROJECTS.map((project) => ({ project, windows: windows.map((w) => w.argocd) })) },
    karpenter: { allNodePools: true, budgets: windows.map((w) => w.karpenter) },
  };
}

/** 일정 원천(S3 또는 로컬 파일). 읽지 못하면 던진다 */
export interface ScheduleSource {
  read(): Promise<{ readonly text: string }>;
}

/** 봇이 산출물을 쓰는 곳. 운영은 GitHub PR 가지, 로컬·시험은 임시 폴더 */
export interface CalendarWriter {
  write(path: string, text: string): Promise<void>;
}

/** ArgoCD AppProject 창 적용 포트. 실제 어댑터는 구간 5(INF-020) */
export interface CalendarApplier {
  apply(render: CalendarRender): Promise<void>;
}

/** Karpenter NodePool 중단 예산 적용 포트. 실제 어댑터는 구간 5(INF-020) */
export interface NodePoolBudgetApplier {
  apply(budgets: CalendarRender['karpenter']): Promise<void>;
}

export interface CalendarDeps {
  readonly source: ScheduleSource;
  readonly writer: CalendarWriter;
  readonly applier?: CalendarApplier;
  readonly budgetApplier?: NodePoolBudgetApplier;
  readonly now: () => number;
  /** 시험·로컬에서 쓰는 루트(로그에만 쓴다) */
  readonly root?: string;
  readonly log?: (line: Record<string, unknown>) => void;
}

export type CalendarRun =
  | { readonly result: 'rendered'; readonly render: CalendarRender }
  | { readonly result: 'skipped'; readonly reason: 'source-unavailable' | 'source-stale' };

/**
 * 달력 한 번 실행(10분 주기 CronJob이 부른다, devops §8.2).
 * 일정 파일을 못 읽거나 30분 넘게 낡았으면 산출물을 바꾸지 않고 정상 종료한다(이미 걸린 창 유지).
 */
export async function runCalendarOnce(deps: CalendarDeps): Promise<CalendarRun> {
  const log = deps.log ?? (() => {});
  let text: string;
  try {
    ({ text } = await deps.source.read());
  } catch (err) {
    log({ kind: 'deploy', event: 'freeze_calendar_skipped', reason: 'source-unavailable', message: err instanceof Error ? err.message : String(err) });
    return { result: 'skipped', reason: 'source-unavailable' };
  }
  const schedule = parseSchedule(text);
  const nowMs = deps.now();
  const age = nowMs - Date.parse(schedule.generatedAt);
  if (age > SOURCE_STALE_MS) {
    log({ kind: 'deploy', event: 'freeze_calendar_skipped', reason: 'source-stale', ageMs: age, revision: schedule.revision });
    return { result: 'skipped', reason: 'source-stale' };
  }
  const render = renderCalendar(schedule, nowMs);
  await deps.writer.write(CALENDAR_FILE, `${JSON.stringify(render.calendar, null, 2)}\n`);
  await deps.writer.write(ARGOCD_WINDOWS_FILE, `${JSON.stringify(render.argocd, null, 2)}\n`);
  await deps.writer.write(KARPENTER_BUDGETS_FILE, `${JSON.stringify(render.karpenter, null, 2)}\n`);
  await deps.applier?.apply(render);
  await deps.budgetApplier?.apply(render.karpenter);
  log({
    kind: 'deploy',
    event: 'freeze_calendar_rendered',
    revision: schedule.revision,
    windows: render.calendar.windows.length,
    deployableHoursNext7d: render.calendar.deployableHoursNext7d,
  });
  return { result: 'rendered', render };
}

/** 파일 하나를 루트 아래에 쓰는 writer(로컬·시험). 운영은 Git PR writer가 된다 */
export function fsCalendarWriter(root: string): CalendarWriter {
  return {
    async write(path, text) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, text, 'utf8');
    },
  };
}
