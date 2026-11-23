// 마감 단계 예정 시각과 할 일 고르기(docs/features/analytics.md §4.1 '실행', §4.2 '마감 단계', §4.3 '판매 기간이 긴 회차', OPS-240, F-04-6).
// 영업일은 payment·settlement와 같은 달력(KST 주말·공휴일 파일 PEAKET_HOLIDAY_CALENDAR_FILE)이다(analytics §5.3 dim_date).

export const STAGES = ['R0', 'R1', 'R2', 'R3'] as const;
export type Stage = (typeof STAGES)[number];
export const stageIndex = (s: Stage): number => STAGES.indexOf(s);

const DAY_MS = 24 * 60 * 60 * 1_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** 온세일 윈도우(T+60분, POL-030 표준 판매 시간대) */
export const ONSALE_WINDOW_MS = 60 * 60 * 1_000;
/** R0 = 온세일 윈도우 끝 + 30분 [가정] */
export const R0_DELAY_MS = 30 * 60 * 1_000;
/** R2 = 오픈 + 7일 */
export const R2_DELAY_MS = 7 * DAY_MS;

/** 그 시각의 KST 날짜(YYYY-MM-DD) */
export const kstDateKey = (at: Date): string => new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);

export function isKstBusinessDay(dateKey: string, holidays: ReadonlySet<string>): boolean {
  const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(dateKey);
}

/** 그 시각의 KST 날짜 다음 영업일 10:00 KST(R1·R3 '다음 영업일 10시') */
export function nextBusinessDay10Kst(at: Date, holidays: ReadonlySet<string>): Date {
  let day = Date.parse(`${kstDateKey(at)}T00:00:00Z`);
  for (let guard = 0; guard < 400; guard += 1) {
    day += DAY_MS;
    const key = new Date(day).toISOString().slice(0, 10);
    if (isKstBusinessDay(key, holidays)) return new Date(`${key}T01:00:00Z`);
  }
  throw new RangeError('영업일을 찾을 수 없다(공휴일 파일을 확인한다)');
}

/** 공휴일 파일 본문(`["2026-01-01", …]` 또는 `{ "holidays": [...] }`). 틀리면 던진다 */
export function parseHolidayCalendar(text: string): ReadonlySet<string> {
  const raw: unknown = JSON.parse(text);
  const list = Array.isArray(raw) ? raw : typeof raw === 'object' && raw !== null && Array.isArray((raw as { holidays?: unknown }).holidays) ? (raw as { holidays: unknown[] }).holidays : undefined;
  if (!list) throw new Error('공휴일 달력은 날짜 배열이거나 { holidays: [...] }여야 한다');
  const out = new Set<string>();
  for (const v of list) {
    if (typeof v !== 'string' || !DATE_KEY.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw new Error(`공휴일 날짜가 YYYY-MM-DD가 아니다: ${String(v)}`);
    out.add(v);
  }
  return out;
}

export interface EventRef {
  eventId: string;
  openAt: Date;
  /** 공연 시작 시각. 회차 종료 시각 칸이 기준 자료에 없어 공연 날로 R3를 잡는다 */
  startsAt: Date;
}

/** 회차의 단계별 예정 시각(analytics §4.2) */
export function stageTimes(ref: EventRef, holidays: ReadonlySet<string>): Record<Stage, Date> {
  return {
    R0: new Date(ref.openAt.getTime() + ONSALE_WINDOW_MS + R0_DELAY_MS),
    R1: nextBusinessDay10Kst(ref.openAt, holidays),
    R2: new Date(ref.openAt.getTime() + R2_DELAY_MS),
    R3: nextBusinessDay10Kst(ref.startsAt, holidays),
  };
}

export interface EventState {
  /** 현재 판의 마감 단계(없으면 아직 마감 전) */
  completed: Stage | null;
  /** 매일 쌓기를 마친 마지막 KST 날짜 */
  lastDaily: string | null;
}

export interface Task {
  eventId: string;
  stage: Stage;
  /** STAGE 새 단계 마감, DAILY 판매 기간이 긴 회차의 매일 다시 만들기(F15·F8 쌓기) */
  kind: 'STAGE' | 'DAILY';
  due: Date;
}

/**
 * 할 일 고르기. 예정 시각이 지난 가장 높은 단계가 완료 단계보다 높으면 그 단계를 마감한다(공연이 오픈 뒤 7일 안이면 R3가 R2보다 먼저 올 수 있다, §4.2).
 * R2를 마쳤고 R3 전이면 하루 한 번(KST 날짜) 같은 단계로 다시 만든다. 오래된 예정부터 차례로 한 회차씩 처리한다(§4.1 '동시 실행')
 */
export function planTasks(refs: readonly EventRef[], states: ReadonlyMap<string, EventState>, now: Date, holidays: ReadonlySet<string>): Task[] {
  const tasks: Task[] = [];
  const today = kstDateKey(now);
  for (const ref of refs) {
    const times = stageTimes(ref, holidays);
    const state = states.get(ref.eventId) ?? { completed: null, lastDaily: null };
    const due = [...STAGES].reverse().find((s) => times[s].getTime() <= now.getTime());
    const done = state.completed === null ? -1 : stageIndex(state.completed);
    if (due !== undefined && stageIndex(due) > done) {
      tasks.push({ eventId: ref.eventId, stage: due, kind: 'STAGE', due: times[due] });
      continue;
    }
    if (state.completed === 'R2' && now.getTime() < times.R3.getTime() && state.lastDaily !== today) {
      tasks.push({ eventId: ref.eventId, stage: 'R2', kind: 'DAILY', due: new Date(Date.parse(`${today}T00:00:00Z`) - KST_OFFSET_MS) });
    }
  }
  return tasks.sort((a, b) => a.due.getTime() - b.due.getTime() || a.eventId.localeCompare(b.eventId));
}
