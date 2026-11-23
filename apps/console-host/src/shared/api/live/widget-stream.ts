// 위젯 흐름 관리(docs/frontend.md §4.4.5 '구독 수명'·§5.7 '안 보이는 위젯', ADR-0091 결정 3, ADR-0100 결정 2, ADR-0360, ADR-0361 결정 9).
// 호스트가 보이는 위젯 키를 모은다. 같은 위젯 키는 흐름 하나로 받아 구독자 모두에게 나눠 준다(shareByKey).
// - 마지막 구독자가 떠나도 10초 [가정] 동안 목록에 남긴다(그 사이 다시 오면 흐름을 다시 열지 않는다). 10초가 지나면 목록에서 빼고,
//   목록이 바뀌면 1초 [가정] 묶어 위젯 흐름만 새 widgets로 다시 연다(늘 여는 흐름은 건드리지 않는다). 목록이 비면 닫는다.
// - 브라우저 탭을 30초 [가정] 넘게 숨기면 위젯 키를 모두 빼 흐름을 닫는다. 구독자는 멈춤으로 남기고, 다시 보이면 바로 다시 열며
//   키마다 위젯 조회(refill, 최근 15분 창)를 한 번 불러 같은 구독자에게 넘긴다(위젯은 자기가 보이는지 따지지 않는다, §4.5).
// - 회차를 바꾸면 남겨 둔 키(유예 중)를 바로 버리고 묶지 않고 다시 연다.
// 흐름 만들기·시계·조회는 넘겨받는다(ManagedStream). 가져오는 값이 없는 순수 모듈이라 Node 내장 시험 실행기로 그대로 읽는다.
import type { SseFrame, StreamTimers } from './live-stream';

/** 목록 바뀜을 묶는 시간 1초 [가정] */
export const WIDGET_LIST_DEBOUNCE_MS = 1_000;
/** 마지막 구독자가 떠난 뒤 목록에 남기는 시간 10초 [가정] */
export const WIDGET_GRACE_MS = 10_000;
/** 브라우저 탭을 숨긴 뒤 위젯 흐름을 닫기까지 30초 [가정] */
export const WIDGET_HIDDEN_MS = 30_000;

export interface WidgetValueMessage {
  widgetKey: string;
  at: string;
  value: unknown;
}

export interface StreamHandle {
  start(): void;
  stop(): void;
  restart(): void;
}

export interface WidgetStreamsDeps {
  /** 관제 API 주소(끝 / 없이) */
  origin: string;
  timers: StreamTimers;
  /** 주소와 사건 처리기로 흐름을 만든다(ManagedStream, resume 없이) */
  createStream: (url: () => string, onFrame: (f: SseFrame) => void) => StreamHandle;
  /** 숨긴 탭에서 돌아와 다시 열 때 키마다 한 번 부르는 위젯 조회(값 모양은 흐름 값과 같다, ADR-0360 결정 10). 없으면 부르지 않는다 */
  refill?: (key: string, eventId: string) => Promise<unknown>;
  /** 지금 시각(refill 값에 at이 없을 때) */
  now?: () => number;
  debounceMs?: number;
  graceMs?: number;
  hiddenMs?: number;
}

/** 위젯 흐름 주소: 키는 정렬해 같은 목록이면 같은 주소다 */
export function widgetStreamUrl(origin: string, eventId: string, keys: readonly string[]): string {
  const widgets = [...new Set(keys)].sort().join(',');
  return `${origin.replace(/\/+$/, '')}/v1/ops/events/${encodeURIComponent(eventId)}/live?widgets=${encodeURIComponent(widgets)}`;
}

export class WidgetStreams {
  readonly #listeners = new Map<string, Set<(m: WidgetValueMessage) => void>>();
  /** 구독자가 0이 되어 유예 중인 키 → 유예 타이머 */
  readonly #lingering = new Map<string, unknown>();
  #eventId: string | null = null;
  /** 지금 연 흐름의 키 목록(정렬) */
  #openKeys: string[] = [];
  #streamEvent: string | null = null;
  #stream: StreamHandle | undefined;
  #timer: unknown;
  #hiddenTimer: unknown;
  /** 숨긴 지 30초가 지나 위젯 흐름을 멈췄다 */
  #paused = false;
  /** 다시 연 횟수(시험·지표) */
  reopenCount = 0;

  constructor(private readonly deps: WidgetStreamsDeps) {}

  /** 지금 연 흐름의 키(정렬) */
  get openKeys(): readonly string[] {
    return this.#openKeys;
  }

  /** 지금 목록에 든 키(구독 중 + 유예 중, 정렬). 숨겨 멈춘 동안에도 돌아오면 열 키다 */
  get wantedKeys(): readonly string[] {
    return this.wanted();
  }

  get eventId(): string | null {
    return this.#eventId;
  }

  /** 숨겨 멈췄는가 */
  get paused(): boolean {
    return this.#paused;
  }

  /** 회차를 바꾼다. 바뀌면 유예 중인 키를 버리고 묶지 않고 바로 다시 연다 */
  setEvent(eventId: string | null): void {
    if (eventId === this.#eventId) return;
    this.#eventId = eventId;
    for (const t of this.#lingering.values()) this.deps.timers.clearTimeout(t);
    this.#lingering.clear();
    this.apply();
  }

  /** 브라우저 탭을 숨겼거나(참) 다시 보인다(거짓) */
  setHidden(hidden: boolean): void {
    if (hidden) {
      if (this.#paused || this.#hiddenTimer !== undefined) return;
      this.#hiddenTimer = this.deps.timers.setTimeout(() => {
        this.#hiddenTimer = undefined;
        this.#paused = true;
        this.apply();
      }, this.deps.hiddenMs ?? WIDGET_HIDDEN_MS);
      return;
    }
    if (this.#hiddenTimer !== undefined) {
      this.deps.timers.clearTimeout(this.#hiddenTimer);
      this.#hiddenTimer = undefined;
    }
    if (!this.#paused) return;
    this.#paused = false;
    this.apply();
    this.refillAll();
  }

  /** 위젯 키를 구독한다(위젯 자리가 보일 때). 돌려준 함수로 끊는다 */
  subscribe(key: string, next: (m: WidgetValueMessage) => void): () => void {
    const before = this.wanted();
    let set = this.#listeners.get(key);
    if (!set) {
      set = new Set();
      this.#listeners.set(key, set);
    }
    set.add(next);
    const linger = this.#lingering.get(key);
    if (linger !== undefined) {
      // 유예 중에 다시 왔다: 목록이 그대로라 흐름을 다시 열지 않는다
      this.deps.timers.clearTimeout(linger);
      this.#lingering.delete(key);
    }
    this.changed(before);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const s = this.#listeners.get(key);
      if (!s) return;
      s.delete(next);
      if (s.size > 0) return;
      this.#listeners.delete(key);
      // 마지막 구독자가 떠났다: 10초 [가정] 뒤에 목록에서 뺀다. 바뀌기 전 목록은 유예가 끝나 키를 빼기 직전에 잡는다
      this.#lingering.set(
        key,
        this.deps.timers.setTimeout(() => {
          const before2 = this.wanted();
          this.#lingering.delete(key);
          this.changed(before2);
        }, this.deps.graceMs ?? WIDGET_GRACE_MS),
      );
    };
  }

  /** 모두 닫는다 */
  close(): void {
    if (this.#timer !== undefined) this.deps.timers.clearTimeout(this.#timer);
    if (this.#hiddenTimer !== undefined) this.deps.timers.clearTimeout(this.#hiddenTimer);
    for (const t of this.#lingering.values()) this.deps.timers.clearTimeout(t);
    this.#lingering.clear();
    this.#timer = undefined;
    this.#hiddenTimer = undefined;
    this.#paused = false;
    this.#stream?.stop();
    this.#stream = undefined;
    this.#openKeys = [];
  }

  private wanted(): string[] {
    return [...new Set([...this.#listeners.keys(), ...this.#lingering.keys()])].sort();
  }

  /** 목록이 바뀌었으면 묶어 다시 연다 */
  private changed(before: readonly string[]): void {
    const after = this.wanted();
    if (after.length === before.length && after.every((k, i) => k === before[i])) return;
    this.later();
  }

  private later(): void {
    if (this.#timer !== undefined) this.deps.timers.clearTimeout(this.#timer);
    this.#timer = this.deps.timers.setTimeout(() => {
      this.#timer = undefined;
      this.apply();
    }, this.deps.debounceMs ?? WIDGET_LIST_DEBOUNCE_MS);
  }

  private apply(): void {
    if (this.#timer !== undefined) {
      this.deps.timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const keys = this.#paused ? [] : this.wanted();
    const eventId = this.#eventId;
    if (!eventId || keys.length === 0) {
      this.#stream?.stop();
      this.#stream = undefined;
      this.#openKeys = [];
      return;
    }
    const sameKeys = keys.length === this.#openKeys.length && keys.every((k, i) => k === this.#openKeys[i]);
    if (this.#stream && sameKeys && this.#streamEvent === eventId) return;
    this.#openKeys = keys;
    this.#streamEvent = eventId;
    const url = widgetStreamUrl(this.deps.origin, eventId, keys);
    this.#stream?.stop();
    this.#stream = this.deps.createStream(
      () => url,
      (f) => this.dispatch(f),
    );
    this.reopenCount += 1;
    this.#stream.start();
  }

  /** 다시 보일 때 구독 중인 키마다 위젯 조회를 한 번 불러 넘긴다(흐름의 첫 값이 그 뒤에 덮는다) */
  private refillAll(): void {
    const refill = this.deps.refill;
    const eventId = this.#eventId;
    if (!refill || !eventId) return;
    for (const key of [...this.#listeners.keys()]) {
      refill(key, eventId).then(
        (value) => {
          if (this.#paused || this.#eventId !== eventId || value === undefined || value === null) return;
          const at = typeof (value as { at?: unknown }).at === 'string' ? (value as { at: string }).at : new Date((this.deps.now ?? Date.now)()).toISOString();
          this.deliver({ widgetKey: key, at, value });
        },
        () => undefined,
      );
    }
  }

  private deliver(m: WidgetValueMessage): void {
    for (const l of [...(this.#listeners.get(m.widgetKey) ?? [])]) {
      try {
        l(m);
      } catch {
        // 한 구독자의 오류가 다른 구독자를 막지 않는다
      }
    }
  }

  private dispatch(f: SseFrame): void {
    if (f.event !== 'widget') return;
    let m: WidgetValueMessage;
    try {
      m = JSON.parse(f.data) as WidgetValueMessage;
    } catch {
      return;
    }
    if (!m || typeof m.widgetKey !== 'string') return;
    this.deliver(m);
  }
}
