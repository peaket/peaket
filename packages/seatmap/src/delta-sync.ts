// 좌석 델타의 세대·일련번호 판정과 구역 스냅샷 다시 맞추기(docs/frontend.md §4.4.1 '판 처리', docs/features/seat-hold.md §7, ADR-0117, ADR-0240, FE-T11, BUILD_ORDER HOT-100).
// 스냅샷을 기다리는 구역의 델타는 쌓아 두었다가 스냅샷의 판 뒤로 다시 얹는다. 같은 구역의 재요청은 한 번에 하나만 보낸다.
import { decodeSnapshot, type DeltaDecision, type Frame, type SectionVersions, type Snapshot } from './wire';

type DeltaFrame = Extract<Frame, { type: 'delta' }>;
type SectionDelta = DeltaFrame['sections'][number];

/** 세대가 오른 뒤 스냅샷을 무작위로 늦추는 범위 [가정] */
const EPOCH_JITTER_MS = 1_000;
/** 스냅샷을 기다리는 구역마다 쌓아 두는 델타 수 [가정]. 넘치면 오래된 것부터 버리고 다시 얹을 때 갭이면 한 번 더 묻는다 */
const BUFFER_MAX = 64;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 5_000;
/** 한 페이지의 자동 재시도 상한(ADR-0117, 분당 60회) */
const RETRY_WINDOW_MS = 60_000;
const RETRY_BUDGET = 60;

export interface DeltaSyncEngine {
  versions: SectionVersions;
  applyDelta(frame: DeltaFrame): DeltaDecision;
  applySectionSnapshot(snap: Snapshot): void;
}

export interface DeltaSyncDeps {
  engine: DeltaSyncEngine;
  /** 구역 하나의 스냅샷을 받는다(GET seatmap-snapshot?section=). 시간 초과·재시도는 api-client 읽기 규칙을 따른다 */
  fetchSection(section: number): Promise<ArrayBuffer | Uint8Array>;
  subscribed(): readonly number[];
  random(): number;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onApplied(sections: readonly number[]): void;
  onError(error: unknown): void;
  /** 다시 맞출 수 없다: 토큰이 끝났거나(unauthorized) 받은 좌석맵과 판이 다르다(layout). 화면이 대기실로 보내거나 좌석맵을 다시 받는다 */
  onFatal(kind: 'unauthorized' | 'layout', error: unknown): void;
}

interface Buffered {
  header: Pick<DeltaFrame, 'serverTimeMs' | 'maxWaitMs' | 'seatEpoch'>;
  section: SectionDelta;
}

interface Pending {
  inflight: boolean;
  timer: unknown;
  /** 실패·낮은 판으로 다시 물은 횟수 */
  tries: number;
  /** 요청 중에 세대가 올랐거나 다시 붙어, 끝난 뒤 한 번 더 물어야 한다 */
  again: boolean;
  buffer: Buffered[];
}

const backoff = (tries: number): number => Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (tries - 1));
const retryAfterOf = (err: unknown): number => {
  const v = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof v === 'number' && v > 0 ? v : 0;
};

export function createDeltaSync(d: DeltaSyncDeps) {
  const pending = new Map<number, Pending>();
  let disposed = false;
  let stopped = false;
  /** 예약한 재시도 시각(한 페이지 상한을 지킨다) */
  let retries: number[] = [];

  /** 다시 묻기까지 기다릴 시간: 두 배씩 ±20% 지터, Retry-After가 하한이고 분당 상한을 넘지 않는다(ADR-0117) */
  function retryDelay(tries: number, err?: unknown): number {
    const after = retryAfterOf(err);
    const wait = Math.max(backoff(tries) * (0.8 + d.random() * 0.4), after * (1 + d.random() * 0.2));
    const now = d.now();
    let at = now + wait;
    retries = retries.filter((t) => t > at - RETRY_WINDOW_MS).sort((a, b) => a - b);
    if (retries.length >= RETRY_BUDGET) at = Math.max(at, retries[retries.length - RETRY_BUDGET]! + RETRY_WINDOW_MS);
    retries.push(at);
    return at - now;
  }

  const entry = (section: number): Pending => {
    let e = pending.get(section);
    if (!e) {
      e = { inflight: false, timer: undefined, tries: 0, again: false, buffer: [] };
      pending.set(section, e);
    }
    return e;
  };

  const push = (e: Pending, header: Buffered['header'], section: SectionDelta) => {
    e.buffer.push({ header, section });
    if (e.buffer.length > BUFFER_MAX) e.buffer.shift();
  };

  /** force: 요청 중이면 끝난 뒤 한 번 더 묻는다(세대가 올랐거나 다시 붙어 앞 요청의 값이 낡았을 수 있다). 갭은 쌓아 둔 델타로 끝나므로 force가 아니다 */
  function schedule(section: number, delayMs: number, force = false): void {
    const e = entry(section);
    if (stopped) return;
    if (e.inflight) {
      if (force) e.again = true;
      return;
    }
    if (e.timer !== undefined) return;
    if (delayMs <= 0) return run(section, e);
    e.timer = d.setTimer(() => {
      e.timer = undefined;
      run(section, e);
    }, delayMs);
  }

  function run(section: number, e: Pending): void {
    if (disposed || stopped) return;
    e.inflight = true;
    d.fetchSection(section).then(
      (buf) => {
        e.inflight = false;
        if (!disposed) received(section, e, buf);
      },
      (err: unknown) => {
        e.inflight = false;
        if (!disposed) failed(section, e, err);
      },
    );
  }

  function failed(section: number, e: Pending, err: unknown): void {
    const status = (err as { status?: unknown } | null)?.status;
    if (status === 401 || status === 403) {
      stopped = true;
      d.onFatal('unauthorized', err);
      return;
    }
    e.tries++;
    schedule(section, retryDelay(e.tries, err));
  }

  function received(section: number, e: Pending, buf: ArrayBuffer | Uint8Array): void {
    let snap: Snapshot;
    try {
      snap = decodeSnapshot(buf);
      if ((snap.flags & 1) === 0 || snap.sections[0]?.sectionIndex !== section) throw new Error(`구역 ${section}의 스냅샷이 아니다`);
    } catch (err) {
      d.onError(err);
      e.tries++;
      schedule(section, retryDelay(e.tries));
      return;
    }
    // 세대가 낮은 응답(장애 조치 전에 읽은 값)은 쓰지 않는다
    if (snap.seatEpoch < d.engine.versions.seatEpoch) {
      e.tries++;
      schedule(section, retryDelay(e.tries));
      return;
    }
    const epochUp = snap.seatEpoch > d.engine.versions.seatEpoch;
    try {
      d.engine.applySectionSnapshot(snap);
    } catch (err) {
      stopped = true;
      d.onFatal('layout', err);
      return;
    }
    // 스냅샷으로 세대가 올랐으면 다른 구역의 판은 옛 세대 값이라 새 델타를 버리게 된다. 다시 맞춘다
    if (epochUp) resyncAll(section);
    replay(section, e);
  }

  /** 쌓아 둔 델타를 세대·판 차례로 다시 얹는다. 아직 갭이면 한 번 더 묻는다(ADR-0117) */
  function replay(section: number, e: Pending): void {
    e.buffer.sort((a, b) => a.header.seatEpoch - b.header.seatEpoch || a.section.sectionVersion - b.section.sectionVersion);
    while (e.buffer.length > 0) {
      const item = e.buffer[0]!;
      let decision: DeltaDecision;
      try {
        decision = d.engine.applyDelta({ type: 'delta', ...item.header, sections: [item.section] });
      } catch (err) {
        d.onError(err);
        e.buffer.shift();
        continue;
      }
      if (decision.kind === 'resync-all' || decision.resync.includes(section)) {
        const wait = e.tries === 0 ? 0 : retryDelay(e.tries);
        e.tries++;
        schedule(section, wait);
        return;
      }
      e.buffer.shift();
    }
    if (e.again) {
      e.again = false;
      d.onApplied([section]);
      schedule(section, 0);
      return;
    }
    pending.delete(section);
    d.onApplied([section]);
  }

  function resyncAll(except?: number): void {
    const delay = Math.floor(d.random() * EPOCH_JITTER_MS);
    for (const s of d.subscribed()) if (s !== except) schedule(s, delay, true);
  }

  return {
    /** 받은 SeatDeltaBatch 하나 */
    onDelta(frame: DeltaFrame): void {
      if (disposed) return;
      const header = { serverTimeMs: frame.serverTimeMs, maxWaitMs: frame.maxWaitMs, seatEpoch: frame.seatEpoch };
      const direct: SectionDelta[] = [];
      for (const s of frame.sections) {
        const e = pending.get(s.sectionIndex);
        if (e) push(e, header, s);
        else direct.push(s);
      }
      if (direct.length === 0) return;
      let decision: DeltaDecision;
      try {
        decision = d.engine.applyDelta({ ...frame, sections: direct });
      } catch (err) {
        d.onError(err);
        return;
      }
      if (decision.kind === 'resync-all') {
        resyncAll();
        for (const s of direct) {
          const e = pending.get(s.sectionIndex);
          if (e) push(e, header, s);
        }
        return;
      }
      for (const index of decision.resync) {
        const s = direct.find((x) => x.sectionIndex === index)!;
        push(entry(index), header, s);
        schedule(index, 0);
      }
      if (decision.sections.length > 0) d.onApplied(decision.sections);
    },
    /** 다시 붙었거나 새로 구독한 구역을 스냅샷으로 맞춘다 */
    resync(sections: readonly number[]): void {
      if (disposed) return;
      for (const s of new Set(sections)) schedule(s, 0, true);
    },
    pendingSections: (): number[] => [...pending.keys()],
    dispose(): void {
      disposed = true;
      for (const e of pending.values()) if (e.timer !== undefined) d.clearTimer(e.timer);
      pending.clear();
    },
  };
}

export type DeltaSync = ReturnType<typeof createDeltaSync>;
