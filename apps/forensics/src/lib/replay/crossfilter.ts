// F-04-17 교차 필터 비트마스크와 초당 막대. 정본: docs/features/forensic-replay.md §2.1·§3.5·§8 FX-T4·FX-T8.
// 차원마다 Uint32Array 비트마스크를 만들고, 요약 값은 마스크가 켠 행만 센다. 버린 사건(keep=0)은 어디에도 넣지 않는다.
import {
  EVENT_KIND,
  RESULT,
  type EventColumns,
} from '../forensics/events.ts';
import type { ReplayBounds } from './session.ts';

export interface ReplayFilter {
  /** 시작 이상 */
  fromMs?: number;
  /** 끝 미만 */
  toMs?: number;
  sections?: readonly number[];
  results?: readonly number[];
  kinds?: readonly number[];
  botTiers?: readonly number[];
  netTypes?: readonly number[];
  deviceGroups?: readonly number[];
  /** 1이면 묶음 계정만, 0이면 묶음 밖만, 없으면 모두 */
  member?: 0 | 1;
}

export interface ReplaySummary {
  rows: number;
  sessions: number;
  holdTries: number;
  conflictRate: number;
  holdToSaleRate: number;
  candidateRate: number;
  memberSessions: number;
}

export interface TimelineBucket {
  atMs: number;
  queueEnter: number;
  holdTry: number;
  conflict: number;
  sale: number;
}

export function maskWords(rowCount: number): number {
  return Math.ceil(rowCount / 32);
}

function passes(columns: EventColumns, i: number, filter: ReplayFilter): boolean {
  const t = columns.t_ms[i];
  if (filter.fromMs !== undefined && t < filter.fromMs) return false;
  if (filter.toMs !== undefined && t >= filter.toMs) return false;
  if (filter.sections !== undefined && !filter.sections.includes(columns.section[i])) return false;
  if (filter.results !== undefined && !filter.results.includes(columns.result[i])) return false;
  if (filter.kinds !== undefined && !filter.kinds.includes(columns.kind[i])) return false;
  if (filter.botTiers !== undefined && !filter.botTiers.includes(columns.bot_tier[i])) return false;
  if (filter.netTypes !== undefined && !filter.netTypes.includes(columns.net_type[i])) return false;
  if (filter.deviceGroups !== undefined && !filter.deviceGroups.includes(columns.device_group[i])) return false;
  if (filter.member !== undefined && columns.member[i] !== filter.member) return false;
  return true;
}

export function selectionMask(columns: EventColumns, keep: Uint8Array, filter: ReplayFilter = {}): Uint32Array {
  const rowCount = columns.t_ms.length;
  const mask = new Uint32Array(maskWords(rowCount));
  for (let i = 0; i < rowCount; i += 1) {
    if (keep[i] !== 1) continue;
    if (!passes(columns, i, filter)) continue;
    mask[i >>> 5] |= 1 << (i & 31);
  }
  return mask;
}

function has(mask: Uint32Array, i: number): boolean {
  return (mask[i >>> 5] & (1 << (i & 31))) !== 0;
}

export function summarize(columns: EventColumns, keep: Uint8Array, filter: ReplayFilter = {}): ReplaySummary {
  const mask = selectionMask(columns, keep, filter);
  const sessions = new Set<number>();
  const bots = new Set<number>();
  const members = new Set<number>();
  let rows = 0;
  let holdTries = 0;
  let conflicts = 0;
  let held = 0;
  let sales = 0;

  for (let i = 0; i < columns.t_ms.length; i += 1) {
    if (!has(mask, i)) continue;
    rows += 1;
    const session = columns.session[i];
    sessions.add(session);
    if (columns.bot_tier[i] > 0) bots.add(session);
    if (columns.member[i] === 1) members.add(session);
    const kind = columns.kind[i];
    if (kind === EVENT_KIND.HOLD_TRY) {
      holdTries += 1;
      if (columns.result[i] === RESULT.CONFLICT) conflicts += 1;
      if (columns.result[i] === RESULT.HELD) held += 1;
    } else if (kind === EVENT_KIND.SALE) {
      sales += 1;
    }
  }

  return {
    rows,
    sessions: sessions.size,
    holdTries,
    conflictRate: holdTries === 0 ? 0 : conflicts / holdTries,
    holdToSaleRate: held === 0 ? 0 : sales / held,
    candidateRate: sessions.size === 0 ? 0 : bots.size / sessions.size,
    memberSessions: members.size,
  };
}

export function timelineSeries(
  columns: EventColumns,
  keep: Uint8Array,
  bounds: ReplayBounds,
  filter: ReplayFilter = {},
): TimelineBucket[] {
  const count = Math.ceil((bounds.toMs - bounds.fromMs) / 1000);
  const buckets: TimelineBucket[] = [];
  for (let i = 0; i < count; i += 1) {
    buckets.push({ atMs: bounds.fromMs + i * 1000, queueEnter: 0, holdTry: 0, conflict: 0, sale: 0 });
  }
  for (let i = 0; i < columns.t_ms.length; i += 1) {
    if (keep[i] !== 1) continue;
    const t = columns.t_ms[i];
    if (t < bounds.fromMs || t >= bounds.toMs) continue;
    if (!passes(columns, i, filter)) continue;
    const bucket = buckets[Math.floor((t - bounds.fromMs) / 1000)];
    if (columns.kind[i] === EVENT_KIND.QUEUE_ENTER) bucket.queueEnter += 1;
    if (columns.kind[i] === EVENT_KIND.HOLD_TRY) {
      bucket.holdTry += 1;
      if (columns.result[i] === RESULT.CONFLICT) bucket.conflict += 1;
    }
    if (columns.kind[i] === EVENT_KIND.SALE) bucket.sale += 1;
  }
  return buckets;
}
