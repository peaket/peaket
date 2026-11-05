// 대기 상태 파일의 규칙 값과 만들기(docs/features/queue-admission.md §4 '대기 상태 파일의 첫 구현', openapi QueueState, ADR-0110).
// 파일 하나가 구간 하나(번호 1,000개)다. 같은 구간의 대기자가 같은 파일을 받으므로 사람별 값은 없다.
import { type EventSchedule, saleEndOf, SEGMENT_SIZE, segmentOf } from '../../entry/index.js';
import { AVG_TICKETS_MAX, AVG_TICKETS_MIN, SEAT_COUNT_CLOCK_SKEW_MS } from '../../sale/index.js';

/** 차례 진행 속도를 내는 창(1초 칸 수) [가정] */
export const RATE_SLOTS = 10;
/** 입장 임박 구간 파일에 싣는 최근 serving 전진의 창 [가정] */
export const STEPS_WINDOW_MS = 5_000;
/** 입장 임박 구간: 그 구간의 첫 번호까지 예상 대기가 이 초 이내(ADR-0110) */
export const IMMINENT_WAIT_S = 60;
/** 남은 좌석 수 칸을 싣는 셈의 신선도 [가정]: 셈 시각이 생성 시각에서 이 안일 때만 싣는다(ADR-0219 결정 5) */
export const SEAT_COUNT_FRESH_MS = 30_000;
/** 평균 구매 매수가 없거나 1~10 밖일 때의 기본값 [가정](ADR-0219 결정 6) */
export const DEFAULT_AVG_TICKETS_PER_ORDER = 2;
/** 마지막 요청 뒤 회차를 켜 두는 시간 [가정] */
export const ACTIVE_FOR_MS = 60_000;
/** 파드 하나가 켜 두는 회차 수의 상한 [가정] */
export const MAX_ACTIVE_EVENTS = 1_000;
/** 읽는 serving_log의 끝 칸 수: 창 10칸 + 창 앞 기준 칸 + 시계가 어긋나 생긴 미래 칸의 여유 [가정] */
export const LOG_TAIL = 20;
/** 매초 생성에서 함께 만드는 회차 수 [가정](느린 샤드의 회차 하나가 다른 회차를 붙잡지 않게) */
export const TICK_CONCURRENCY = 8;
/** 읽는 calls의 끝 항목 수 [가정] */
export const CALLS_TAIL = 50;
/** seq가 든 구간 뒤로도 같은 값으로 만드는 구간 수 [가정]. 경계 뒤 받은 번호의 구간이 다음 경계까지 404가 되지 않게 한다 */
export const AHEAD_SEGMENTS = 100;
/** 구간 비트맵 크기(번호 1,000개) */
export const BITMAP_BYTES = SEGMENT_SIZE / 8;

/** 회차 슬롯에서 한 번에 읽은 값 */
export interface StateSnapshot {
  /** 지금까지 낸 번호의 끝(q:{event:E}:seq) */
  seq: number;
  serving: number;
  /** 빠진 번호 비트맵의 앞부분. 번호 n은 바이트 n >> 3의 높은 비트부터 (n & 7)번째(Redis SETBIT과 같은 순서) */
  removed: Uint8Array;
  /** 장애 전환 때 건너뛴 번호 구간(빠진 번호로 센다) */
  skipped: { start: number; end: number }[];
  /** serving_log의 끝: 1초 칸(초)과 그 칸의 마지막 serving, 칸 오름차순 */
  servingLog: { slot: number; serving: number }[];
  /** calls의 끝: 전진 시각(밀리초)과 그 전진의 마지막 번호 */
  calls: { atMs: number; last: number }[];
  /** q:{event:E}:notice의 판매 상태 칸(HOT-010, ADR-0214). 없으면 판매 중이고 일시정지·공지가 없다 */
  notice?: NoticeFields;
  /** q:{event:E}:ctl의 입장 일시정지(admitPaused가 1)와 그 만료(admitPausedUntil, 없으면 null). 리더와 같은 규칙으로 읽는다 */
  admit?: { paused: boolean; untilMs: number | null };
}

/** notice의 칸 가운데 파일이 쓰는 것(docs/data.md §3) */
export interface NoticeFields {
  /** 회차 판매 상태(ON_SALE·ALL_HELD·SOLD_OUT·ENDED, EventSaleChanged 처리기가 쓴다) */
  saleState?: string;
  /** 매진 등급(등급 ID) */
  soldOutTiers?: string[];
  /** 판매 일시정지(명령 3)·판매 중지(제어 받는 쪽이 쓴다) */
  paused?: boolean;
  suspended?: boolean;
  /** 공지 배너 글(명령 7) */
  banner?: string;
  /** 남은 좌석 수와 그 셈 시각(유닉스 밀리초), 평균 구매 매수(판매 상태 사건의 셈, HOT-011, ADR-0219) */
  remainingSeats?: number;
  seatsAtMs?: number;
  avgTicketsPerOrder?: number;
}

/** 전체 범위 q:{event:PLATFORM}:notice(일시정지·판매 중지·공지 배너) */
export type PlatformNotice = Pick<NoticeFields, 'paused' | 'suspended' | 'banner'>;

export type SaleStatus = 'ON_SALE' | 'PAUSED' | 'ALL_HELD' | 'TIER_SOLD_OUT' | 'SOLD_OUT' | 'ENDED';

/**
 * 파일의 판매 상태: 판매 종료(생성 시각이나 saleState) > SOLD_OUT > PAUSED(회차·전체 범위의 paused·suspended) > ALL_HELD > TIER_SOLD_OUT(매진 등급이 있음) > ON_SALE
 * (ADR-0122·0214 결정 4). 모르는 saleState는 판매 중으로 본다(리더는 전진하지 않는다)
 */
export function saleStatusOf(o: { saleEnded: boolean; notice: NoticeFields; platform: PlatformNotice }): SaleStatus {
  const n = o.notice;
  if (o.saleEnded || n.saleState === 'ENDED') return 'ENDED';
  if (n.saleState === 'SOLD_OUT') return 'SOLD_OUT';
  if (n.paused || n.suspended || o.platform.paused || o.platform.suspended) return 'PAUSED';
  if (n.saleState === 'ALL_HELD') return 'ALL_HELD';
  if ((n.soldOutTiers?.length ?? 0) > 0) return 'TIER_SOLD_OUT';
  return 'ON_SALE';
}

/** openapi QueueState */
export interface QueueStateBody {
  serving: number;
  servingRate: number;
  saleStatus: SaleStatus;
  soldOutTiers: string[];
  /** 입장 일시정지(명령 2, BAS-042) */
  admissionPaused: boolean;
  /** 그 회차 좌석맵 파일의 경로(일정 사본에 좌석맵 판이 있을 때만, BAS-042·HOT-011) */
  seatmapLayoutPath?: string;
  /** 남은 좌석 수와 평균 구매 매수(셈이 30초 [가정] 안일 때만 함께, POL-015) */
  remainingSeats?: number;
  avgTicketsPerOrder?: number;
  /** 공지 배너 글(있을 때만) */
  banner?: string;
  removedUpToServing: number;
  removedBeforeSegment: number;
  removedBitmap: string;
  generatedAtMs: number;
  pollHintMs: number;
  servingSteps?: [number, number][];
}

/** 미리 만든 파일 하나(본문은 JSON 문자열로 둬 요청마다 다시 만들지 않는다) */
export interface StateFile {
  body: string;
  imminent: boolean;
  generatedAtMs: number;
}

/** 파일을 만드는 초 경계(밀리초) */
export const boundaryOf = (ms: number): number => Math.floor(ms / 1000) * 1000;

/** 빠진 번호 셈: 비트맵의 비트와 건너뛴 구간을 합친다. seq보다 뒤 번호는 아직 내지 않아 세지 않는다 */
class Removed {
  readonly #segBits: Uint8Array[] = [];
  /** 구간 앞까지의 빠진 번호 누계(구간 s 앞 = prefix[s]) */
  readonly prefix: number[] = [];
  /** seq까지의 빠진 번호 전부 */
  readonly total: number;

  constructor(
    private readonly s: StateSnapshot,
    readonly lastSegment: number,
  ) {
    const ranges = [...s.skipped].sort((a, b) => a.start - b.start);
    let r = 0;
    let total = 0;
    for (let seg = 0; seg <= lastSegment; seg++) {
      const bits = new Uint8Array(BITMAP_BYTES);
      this.prefix.push(total);
      const first = seg * SEGMENT_SIZE + 1;
      for (let k = 0; k < SEGMENT_SIZE; k++) {
        const n = first + k;
        if (n > s.seq) break;
        while (r < ranges.length && ranges[r]!.end < n) r++;
        const skipped = r < ranges.length && ranges[r]!.start <= n;
        const bit = ((s.removed[n >> 3] ?? 0) >> (7 - (n & 7))) & 1;
        if (bit === 1 || skipped) {
          bits[k >> 3]! |= 0x80 >> (k & 7);
          total++;
        }
      }
      this.#segBits.push(bits);
    }
    this.total = total;
  }

  /** 구간 s 앞까지의 누계(seq가 든 구간 뒤는 전부) */
  before(seg: number): number {
    return seg <= this.lastSegment ? this.prefix[seg]! : this.total;
  }

  bitsOf(seg: number): Uint8Array {
    return this.#segBits[seg] ?? new Uint8Array(BITMAP_BYTES);
  }

  /** 번호 1부터 x까지의 빠진 번호 수 */
  upTo(x: number): number {
    const n = Math.min(Math.max(x, 0), this.s.seq);
    if (n < 1) return 0;
    const seg = segmentOf(n);
    if (seg > this.lastSegment) return this.total;
    return this.prefix[seg]! + popcount(this.bitsOf(seg), n - seg * SEGMENT_SIZE);
  }
}

/** 앞 k비트의 켜진 비트 수 */
function popcount(bits: Uint8Array, k: number): number {
  let c = 0;
  for (let i = 0; i < k; i++) c += (bits[i >> 3]! >> (7 - (i & 7))) & 1;
  return c;
}

/**
 * 차례 진행 속도: 다 지난 최근 RATE_SLOTS칸(지금 칸은 막 시작해 빼고, 미래 칸은 시계가 어긋난 것이라 뺀다) 동안 serving이 지난 유효 번호(빠진 번호를 뺀 번호) 수
 * ÷ 칸 수. 창 앞의 기준(창보다 앞선 마지막 칸의 serving)이 있으면 창 10칸 전체로 나눠, 전진이 없던 칸도 센다. 없으면(창 안에서 처음 움직임) 기준 0과
 * 창 안에서 기록이 있는 가장 오래된 칸부터 지난 칸 끝까지의 칸 수로 나눈다
 */
function rateOf(s: StateSnapshot, removed: Removed, generatedAtMs: number): number {
  const last = Math.floor(generatedAtMs / 1000) - 1;
  const from = last - RATE_SLOTS + 1;
  const inWindow = s.servingLog.filter((e) => e.slot >= from && e.slot <= last);
  if (inWindow.length === 0) return 0;
  const before = [...s.servingLog].reverse().find((e) => e.slot < from);
  const base = before?.serving ?? 0;
  const end = inWindow[inWindow.length - 1]!.serving;
  const valid = end - base - (removed.upTo(end) - removed.upTo(base));
  const slots = before ? RATE_SLOTS : last - inWindow[0]!.slot + 1;
  const rate = Math.max(0, valid) / slots;
  return Math.round(rate * 1000) / 1000;
}

/**
 * 남은 좌석 수 칸: 셈이 생성 시각에서 30초 [가정] 안이면 남은 좌석 수와 평균 구매 매수(없거나 1~10 밖이면 2 [가정])를 함께, 아니면 둘 다 뺀다.
 * 셈 시각이 생성 시각보다 5초 [가정] 넘게 앞서면(시계가 어긋난 셈) 뺀다. 앞선 시각이 신선도를 늘리지 않게 한다
 */
function seatCountsOf(n: NoticeFields, generatedAtMs: number): Pick<QueueStateBody, 'remainingSeats' | 'avgTicketsPerOrder'> {
  const { remainingSeats: left, seatsAtMs: at, avgTicketsPerOrder: avg } = n;
  if (left === undefined || at === undefined || !Number.isSafeInteger(left) || left < 0) return {};
  const age = generatedAtMs - at;
  if (age > SEAT_COUNT_FRESH_MS || age < -SEAT_COUNT_CLOCK_SKEW_MS) return {};
  const ok = avg !== undefined && Number.isFinite(avg) && avg >= AVG_TICKETS_MIN && avg <= AVG_TICKETS_MAX;
  return { remainingSeats: left, avgTicketsPerOrder: ok ? avg : DEFAULT_AVG_TICKETS_PER_ORDER };
}

/** 그 회차 좌석맵 파일의 경로(docs/frontend.md §4.2.2). 회차 ID나 판 번호가 없으면 없다 */
const seatmapPathOf = (eventId: string | undefined, schedule: EventSchedule): string | undefined =>
  eventId !== undefined && schedule.layoutVersion !== undefined ? `/v1/events/${encodeURIComponent(eventId)}/seatmap-layouts/${schedule.layoutVersion}.json` : undefined;

/** 회차의 모든 구간 파일. 구간 0부터 seq가 든 구간(seq가 0이면 구간 0) 뒤 AHEAD_SEGMENTS 구간까지. eventId는 좌석맵 경로에 쓴다(없으면 그 칸을 뺀다) */
export function buildStateFiles(s: StateSnapshot, schedule: EventSchedule, generatedAtMs: number, platform: PlatformNotice = {}, eventId?: string): StateFile[] {
  const lastSegment = s.seq >= 1 ? segmentOf(s.seq) : 0;
  const maxSegment = lastSegment + AHEAD_SEGMENTS;
  const removed = new Removed(s, lastSegment);
  const rate = rateOf(s, removed, generatedAtMs);
  const servingSegment = s.serving >= 1 ? Math.min(segmentOf(s.serving), maxSegment) : 0;
  // 다음에 부를 번호(serving + 1)의 구간. serving이 구간 끝이면 그다음 구간이다
  const nextSegment = Math.min(segmentOf(s.serving + 1), maxSegment);
  const removedUpToServing = removed.upTo(s.serving);
  const notice = s.notice ?? {};
  const saleStatus = saleStatusOf({ saleEnded: generatedAtMs >= saleEndOf(schedule), notice, platform });
  const soldOutTiers = [...(notice.soldOutTiers ?? [])];
  const banner = notice.banner || platform.banner;
  const admissionPaused = s.admit?.paused === true && (s.admit.untilMs === null || generatedAtMs < s.admit.untilMs);
  const seatmapLayoutPath = seatmapPathOf(eventId, schedule);
  const seatCounts = seatCountsOf(notice, generatedAtMs);
  const steps = s.calls
    // 경계 뒤 읽기 전에 일어난 전진도 serving에 들어 있으므로 위쪽은 자르지 않는다
    .filter((c) => c.atMs >= generatedAtMs - STEPS_WINDOW_MS)
    .sort((a, b) => a.atMs - b.atMs)
    .map((c): [number, number] => [c.atMs, c.last]);

  // 입장 임박: serving이 든 구간과 다음 번호의 구간부터, 그 구간의 첫 번호까지 앞 인원 ÷ 속도가 60초 이내인 구간까지(속도가 0이면 그 둘만)
  const imminent = new Set<number>([servingSegment, nextSegment]);
  if (rate > 0) {
    for (let seg = nextSegment + 1; seg <= maxSegment; seg++) {
      const first = seg * SEGMENT_SIZE + 1;
      const ahead = Math.max(0, first - s.serving - 1 - (removed.upTo(first - 1) - removed.upTo(s.serving)));
      if (ahead / rate > IMMINENT_WAIT_S) break;
      imminent.add(seg);
    }
  }

  const files: StateFile[] = [];
  for (let seg = 0; seg <= maxSegment; seg++) {
    const near = imminent.has(seg);
    const body: QueueStateBody = {
      serving: s.serving,
      servingRate: rate,
      saleStatus,
      soldOutTiers,
      admissionPaused,
      ...(seatmapLayoutPath ? { seatmapLayoutPath } : {}),
      ...seatCounts,
      ...(banner ? { banner } : {}),
      removedUpToServing,
      removedBeforeSegment: removed.before(seg),
      removedBitmap: Buffer.from(removed.bitsOf(seg)).toString('base64'),
      generatedAtMs,
      pollHintMs: 0,
      ...(near ? { servingSteps: steps } : {}),
    };
    files.push({ body: JSON.stringify(body), imminent: near, generatedAtMs });
  }
  return files;
}
