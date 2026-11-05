// 서버 시각으로 보정한 화면 시계(docs/frontend.md §3.3, ADR-0079 결정 3, ADR-0110, BUILD_ORDER HOT-311).
// - 보정한 벽시계 = 고른 표본의 서버 시각 + 그 뒤 단조 시계(performance.now())로 잰 경과. 기기 시계가 그사이 바뀌어도 흔들리지 않는다.
// - 표본: offset = 서버 시각 + 왕복/2 − 받은 시각. 최근 8개 [가정] 가운데 왕복이 가장 짧은 표본을 쓴다.
// - 캐시한 응답(CDN)의 Date는 원본 시각 그대로라 표본이 아니다. 캐시하지 않는(no-store) api 응답의 Date만 넘긴다(addDateHeader).
//   Date는 초 단위라 그 초의 가운데(+500ms)로 본다(버림 오차를 반으로).
// - 보정값(서버 시각과의 차, 표본 시각, 왕복)은 localStorage `peaket.clock`(§3.12)에 두고, 30분 [가정] 안이면 다시 연 탭도 쓴다.

const KEY = 'peaket.clock';
const MAX_SAMPLES = 8;
const MAX_AGE_MS = 30 * 60_000;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface Sample {
  /** 받은 순간의 서버 시각(서버 시각 + 왕복/2) */
  serverAtReceive: number;
  receivedMono: number;
  rttMs: number;
}

export interface Clock {
  /** 보정한 지금(유닉스 밀리초) */
  now(): number;
  addSample(s: { serverMs: number; sentMono: number; receivedMono: number }): void;
  /** 캐시하지 않는 응답의 Date 머리로 표본을 더한다. 받았으면 true */
  addDateHeader(date: string | null | undefined, sentMono: number, receivedMono: number): boolean;
}

export function createClock({ wall = () => Date.now(), mono = () => performance.now(), storage }: { wall?: () => number; mono?: () => number; storage?: StorageLike } = {}): Clock {
  const samples: Sample[] = [];
  /** 다시 연 탭: 저장한 보정값(서버 시각 − 기기 시각) */
  let stored: number | undefined;
  try {
    const raw = storage?.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as { offsetMs?: unknown; sampledAt?: unknown };
      if (typeof v.offsetMs === 'number' && typeof v.sampledAt === 'number' && Number.isFinite(v.offsetMs) && wall() - v.sampledAt <= MAX_AGE_MS && wall() >= v.sampledAt) stored = v.offsetMs;
    }
  } catch {
    // 저장소를 못 쓰면 기기 시계로 시작한다
  }

  const best = (): Sample | undefined => samples.reduce<Sample | undefined>((b, s) => (!b || s.rttMs < b.rttMs ? s : b), undefined);

  const clock: Clock = {
    now() {
      const b = best();
      if (b) return b.serverAtReceive + (mono() - b.receivedMono);
      return wall() + (stored ?? 0);
    },
    addSample({ serverMs, sentMono, receivedMono }) {
      const rttMs = Math.max(0, receivedMono - sentMono);
      const s: Sample = { serverAtReceive: serverMs + rttMs / 2, receivedMono, rttMs };
      samples.push(s);
      if (samples.length > MAX_SAMPLES) samples.shift();
      const b = best()!;
      const wallNow = wall();
      try {
        storage?.setItem(KEY, JSON.stringify({ offsetMs: b.serverAtReceive + (mono() - b.receivedMono) - wallNow, sampledAt: wallNow, rttMs: b.rttMs }));
      } catch {
        // 저장하지 못해도 이 탭은 표본을 쓴다
      }
    },
    addDateHeader(date, sentMono, receivedMono) {
      if (!date) return false;
      const t = Date.parse(date);
      if (Number.isNaN(t)) return false;
      clock.addSample({ serverMs: t + 500, sentMono, receivedMono });
      return true;
    },
  };
  return clock;
}

let shared: Clock | undefined;

/** 브라우저에서 화면들이 함께 쓰는 시계(처음 부를 때 저장한 보정값을 읽는다) */
export function browserClock(): Clock {
  if (!shared) {
    let storage: StorageLike | undefined;
    try {
      storage = window.localStorage;
    } catch {
      storage = undefined;
    }
    shared = createClock(storage ? { storage } : {});
  }
  return shared;
}
