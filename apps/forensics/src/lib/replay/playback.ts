// F-04-17 재생 상태·키보드·숫자 입력. 정본: docs/features/forensic-replay.md §2.3·§8 FX-T8.
// 재생·일시정지·배속·구간 고르기를 화면과 따로 계산해, 키보드만 쓴 사람도 같은 값을 얻는다.
import type { ReplayBounds } from './session.ts';

export type Speed = 1 | 10 | 60;

export interface PlaybackRange {
  fromMs: number;
  toMs: number;
}

export interface PlaybackState {
  playing: boolean;
  speed: Speed;
  playheadMs: number;
  range: PlaybackRange | null;
  anchorMs: number | null;
}

export interface TimelineKey {
  key: string;
  shiftKey?: boolean;
}

export interface TimelineAria {
  min: number;
  max: number;
  now: number;
  text: string;
}

const MINUS = '\u2212';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function initialPlayback(bounds: ReplayBounds): PlaybackState {
  return { playing: true, speed: 1, playheadMs: bounds.fromMs, range: null, anchorMs: null };
}

export function timelineKey(state: PlaybackState, key: TimelineKey, bounds: ReplayBounds): PlaybackState {
  const step = key.shiftKey ? 10_000 : 1_000;
  if (key.key === 'ArrowLeft') {
    return { ...state, playheadMs: clamp(state.playheadMs - step, bounds.fromMs, bounds.toMs) };
  }
  if (key.key === 'ArrowRight') {
    return { ...state, playheadMs: clamp(state.playheadMs + step, bounds.fromMs, bounds.toMs) };
  }
  if (key.key === ' ') return { ...state, playing: !state.playing };
  if (key.key === 'Home') return { ...state, playheadMs: bounds.fromMs };
  if (key.key === 'End') return { ...state, playheadMs: bounds.toMs };
  if (key.key === '[') {
    if (state.anchorMs === null) return { ...state, anchorMs: state.playheadMs };
    const fromMs = Math.min(state.anchorMs, state.playheadMs);
    const toMs = Math.max(state.anchorMs, state.playheadMs);
    if (fromMs === toMs) return { ...state, range: null, anchorMs: null };
    return { ...state, range: { fromMs, toMs }, anchorMs: null };
  }
  if (key.key === 'Escape' || key.key === 'Esc') return { ...state, range: null, anchorMs: null };
  return state;
}

export function advancePlayback(state: PlaybackState, elapsedMs: number, bounds: ReplayBounds): PlaybackState {
  if (!state.playing || elapsedMs <= 0) return state;
  const next = state.playheadMs + elapsedMs * state.speed;
  if (next >= bounds.toMs) return { ...state, playheadMs: bounds.toMs, playing: false };
  return { ...state, playheadMs: next };
}

export function setSpeed(state: PlaybackState, speed: Speed): PlaybackState {
  if (speed !== 1 && speed !== 10 && speed !== 60) throw new TypeError('배속은 ×1·×10·×60만 쓴다');
  return { ...state, speed };
}

export function timelineAria(state: PlaybackState, bounds: ReplayBounds): TimelineAria {
  const head = formatOffset(state.playheadMs);
  const text = state.range === null
    ? head
    : `${head} · 구간 ${formatOffset(state.range.fromMs)}~${formatOffset(state.range.toMs)}`;
  return { min: bounds.fromMs, max: bounds.toMs, now: state.playheadMs, text };
}

/** 판매 시작 기준 시각. 음수는 0 쪽으로 자른 초를 쓴다(-1500 → T−00:01). */
export function formatOffset(ms: number): string {
  const sign = ms < 0 ? MINUS : '+';
  const total = Math.trunc(Math.abs(ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `T${sign}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

const WITH_T = /^T([+\u2212])(\d{1,3}):(\d{2})$/;
const PLAIN = /^(-?)(\d{1,3}):(\d{2})$/;
const SECONDS = /^-?\d+$/;

/** T+MM:SS·T−MM:SS·MM:SS·-MM:SS·정수 초만 읽는다. T 뒤 ASCII 하이픈은 정본에 없어 거절한다. */
export function parseOffset(textValue: string): number | undefined {
  const text = textValue.trim();
  if (text === '') return undefined;
  const withT = WITH_T.exec(text);
  if (withT) {
    const minutes = Number(withT[2]);
    const seconds = Number(withT[3]);
    if (minutes > 1799 || seconds > 59) return undefined;
    const value = (minutes * 60 + seconds) * 1000;
    return withT[1] === MINUS ? -value : value;
  }
  const plain = PLAIN.exec(text);
  if (plain) {
    const minutes = Number(plain[2]);
    const seconds = Number(plain[3]);
    if (minutes > 1799 || seconds > 59) return undefined;
    const value = (minutes * 60 + seconds) * 1000;
    return plain[1] === '-' ? -value : value;
  }
  if (!SECONDS.test(text)) return undefined;
  const seconds = Number(text);
  return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
}

/** 숫자 입력 두 개를 구간으로 바꾼다. 뒤집힌 입력은 정리하고, 범위 밖·같은 값은 거절한다. */
export function rangeFromInput(from: string, to: string, bounds: ReplayBounds): PlaybackRange | undefined {
  const a = parseOffset(from);
  const b = parseOffset(to);
  if (a === undefined || b === undefined) return undefined;
  const fromMs = Math.min(a, b);
  const toMs = Math.max(a, b);
  if (fromMs === toMs) return undefined;
  if (fromMs < bounds.fromMs || toMs > bounds.toMs) return undefined;
  return { fromMs, toMs };
}
