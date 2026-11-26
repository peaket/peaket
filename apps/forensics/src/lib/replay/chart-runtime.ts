// F-04-18 차트 런타임. 정본: docs/features/forensic-replay.md §2.1~§2.2·§3.1·§3.3·§7.1,
// docs/security/asvs/forensic-replay.md(v5.0.0-1.4.3·3.5.5·3.7.1).
// 로그 눈금·2D 표본·Worker 메시지 계약·복사본 전송을 담는다. 화면과 Worker가 같은 함수를 쓴다.
import {
  COLUMN_SPECS,
  type EventColumns,
  type ForensicSource,
} from '../forensics/events.ts';
import type { DeviceGroupBurst } from './candidate.ts';

export const SAMPLE_CAP = 20_000;
export const SCATTER_X_MIN_MS = 10;
export const SCATTER_X_MAX_MS = 10_000;
export const SHARED_CLOCK_ENABLED = false;

export interface RenderPlan {
  mode: 'webgl2' | '2d-sample';
  count: number;
  stride: number;
}

export function renderPlan(total: number, webgl2: boolean): RenderPlan {
  const safe = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  if (webgl2) return { mode: 'webgl2', count: safe, stride: 1 };
  if (safe <= SAMPLE_CAP) return { mode: '2d-sample', count: safe, stride: 1 };
  return { mode: '2d-sample', count: SAMPLE_CAP, stride: safe / SAMPLE_CAP };
}

export function samplePoints<T>(points: readonly T[], plan: RenderPlan): readonly T[] {
  if (plan.mode === 'webgl2' || plan.stride === 1 || plan.count >= points.length) return points;
  if (plan.count <= 0) return [];
  const out: T[] = [];
  for (let i = 0; i < plan.count; i += 1) {
    out.push(points[Math.floor((i * points.length) / plan.count)]);
  }
  return out;
}

export function webgl2Available(canvas: { getContext(name: string): unknown } | null): boolean {
  if (canvas === null) return false;
  try {
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

export function map2dLabel(): string {
  return '이 기기는 표본으로 그립니다';
}

export function logPosition(
  value: number,
  min: number = SCATTER_X_MIN_MS,
  max: number = SCATTER_X_MAX_MS,
): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= min) {
    return Number.NaN;
  }
  if (value <= min) return 0;
  if (value >= max) return 1;
  return (Math.log10(value) - Math.log10(min)) / (Math.log10(max) - Math.log10(min));
}

export function linearPosition(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return Number.NaN;
  }
  if (value <= min) return 0;
  if (value >= max) return 1;
  return (value - min) / (max - min);
}

export function scatterPosition(x: number, y: number): { u: number; v: number } {
  return { u: logPosition(x), v: linearPosition(y) };
}

export function clockModeLabel(sharedClock: boolean): '공유 메모리 켜짐' | '복사 방식' {
  return sharedClock ? '공유 메모리 켜짐' : '복사 방식';
}

export interface CandidateRequest {
  kind: 'candidate';
  version: number;
  source: ForensicSource;
  columns: EventColumns;
  keep: Uint8Array;
}

export interface CandidateDone {
  kind: 'candidate-done';
  version: number;
  panel: 'scatter' | 'distribution' | 'baseline';
  /** x,y 쌍. 길이는 sessions.length × 2 */
  points: Float32Array;
  sessions: Uint32Array;
  bots: Uint8Array;
  totalSessions: number;
  totalBots: number;
  bursts: DeviceGroupBurst[];
  histogram: { bins: Uint32Array; edges: Float64Array } | null;
}

export interface WorkerError {
  kind: 'error';
  version: number;
  message: string;
}

export type WorkerMessage = CandidateRequest | CandidateDone | WorkerError;

const COLUMN_NAMES = COLUMN_SPECS.map((column) => column.name);
const SOURCES: readonly ForensicSource[] = ['SYNTHETIC', 'RESEARCH', 'INVESTIGATION'];
const PANELS: readonly CandidateDone['panel'][] = ['scatter', 'distribution', 'baseline'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTypedColumns(value: unknown, length: number): value is EventColumns {
  if (!isRecord(value)) return false;
  for (const column of COLUMN_SPECS) {
    const array = value[column.name];
    if (column.type === 'float32') {
      if (!(array instanceof Float32Array) || array.length !== length) return false;
    } else if (column.type === 'int32') {
      if (!(array instanceof Int32Array) || array.length !== length) return false;
    } else if (column.type === 'uint32') {
      if (!(array instanceof Uint32Array) || array.length !== length) return false;
    } else if (column.type === 'uint16') {
      if (!(array instanceof Uint16Array) || array.length !== length) return false;
    } else if (!(array instanceof Uint8Array) || array.length !== length) {
      return false;
    }
  }
  return true;
}

function isBurst(value: unknown): value is DeviceGroupBurst {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.deviceGroup) &&
    Number.isSafeInteger(value.sessions) &&
    Number.isSafeInteger(value.attempts) &&
    Number.isFinite(value.firstAtMs) &&
    Number.isFinite(value.lastAtMs)
  );
}

function decodeCandidate(data: Record<string, unknown>): CandidateRequest | null {
  if (!isVersion(data.version)) return null;
  if (typeof data.source !== 'string' || !SOURCES.includes(data.source as ForensicSource)) return null;
  if (!(data.keep instanceof Uint8Array)) return null;
  if (!isTypedColumns(data.columns, data.keep.length)) return null;
  return {
    kind: 'candidate',
    version: data.version,
    source: data.source as ForensicSource,
    columns: data.columns,
    keep: data.keep,
  };
}

function decodeDone(data: Record<string, unknown>): CandidateDone | null {
  if (!isVersion(data.version)) return null;
  if (typeof data.panel !== 'string' || !PANELS.includes(data.panel as CandidateDone['panel'])) return null;
  if (!(data.points instanceof Float32Array)) return null;
  if (!(data.sessions instanceof Uint32Array)) return null;
  if (!(data.bots instanceof Uint8Array)) return null;
  if (data.points.length !== data.sessions.length * 2) return null;
  if (data.bots.length !== data.sessions.length) return null;
  if (!Number.isSafeInteger(data.totalSessions) || (data.totalSessions as number) < 0) return null;
  if (!Number.isSafeInteger(data.totalBots) || (data.totalBots as number) < 0) return null;
  if (!Array.isArray(data.bursts) || !data.bursts.every(isBurst)) return null;
  if (data.histogram !== null) {
    if (!isRecord(data.histogram)) return null;
    const bins = data.histogram.bins;
    const edges = data.histogram.edges;
    if (!(bins instanceof Uint32Array) || !(edges instanceof Float64Array)) return null;
    if (edges.length !== bins.length + 1) return null;
  }
  return {
    kind: 'candidate-done',
    version: data.version,
    panel: data.panel as CandidateDone['panel'],
    points: data.points,
    sessions: data.sessions,
    bots: data.bots,
    totalSessions: data.totalSessions as number,
    totalBots: data.totalBots as number,
    bursts: data.bursts as DeviceGroupBurst[],
    histogram: data.histogram as CandidateDone['histogram'],
  };
}

export function decodeWorkerMessage(data: unknown): WorkerMessage | null {
  if (!isRecord(data)) return null;
  if (data.kind === 'candidate') return decodeCandidate(data);
  if (data.kind === 'candidate-done') return decodeDone(data);
  if (data.kind === 'error') {
    if (!isVersion(data.version)) return null;
    if (typeof data.message !== 'string' || data.message.length > 200) return null;
    return { kind: 'error', version: data.version, message: data.message };
  }
  return null;
}

export function candidateRequest(
  version: number,
  source: ForensicSource,
  columns: EventColumns,
  keep: Uint8Array,
): { message: CandidateRequest; transfer: ArrayBuffer[] } {
  const copy: EventColumns = {
    t_ms: columns.t_ms.slice(),
    kind: columns.kind.slice(),
    seat: columns.seat.slice(),
    section: columns.section.slice(),
    session: columns.session.slice(),
    result: columns.result.slice(),
    retry: columns.retry.slice(),
    latency_ms: columns.latency_ms.slice(),
    first_hold_ms: columns.first_hold_ms.slice(),
    entropy: columns.entropy.slice(),
    net_type: columns.net_type.slice(),
    asn: columns.asn.slice(),
    device_group: columns.device_group.slice(),
    bot_tier: columns.bot_tier.slice(),
    member: columns.member.slice(),
    post_seat: columns.post_seat.slice(),
  };
  const keepCopy = keep.slice();
  const transfer: ArrayBuffer[] = [
    copy.t_ms.buffer as ArrayBuffer,
    copy.kind.buffer as ArrayBuffer,
    copy.seat.buffer as ArrayBuffer,
    copy.section.buffer as ArrayBuffer,
    copy.session.buffer as ArrayBuffer,
    copy.result.buffer as ArrayBuffer,
    copy.retry.buffer as ArrayBuffer,
    copy.latency_ms.buffer as ArrayBuffer,
    copy.first_hold_ms.buffer as ArrayBuffer,
    copy.entropy.buffer as ArrayBuffer,
    copy.net_type.buffer as ArrayBuffer,
    copy.asn.buffer as ArrayBuffer,
    copy.device_group.buffer as ArrayBuffer,
    copy.bot_tier.buffer as ArrayBuffer,
    copy.member.buffer as ArrayBuffer,
    copy.post_seat.buffer as ArrayBuffer,
    keepCopy.buffer as ArrayBuffer,
  ];
  return {
    message: { kind: 'candidate', version, source, columns: copy, keep: keepCopy },
    transfer,
  };
}

export function candidateDoneBuffers(message: CandidateDone): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [
    message.points.buffer as ArrayBuffer,
    message.sessions.buffer as ArrayBuffer,
    message.bots.buffer as ArrayBuffer,
  ];
  if (message.histogram !== null) {
    buffers.push(message.histogram.bins.buffer as ArrayBuffer, message.histogram.edges.buffer as ArrayBuffer);
  }
  return buffers;
}

// COLUMN_NAMES는 열 이름을 다른 모듈이 재사용할 때 쓰는 읽기 전용 목록이다.
export const CANDIDATE_COLUMN_NAMES: readonly string[] = COLUMN_NAMES;
