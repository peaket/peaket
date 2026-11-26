// F-04-17 재생 세션. 정본: docs/features/forensic-replay.md §3.4·§4.2·§8 FX-T21·FX-T8.
// 검증을 통과한 사건 열을 버린 사건만큼 압축하고, 체크포인트와 시간창을 붙여 화면이 바로 쓸 세션을 만든다.
import {
  LOBBY_MS,
  MAX_WINDOW_MS,
  compactColumns,
  type Accepted,
  type DropCount,
  type EventColumns,
  type ForensicMeta,
  type SchemaColumn,
} from '../forensics/events.ts';
import { buildCheckpoints, type Checkpoints } from '../forensics/checkpoint.ts';
import type { OpenTarget } from '../operating.ts';
import type { ReplayEnvelope, ReplayFileInput } from '../replay-export.ts';

export interface ReplayBounds {
  fromMs: number;
  toMs: number;
}

export interface ReplaySession {
  target: OpenTarget;
  envelope: ReplayEnvelope;
  meta: ForensicMeta;
  schema: readonly SchemaColumn[];
  columns: EventColumns;
  rowCount: number;
  kept: number;
  dropped: number;
  droppedBy: DropCount[];
  checkpoints: Checkpoints;
  bounds: ReplayBounds;
}

/** 검증이 통과한 파일에서 시간창을 정한다. 합성은 기본이 로비 10분 앞부터 30분까지다. */
export function replayBounds(meta: ForensicMeta): ReplayBounds {
  const synthetic = meta.source === 'SYNTHETIC';
  return {
    fromMs: meta.windowFromMs ?? (synthetic ? -LOBBY_MS : 0),
    toMs: meta.windowToMs ?? MAX_WINDOW_MS,
  };
}

export function prepareReplay(file: ReplayFileInput, accepted: Accepted, target: OpenTarget): ReplaySession {
  const columns = compactColumns(file.columns, accepted.keep);
  const bounds = replayBounds(file.meta);
  return {
    target,
    envelope: file.envelope,
    meta: file.meta,
    schema: file.schema,
    columns,
    rowCount: accepted.rowCount,
    kept: accepted.kept,
    dropped: accepted.dropped,
    droppedBy: accepted.droppedBy,
    checkpoints: buildCheckpoints(columns, { seatCount: file.meta.seatCount, windowMs: bounds.toMs }),
    bounds,
  };
}

/** 정본 d5 §7.17의 '사건 일부 버림' 문구. 0건이면 띠를 그리지 않는다. */
export function droppedNotice(dropped: number): string {
  return dropped > 0 ? `규칙에 맞지 않는 사건 ${dropped}건을 빼고 보입니다` : '';
}

export type ReplayView = 'problem' | 'receiving' | 'replay';

export interface ReplayScreenInput {
  file: boolean;
  problem: boolean;
  session: ReplaySession | null;
}

/**
 * 화면 고르기. 문제가 있으면 재생 화면을 그리지 않고, 세션이 있으면 0행도 재생 화면이다.
 * 받는 중(파일만 있거나 아직 없음)은 받는 중/준비 화면이다.
 */
export function replayScreenState(input: ReplayScreenInput): ReplayView {
  if (input.problem) return 'problem';
  if (input.session !== null) return 'replay';
  return 'receiving';
}
