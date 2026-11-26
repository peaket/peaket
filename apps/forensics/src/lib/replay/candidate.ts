// F-04-18 후보 모델. 정본: docs/features/forensic-replay.md §2.1·§4.1·§8 FX-T9, d5 §7.17.
// 사건 열에서 세션 점·기기 묶음·연구 분포·영역 집계를 만든다. 화면·Worker를 직접 만지지 않는 순수 모듈이다.
import {
  EVENT_KIND,
  NO_SEAT,
  type EventColumns,
  type ForensicSource,
} from '../forensics/events.ts';

export type CandidatePanelKind = 'scatter' | 'distribution' | 'baseline';

export interface SessionPoint {
  session: number;
  /** > 0. 가장 이른 first_hold_ms */
  firstHoldMs: number;
  /** 합성은 유한값, 연구·조사 묶음 밖은 null */
  entropy: number | null;
  botTier: number;
  deviceGroup: number;
  member: boolean;
}

export interface CandidatePoint {
  session: number;
  x: number;
  y: number;
  bot: boolean;
}

export interface PointBounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface SelectionStats {
  sessions: number;
  bots: number;
  precision: number;
  recall: number;
}

export interface DeviceGroupBurst {
  deviceGroup: number;
  sessions: number;
  attempts: number;
  firstAtMs: number;
  lastAtMs: number;
}

export interface Histogram {
  bins: readonly number[];
  /** 길이 bins.length + 1. 기본은 10^(1+i/8)ms */
  edges: readonly number[];
  minMs: number;
  maxMs: number;
}

export interface CandidateModel {
  kind: CandidatePanelKind;
  points: readonly CandidatePoint[];
  bursts: readonly DeviceGroupBurst[];
  totalSessions: number;
  totalBots: number;
  histogram: Histogram | null;
}

export interface CandidateSectionFlags {
  precision: boolean;
  deviceGroups: boolean;
  histogram: boolean;
  baseline: boolean;
}

export interface CandidateTableRow {
  label: string;
  value: number | string;
}

export interface HistogramRow {
  fromMs: number;
  toMs: number;
  sessions: number;
}

const DEFAULT_MIN_MS = 10;
const DEFAULT_MAX_MS = 10_000;
const DEFAULT_BINS = 24;

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
/** Float32Array에 담긴 엔트로피를 화면·표에서 읽는 6자리 값으로 정리한다. */
const roundEntropy = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

export function candidatePanelKind(source: ForensicSource): CandidatePanelKind {
  if (source === 'RESEARCH') return 'distribution';
  if (source === 'INVESTIGATION') return 'baseline';
  return 'scatter';
}

export function candidateNotice(source: ForensicSource): string {
  if (source === 'INVESTIGATION') {
    return '후보 찾기용입니다. 조치는 사건 작업대에서 소명과 승인을 거쳐 합니다(POL-046).';
  }
  return '후보 찾기용입니다. 봇 판정은 표본 검토(SCR-067)와 정해진 규칙(POL-006)으로 합니다.';
}

export function precisionNotice(): string {
  return '합성 데이터의 정답으로 잰 값입니다. 봇을 이 특징으로 만들었기 때문에 높게 나오며, 실제 봇 탐지 성능을 뜻하지 않습니다.';
}

export function mimicPrecisionLimit(botRatio: number): number {
  return botRatio + 0.1;
}

export function panelSections(source: ForensicSource): CandidateSectionFlags {
  if (source === 'RESEARCH') {
    return { precision: false, deviceGroups: false, histogram: true, baseline: false };
  }
  if (source === 'INVESTIGATION') {
    return { precision: false, deviceGroups: true, histogram: false, baseline: true };
  }
  return { precision: true, deviceGroups: true, histogram: false, baseline: false };
}

/**
 * 세션마다 하나의 점을 만든다. first_hold_ms는 가장 이른 값, entropy는 첫 유한값,
 * botTier는 가장 큰 값, deviceGroup은 첫 0 아닌 값, member는 하나라도 1이면 참이다.
 */
export function sessionPoints(columns: EventColumns, keep: Uint8Array): SessionPoint[] {
  const bySession = new Map<number, SessionPoint>();
  for (let i = 0; i < columns.t_ms.length; i += 1) {
    if (keep[i] !== 1) continue;
    const session = columns.session[i];
    const firstHold = columns.first_hold_ms[i];
    const entropy = columns.entropy[i];
    const botTier = columns.bot_tier[i];
    const deviceGroup = columns.device_group[i];
    const member = columns.member[i] === 1;
    const current = bySession.get(session);
    if (current === undefined) {
      bySession.set(session, {
        session,
        firstHoldMs: firstHold > 0 ? firstHold : 0,
        entropy: Number.isFinite(entropy) ? roundEntropy(entropy) : null,
        botTier,
        deviceGroup,
        member,
      });
      continue;
    }
    if (firstHold > 0 && (current.firstHoldMs === 0 || firstHold < current.firstHoldMs)) {
      current.firstHoldMs = firstHold;
    }
    if (current.entropy === null && Number.isFinite(entropy)) current.entropy = roundEntropy(entropy);
    if (botTier > current.botTier) current.botTier = botTier;
    if (current.deviceGroup === 0 && deviceGroup !== 0) current.deviceGroup = deviceGroup;
    if (member) current.member = true;
  }
  return [...bySession.values()]
    .filter((point) => point.firstHoldMs > 0)
    .sort((a, b) => a.session - b.session);
}

export function candidatePoints(points: readonly SessionPoint[]): CandidatePoint[] {
  const out: CandidatePoint[] = [];
  for (const point of points) {
    if (point.entropy === null) continue;
    out.push({
      session: point.session,
      x: point.firstHoldMs,
      y: point.entropy,
      bot: point.botTier > 0,
    });
  }
  return out;
}

export function selectPoints(points: readonly CandidatePoint[], bounds: PointBounds): CandidatePoint[] {
  if (bounds.x1 <= bounds.x0 || bounds.y1 <= bounds.y0) return [];
  return points.filter(
    (point) =>
      point.x >= bounds.x0 && point.x < bounds.x1 && point.y >= bounds.y0 && point.y < bounds.y1,
  );
}

export function selectionStats(
  points: readonly CandidatePoint[],
  bounds: PointBounds,
  totalBots: number,
): SelectionStats {
  const selected = selectPoints(points, bounds);
  let bots = 0;
  for (const point of selected) if (point.bot) bots += 1;
  const sessions = selected.length;
  return {
    sessions,
    bots,
    precision: sessions === 0 ? 0 : bots / sessions,
    recall: totalBots <= 0 ? 0 : bots / totalBots,
  };
}

export function distributionHistogram(
  points: readonly SessionPoint[],
  minMs: number = DEFAULT_MIN_MS,
  maxMs: number = DEFAULT_MAX_MS,
  bins: number = DEFAULT_BINS,
): Histogram {
  const count = Math.max(1, Math.floor(bins));
  const low = minMs > 0 ? minMs : DEFAULT_MIN_MS;
  const high = maxMs > low ? maxMs : DEFAULT_MAX_MS;
  const binsOut = new Array<number>(count).fill(0);
  const edges: number[] = [];
  const ratio = high / low;
  for (let i = 0; i <= count; i += 1) edges.push(low * ratio ** (i / count));
  const logLow = Math.log10(low);
  const logSpan = Math.log10(high) - logLow;
  for (const point of points) {
    const value = point.firstHoldMs;
    if (!Number.isFinite(value) || value <= 0) continue;
    if (value < low) {
      binsOut[0] += 1;
      continue;
    }
    if (value >= high) {
      binsOut[count - 1] += 1;
      continue;
    }
    const index = Math.floor(((Math.log10(value) - logLow) / logSpan) * count);
    const safe = Math.max(0, Math.min(count - 1, index));
    binsOut[safe] += 1;
  }
  return { bins: binsOut, edges, minMs: low, maxMs: high };
}

interface BurstRow {
  index: number;
  session: number;
  seat: number;
  t: number;
}

export function deviceBursts(
  columns: EventColumns,
  keep: Uint8Array,
  windowMs: number = 10,
): DeviceGroupBurst[] {
  const groups = new Map<number, BurstRow[]>();
  for (let i = 0; i < columns.t_ms.length; i += 1) {
    if (keep[i] !== 1) continue;
    if (columns.kind[i] !== EVENT_KIND.HOLD_TRY) continue;
    const group = columns.device_group[i];
    if (group === 0) continue;
    const seat = columns.seat[i];
    if (seat === NO_SEAT) continue;
    const rows = groups.get(group) ?? [];
    rows.push({ index: i, session: columns.session[i], seat, t: columns.t_ms[i] });
    groups.set(group, rows);
  }

  const out: DeviceGroupBurst[] = [];
  for (const [deviceGroup, rows] of groups) {
    rows.sort((a, b) => a.t - b.t || a.index - b.index);
    const marked = new Set<number>();
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        if (rows[j].t - rows[i].t > windowMs) break;
        if (rows[j].seat === rows[i].seat) continue;
        marked.add(i);
        marked.add(j);
      }
    }
    if (marked.size === 0) continue;
    const selected = [...marked].map((index) => rows[index]);
    const sessions = new Set<number>();
    let firstAtMs = Number.POSITIVE_INFINITY;
    let lastAtMs = Number.NEGATIVE_INFINITY;
    for (const row of selected) {
      sessions.add(row.session);
      if (row.t < firstAtMs) firstAtMs = row.t;
      if (row.t > lastAtMs) lastAtMs = row.t;
    }
    out.push({ deviceGroup, sessions: sessions.size, attempts: selected.length, firstAtMs, lastAtMs });
  }
  out.sort((a, b) => a.deviceGroup - b.deviceGroup);
  return out;
}

export function seatsOfSessions(
  columns: EventColumns,
  keep: Uint8Array,
  sessions: ReadonlySet<number>,
): number[] {
  const seats = new Set<number>();
  for (let i = 0; i < columns.t_ms.length; i += 1) {
    if (keep[i] !== 1) continue;
    if (!sessions.has(columns.session[i])) continue;
    const kind = columns.kind[i];
    if (kind !== EVENT_KIND.HOLD_TRY && kind !== EVENT_KIND.SALE) continue;
    const seat = columns.seat[i];
    if (seat === NO_SEAT) continue;
    seats.add(seat);
  }
  return [...seats].sort((a, b) => a - b);
}

export function maskToKeep(mask: Uint32Array, rowCount: number): Uint8Array {
  const keep = new Uint8Array(rowCount);
  for (let i = 0; i < rowCount; i += 1) {
    const word = mask[i >>> 5] ?? 0;
    if ((word & (1 << (i & 31))) !== 0) keep[i] = 1;
  }
  return keep;
}

export function histogramRows(histogram: Histogram): HistogramRow[] {
  const rows: HistogramRow[] = [];
  for (let i = 0; i < histogram.bins.length; i += 1) {
    rows.push({
      fromMs: histogram.edges[i],
      toMs: histogram.edges[i + 1],
      sessions: histogram.bins[i],
    });
  }
  return rows;
}

export function candidateTableRows(model: CandidateModel, stats?: SelectionStats): CandidateTableRow[] {
  const rows: CandidateTableRow[] = [{ label: '세션', value: model.totalSessions }];
  if (model.kind === 'scatter') {
    rows.push({ label: '봇 세션', value: model.totalBots });
    rows.push({ label: '기기 묶음', value: model.bursts.length });
    if (stats !== undefined) {
      rows.push({ label: '고른 세션', value: stats.sessions });
      rows.push({ label: '정밀도', value: round4(stats.precision) });
      rows.push({ label: '재현율', value: round4(stats.recall) });
    }
  } else if (model.kind === 'distribution') {
    rows.push({ label: '분포 칸', value: model.histogram?.bins.length ?? 0 });
  } else {
    rows.push({ label: '기기 묶음', value: model.bursts.length });
  }
  return rows;
}

export function candidateModel(
  columns: EventColumns,
  keep: Uint8Array,
  source: ForensicSource,
): CandidateModel {
  const sessions = sessionPoints(columns, keep);
  const kind = candidatePanelKind(source);
  if (kind === 'scatter') {
    const points = candidatePoints(sessions);
    let totalBots = 0;
    for (const point of points) if (point.bot) totalBots += 1;
    return {
      kind,
      points,
      bursts: deviceBursts(columns, keep),
      totalSessions: sessions.length,
      totalBots,
      histogram: null,
    };
  }
  if (kind === 'distribution') {
    let totalBots = 0;
    for (const session of sessions) if (session.botTier > 0) totalBots += 1;
    return {
      kind,
      points: [],
      bursts: [],
      totalSessions: sessions.length,
      totalBots,
      histogram: distributionHistogram(sessions),
    };
  }
  let totalBots = 0;
  for (const session of sessions) if (session.botTier > 0) totalBots += 1;
  return {
    kind,
    points: [],
    bursts: deviceBursts(columns, keep),
    totalSessions: sessions.length,
    totalBots,
    histogram: null,
  };
}
