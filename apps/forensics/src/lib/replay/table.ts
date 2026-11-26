// F-04-17 표 보기와 조사 원천 기준선. 정본: docs/features/forensic-replay.md §2.1·§2.3·§8 FX-T8.
// 그림과 표가 같은 집계를 쓰도록, 표 값은 이 파일에서만 만든다. 비율은 소수 넷째 자리까지 자른다.
import {
  EVENT_KIND,
  SEAT_STATE,
  type EventColumns,
} from '../forensics/events.ts';
import type { ReplaySummary, TimelineBucket } from './crossfilter.ts';
import { formatOffset } from './playback.ts';

export type StageName =
  | 'saleToQueue'
  | 'queueToAdmit'
  | 'admitToHold'
  | 'holdToPay'
  | 'payToSale';

const STAGE_ORDER: readonly StageName[] = ['saleToQueue', 'queueToAdmit', 'admitToHold', 'holdToPay', 'payToSale'];

const STAGE_LABEL: Record<StageName, string> = {
  saleToQueue: '판매 시작 → 대기열 진입',
  queueToAdmit: '대기열 진입 → 입장 확정',
  admitToHold: '입장 확정 → 첫 홀드',
  holdToPay: '첫 홀드 → 결제 시도',
  payToSale: '결제 시도 → 판매',
};

export interface JourneyTimes {
  session: number;
  queueEnterMs: number | null;
  admitMs: number | null;
  firstHoldMs: number | null;
  payTryMs: number | null;
  saleMs: number | null;
}

export interface StageBand {
  stage: StageName;
  p1: number;
  p50: number;
  p99: number;
  n: number;
}

export interface TableRow {
  label: string;
  value: number | string;
}

export interface TimelineTableRow {
  second: string;
  queueEnter: number;
  holdTry: number;
  conflict: number;
  sale: number;
}

export interface BaselineRow {
  stage: string;
  p1: number;
  p50: number;
  p99: number;
  n: number;
}

export interface SeatLegendItem {
  state: number;
  label: string;
  pattern: 'solid' | 'diagonal-hatch' | 'solid-with-check' | 'cross-hatch';
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

export function summaryRows(summary: ReplaySummary, source: 'INVESTIGATION' | 'RESEARCH' | 'SYNTHETIC'): TableRow[] {
  const rows: TableRow[] = [
    { label: '홀드 시도', value: summary.holdTries },
    { label: '경합 패배율', value: round4(summary.conflictRate) },
    { label: '홀드 → 판매 전환', value: round4(summary.holdToSaleRate) },
  ];
  if (source === 'INVESTIGATION') rows.push({ label: '묶음 계정 수', value: summary.memberSessions });
  else rows.push({ label: '후보 비율', value: round4(summary.candidateRate) });
  return rows;
}

export function timelineRows(buckets: readonly TimelineBucket[]): TimelineTableRow[] {
  return buckets.map((bucket) => ({
    second: formatOffset(bucket.atMs),
    queueEnter: bucket.queueEnter,
    holdTry: bucket.holdTry,
    conflict: bucket.conflict,
    sale: bucket.sale,
  }));
}

function emptyJourney(session: number): JourneyTimes {
  return { session, queueEnterMs: null, admitMs: null, firstHoldMs: null, payTryMs: null, saleMs: null };
}

function firstOf(current: number | null, value: number): number {
  return current === null || value < current ? value : current;
}

/** 세션마다 종류별 첫 사건 시각. keep=0 행은 보지 않는다. 세션 순서는 처음 나온 행 순서다. */
export function journeys(columns: EventColumns, keep: Uint8Array): JourneyTimes[] {
  const map = new Map<number, JourneyTimes>();
  for (let i = 0; i < columns.t_ms.length; i += 1) {
    if (keep[i] !== 1) continue;
    const session = columns.session[i];
    const j = map.get(session) ?? emptyJourney(session);
    const t = columns.t_ms[i];
    const kind = columns.kind[i];
    if (kind === EVENT_KIND.QUEUE_ENTER) j.queueEnterMs = firstOf(j.queueEnterMs, t);
    else if (kind === EVENT_KIND.ADMIT) j.admitMs = firstOf(j.admitMs, t);
    else if (kind === EVENT_KIND.HOLD_TRY) j.firstHoldMs = firstOf(j.firstHoldMs, t);
    else if (kind === EVENT_KIND.PAY_TRY) j.payTryMs = firstOf(j.payTryMs, t);
    else if (kind === EVENT_KIND.SALE) j.saleMs = firstOf(j.saleMs, t);
    map.set(session, j);
  }
  return [...map.values()];
}

function span(from: number | null, to: number | null): number | undefined {
  if (from === null || to === null) return undefined;
  const value = to - from;
  return value < 0 ? undefined : value;
}

/** 단계별 걸린 시간. 두 시각이 모두 있고 음수가 아닐 때만 넣는다. 판매 시작은 0이다. */
export function stageDurations(j: JourneyTimes): Partial<Record<StageName, number>> {
  const out: Partial<Record<StageName, number>> = {};
  if (j.queueEnterMs !== null) out.saleToQueue = j.queueEnterMs;
  const queueToAdmit = span(j.queueEnterMs, j.admitMs);
  if (queueToAdmit !== undefined) out.queueToAdmit = queueToAdmit;
  const admitToHold = span(j.admitMs, j.firstHoldMs);
  if (admitToHold !== undefined) out.admitToHold = admitToHold;
  const holdToPay = span(j.firstHoldMs, j.payTryMs);
  if (holdToPay !== undefined) out.holdToPay = holdToPay;
  const payToSale = span(j.payTryMs, j.saleMs);
  if (payToSale !== undefined) out.payToSale = payToSale;
  return out;
}

/** 가장 가까운 순위: ceil(p/100 × n), 1부터. 빈 배열은 NaN. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

/** member가 같은 여정만 모아 단계마다 1·50·99 백분위를 낸다. 값이 없는 단계는 넣지 않는다. */
export function stageBands(columns: EventColumns, keep: Uint8Array, member: 0 | 1): StageBand[] {
  const sessions = new Set<number>();
  for (let i = 0; i < columns.t_ms.length; i += 1) {
    if (keep[i] !== 1) continue;
    if (columns.member[i] !== member) continue;
    sessions.add(columns.session[i]);
  }
  const selected = journeys(columns, keep).filter((j) => sessions.has(j.session));
  const out: StageBand[] = [];
  for (const stage of STAGE_ORDER) {
    const values: number[] = [];
    for (const j of selected) {
      const value = stageDurations(j)[stage];
      if (value !== undefined) values.push(value);
    }
    if (values.length === 0) continue;
    out.push({
      stage,
      p1: percentile(values, 1),
      p50: percentile(values, 50),
      p99: percentile(values, 99),
      n: values.length,
    });
  }
  return out;
}

export function baselineRows(bands: readonly StageBand[]): BaselineRow[] {
  return bands.map((band) => ({
    stage: STAGE_LABEL[band.stage],
    p1: band.p1,
    p50: band.p50,
    p99: band.p99,
    n: band.n,
  }));
}

/** 좌석 상태 네 가지의 이름과 무늬. 색과 무늬를 함께 쓰기 위한 값이다(d2 CMP-021·CMP-023). */
export function seatLegend(): readonly SeatLegendItem[] {
  return [
    { state: SEAT_STATE.EMPTY, label: '빈 좌석', pattern: 'solid' },
    { state: SEAT_STATE.HELD, label: '홀드', pattern: 'diagonal-hatch' },
    { state: SEAT_STATE.PAYING, label: '결제 중', pattern: 'solid-with-check' },
    { state: SEAT_STATE.SOLD, label: '판매', pattern: 'cross-hatch' },
  ];
}
