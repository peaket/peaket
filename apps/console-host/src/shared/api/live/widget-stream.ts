// 위젯 흐름 관리(docs/frontend.md §4.4.5, ADR-0100 결정 2 '보이지 않는 위젯', ADR-0360).
// 호스트가 보이는 위젯 키를 모은다. 같은 위젯 키는 흐름 하나로 받아 구독자 모두에게 나눠 준다.
// 목록이 바뀌면 1초 [가정] 묶어 위젯 흐름만 새 widgets로 다시 연다(늘 여는 흐름은 건드리지 않는다). 목록이 비면 닫는다.
// 회차를 바꾸면 묶지 않고 바로 다시 연다. 안 보이는 위젯의 10초 유예·숨긴 탭 30초는 F-03-2(OPS-360)가 더한다.
// 흐름 만들기는 넘겨받는다(ManagedStream). 가져오는 값이 없는 순수 모듈이라 Node 내장 시험 실행기로 그대로 읽는다.
import type { SseFrame, StreamTimers } from './live-stream';

/** 목록 바뀜을 묶는 시간 1초 [가정] */
export const WIDGET_LIST_DEBOUNCE_MS = 1_000;

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
  debounceMs?: number;
}

/** 위젯 흐름 주소: 키는 정렬해 같은 목록이면 같은 주소다 */
export function widgetStreamUrl(origin: string, eventId: string, keys: readonly string[]): string {
  const widgets = [...new Set(keys)].sort().join(',');
  return `${origin.replace(/\/+$/, '')}/v1/ops/events/${encodeURIComponent(eventId)}/live?widgets=${encodeURIComponent(widgets)}`;
}

export class WidgetStreams {
  readonly #listeners = new Map<string, Set<(m: WidgetValueMessage) => void>>();
  #eventId: string | null = null;
  /** 지금 연 흐름의 키 목록(정렬) */
  #openKeys: string[] = [];
  #stream: StreamHandle | undefined;
  #timer: unknown;
  /** 다시 연 횟수(시험·지표) */
  reopenCount = 0;

  constructor(private readonly deps: WidgetStreamsDeps) {}

  /** 지금 연 흐름의 키(정렬) */
  get openKeys(): readonly string[] {
    return this.#openKeys;
  }

  get eventId(): string | null {
    return this.#eventId;
  }

  /** 회차를 바꾼다. 바뀌면 묶지 않고 바로 다시 연다 */
  setEvent(eventId: string | null): void {
    if (eventId === this.#eventId) return;
    this.#eventId = eventId;
    this.apply();
  }

  /** 위젯 키를 구독한다(위젯 자리가 보일 때). 돌려준 함수로 끊는다 */
  subscribe(key: string, next: (m: WidgetValueMessage) => void): () => void {
    let set = this.#listeners.get(key);
    if (!set) {
      set = new Set();
      this.#listeners.set(key, set);
    }
    set.add(next);
    this.later();
    return () => {
      const s = this.#listeners.get(key);
      if (!s) return;
      s.delete(next);
      if (s.size === 0) this.#listeners.delete(key);
      this.later();
    };
  }

  /** 모두 닫는다 */
  close(): void {
    if (this.#timer !== undefined) this.deps.timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#stream?.stop();
    this.#stream = undefined;
    this.#openKeys = [];
  }

  private wanted(): string[] {
    return [...this.#listeners.keys()].sort();
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
    const keys = this.wanted();
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

  #streamEvent: string | null = null;

  private dispatch(f: SseFrame): void {
    if (f.event !== 'widget') return;
    let m: WidgetValueMessage;
    try {
      m = JSON.parse(f.data) as WidgetValueMessage;
    } catch {
      return;
    }
    if (!m || typeof m.widgetKey !== 'string') return;
    for (const l of [...(this.#listeners.get(m.widgetKey) ?? [])]) l(m);
  }
}
