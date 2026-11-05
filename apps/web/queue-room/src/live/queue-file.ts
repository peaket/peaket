// 대기 상태 파일 읽기(openapi QueueState, docs/frontend.md §3.4 아래 식, queue-admission §4, ADR-0207).
// 사람마다의 값은 서버가 셈하지 않고 브라우저가 이 파일과 내 순번으로 센다(§2.6).

export type SaleStatus = 'ON_SALE' | 'PAUSED' | 'ALL_HELD' | 'TIER_SOLD_OUT' | 'SOLD_OUT' | 'ENDED';
const SALE: readonly SaleStatus[] = ['ON_SALE', 'PAUSED', 'ALL_HELD', 'TIER_SOLD_OUT', 'SOLD_OUT', 'ENDED'];

export interface QueueState {
  serving: number;
  servingRate: number;
  saleStatus: SaleStatus;
  soldOutTiers: string[];
  removedUpToServing: number;
  removedBeforeSegment: number;
  /** 125바이트(구간 1,000번호). 없으면 빈 비트맵 */
  removedBitmap: Uint8Array;
  banner?: string;
  generatedAtMs: number;
  pollHintMs: number;
  admissionPaused: boolean;
  remainingSeats?: number;
  avgTicketsPerOrder?: number;
  seatmapLayoutPath?: string;
  /** 입장 임박 구간 파일만: 최근 serving 전진 기록 [시각(밀리초), 그때의 serving](시각 순) */
  servingSteps?: [number, number][];
}

export const SEGMENT_SIZE = 1000;
const BITMAP_BYTES = SEGMENT_SIZE / 8;

const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function decodeBitmap(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    if (bin.length !== BITMAP_BYTES) return null;
    const out = new Uint8Array(BITMAP_BYTES);
    for (let i = 0; i < BITMAP_BYTES; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 받은 JSON을 읽는다. 꼴이 틀리면 null(실패로 센다) */
export function parseQueueState(raw: unknown): QueueState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!int(r.serving) || !finite(r.servingRate) || !SALE.includes(r.saleStatus as SaleStatus) || !int(r.generatedAtMs)) return null;
  const bitmap = r.removedBitmap === undefined ? new Uint8Array(BITMAP_BYTES) : typeof r.removedBitmap === 'string' ? decodeBitmap(r.removedBitmap) : null;
  if (!bitmap) return null;
  const opt = <T>(v: unknown, ok: (x: unknown) => x is T): T | undefined => (ok(v) ? v : undefined);
  const s: QueueState = {
    serving: r.serving,
    servingRate: r.servingRate,
    saleStatus: r.saleStatus as SaleStatus,
    soldOutTiers: Array.isArray(r.soldOutTiers) ? r.soldOutTiers.filter((t): t is string => typeof t === 'string') : [],
    removedUpToServing: int(r.removedUpToServing) ? r.removedUpToServing : 0,
    removedBeforeSegment: int(r.removedBeforeSegment) ? r.removedBeforeSegment : 0,
    removedBitmap: bitmap,
    generatedAtMs: r.generatedAtMs,
    pollHintMs: int(r.pollHintMs) ? r.pollHintMs : 0,
    admissionPaused: r.admissionPaused === true,
  };
  if (typeof r.banner === 'string' && r.banner.trim() !== '') s.banner = r.banner;
  const seats = opt(r.remainingSeats, int);
  const avg = opt(r.avgTicketsPerOrder, finite);
  if (seats !== undefined) s.remainingSeats = seats;
  if (avg !== undefined) s.avgTicketsPerOrder = avg;
  if (typeof r.seatmapLayoutPath === 'string') s.seatmapLayoutPath = r.seatmapLayoutPath;
  if (Array.isArray(r.servingSteps)) {
    const steps = r.servingSteps.filter((x): x is [number, number] => Array.isArray(x) && x.length === 2 && int(x[0]) && int(x[1]));
    if (steps.length) s.servingSteps = steps.sort((a, b) => a[0] - b[0]);
  }
  return s;
}

export const segmentOf = (seq: number): number => Math.floor((seq - 1) / SEGMENT_SIZE);

/** 비트맵에서 앞 n비트(구간 첫 번호부터 n개) 가운데 켜진 수 */
export function popcountPrefix(bitmap: Uint8Array, n: number): number {
  const bits = Math.max(0, Math.min(n, BITMAP_BYTES * 8));
  let count = 0;
  const full = bits >> 3;
  for (let i = 0; i < full; i++) {
    let b = bitmap[i]!;
    while (b) {
      b &= b - 1;
      count++;
    }
  }
  const rest = bits & 7;
  if (rest) {
    let b = bitmap[full]! & (0xff << (8 - rest)) & 0xff;
    while (b) {
      b &= b - 1;
      count++;
    }
  }
  return count;
}

/**
 * 앞 인원 = (내 순번 − serving − 1) − (그 사이 빠진 번호). 빠진 번호 = 내 번호 앞까지 빠진 수 − serving까지 빠진 수.
 * 내 번호 앞까지 빠진 수 = removedBeforeSegment + 내 구간 비트맵의 앞 (내 순번 − 1 − s×1000)비트. 음수면 0
 */
export function aheadCount(mySeq: number, f: QueueState): number {
  const s = segmentOf(mySeq);
  const beforeMe = f.removedBeforeSegment + popcountPrefix(f.removedBitmap, mySeq - 1 - s * SEGMENT_SIZE);
  const between = Math.max(0, beforeMe - f.removedUpToServing);
  return Math.max(0, mySeq - f.serving - 1 - between);
}

/** 예상 대기(초). 속도가 0이거나 일시정지·입장 일시정지·일시 매진이면 null(숫자를 보이지 않는다) */
export function etaSeconds(ahead: number, f: QueueState): number | null {
  if (f.servingRate <= 0 || f.saleStatus === 'PAUSED' || f.saleStatus === 'ALL_HELD' || f.admissionPaused) return null;
  return ahead / f.servingRate;
}

/** '구매가 어려울 수 있음'(앞 인원 × 평균 구매 매수 > 남은 좌석). 두 값이 없으면 false */
export function purchaseUnlikely(ahead: number, f: QueueState): boolean {
  if (f.remainingSeats === undefined || f.avgTicketsPerOrder === undefined) return false;
  return ahead * f.avgTicketsPerOrder > f.remainingSeats;
}

/**
 * 단조 읽기(§3.4 '오래된 파일 버리기'): 마지막으로 반영한 파일보다 생성 시각이 늦지 않으면 버린다. 새롭지만 serving이 작으면
 * 판매 상태·공지·폴링 힌트만 받는다. 그런 파일이 10초 [가정] 넘게 이어지면 새 값을 받는다(되돌아간 원본을 따라간다)
 */
export class MonotonicReader {
  private last: QueueState | null = null;
  private lowerSince: number | null = null;
  private readonly regressAcceptMs: number;
  constructor(regressAcceptMs = 10_000) {
    this.regressAcceptMs = regressAcceptMs;
  }

  /** 반영할 값(버리면 null) */
  accept(f: QueueState, nowMs: number): QueueState | null {
    const last = this.last;
    if (last && f.generatedAtMs <= last.generatedAtMs) return null;
    if (last && f.serving < last.serving) {
      this.lowerSince ??= nowMs;
      if (nowMs - this.lowerSince <= this.regressAcceptMs) {
        const merged: QueueState = { ...last, saleStatus: f.saleStatus, pollHintMs: f.pollHintMs, admissionPaused: f.admissionPaused, generatedAtMs: f.generatedAtMs };
        if (f.banner === undefined) delete merged.banner;
        else merged.banner = f.banner;
        this.last = merged;
        return merged;
      }
    }
    this.lowerSince = null;
    this.last = f;
    return f;
  }

  get current(): QueueState | null {
    return this.last;
  }
}

export interface PollInput {
  ahead: number;
  servingRate: number;
  /** 내 구간과 serving의 구간 */
  mySegment: number;
  servingSegment: number;
  pollHintMs: number;
}

/**
 * 다음 폴링까지(밀리초, docs/frontend.md §5.1 nextDelayMs). 속도가 0이면 내 구간이 serving 구간이나 바로 다음 구간일 때 0.5초,
 * 아니면 20초다(ADR-0207 결정 7). random은 [0, 1)
 */
export function nextDelayMs(s: PollInput, failures: number, hidden: boolean, retryAfterMs: number | null, random: () => number): number {
  let base: number;
  if (s.servingRate <= 0) base = s.mySegment <= s.servingSegment + 1 ? 500 : 20_000;
  else {
    const eta = s.ahead / s.servingRate;
    base = eta <= 60 ? 500 : eta <= 300 ? 5000 : 20_000;
  }
  if (failures > 0) base = Math.min(base * 2 ** failures, 60_000);
  if (hidden) base = Math.max(base, 5000);
  const floor = Math.max(s.pollHintMs, retryAfterMs ?? 0);
  if (floor > 0) return Math.max(base, floor) * (1 + random() * 0.2);
  return base * (0.8 + random() * 0.4);
}

/**
 * 차례가 온 시각(보정 시계 밀리초, ADR-0208 결정 6). 서버가 주지 않으므로 브라우저가 정한다:
 * ① servingSteps에 내 번호를 넘은 전진이 있으면 그 시각, ② 차례 전이던 마지막 파일의 생성 시각(실제보다 이르다),
 * ③ 생성 시각 − (serving − 순번 + 1) ÷ servingRate(속도 0이면 생성 시각)
 */
export function turnAtOf(seq: number, f: QueueState, lastBeforeAt: number | null): number {
  const steps = f.servingSteps ?? [];
  for (let k = 1; k < steps.length; k++) if (steps[k - 1]![1] < seq && steps[k]![1] >= seq) return steps[k]![0];
  if (lastBeforeAt !== null) return lastBeforeAt;
  if (f.servingRate > 0) return Math.round(f.generatedAtMs - ((f.serving - seq + 1) / f.servingRate) * 1000);
  return f.generatedAtMs;
}
