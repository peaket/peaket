// 위젯 값(ADR-0100 결정 4, docs/frontend.md §4.4.5, ADR-0360 결정 9). 파드마다 (회차, 위젯 키)별로 1초 [가정]에 한 번만 원천을 읽어
// 그 파드의 연결에 나눠 준다(같은 위젯 키를 연결 여럿이 봐도 원천 읽기는 하나다). 마지막 구독이 떠나면 그 (회차, 키)의 읽기를 멈춘다.
// 원천이 실패하면 같은 키에 error 'source-unavailable' 값을 낸다(화면은 '받지 못함'을 그린다).
// 읽기 주기(타이머·첫 읽기)는 첫 구독을 한 SSE 요청의 맥락 밖에서 돈다: 그 요청의 남은 시간(서비스 상한 15초)을 물려받으면 15초 뒤
// 모든 원천 호출이 보내기 전에 끝나 흐름이 늘 source-unavailable이 된다(F-03-1 B-01). 원천 읽기마다 원천 클라이언트가 자기 상한으로 남은 시간을 새로 잡는다.
import { AsyncLocalStorage } from 'node:async_hooks';
import { WIDGET_MAX_RANGE_MS, WIDGET_RANGE_MS, WIDGET_SOURCE_OF, WIDGET_TICK_MS, type WidgetKey, type WidgetValue } from '../domain/widgets.js';
import type { WidgetReadQuery, WidgetSource } from '../domain/ports.js';

export type WidgetListener = (v: { widgetKey: WidgetKey; atMs: number; value: WidgetValue }) => void;

interface Slot {
  readonly eventId: string | null;
  readonly key: WidgetKey;
  readonly listeners: Set<WidgetListener>;
  timer: NodeJS.Timeout;
  reading: boolean;
  last?: { atMs: number; value: WidgetValue };
}

export interface WidgetFeedOptions {
  readonly tickMs?: number;
  readonly now?: () => number;
}

/** 원천 실패 값 */
export function unavailableValue(key: WidgetKey, eventId: string | null, atMs: number): WidgetValue {
  return { widgetKey: key, source: WIDGET_SOURCE_OF[key], at: new Date(atMs).toISOString(), eventId, error: 'source-unavailable' };
}

export class WidgetFeed {
  readonly #sources = new Map<WidgetKey, WidgetSource>();
  readonly #slots = new Map<string, Slot>();
  /** 만든 때(모듈 조립, 요청 밖)의 비동기 맥락에서 함수를 부른다. 읽기 주기가 첫 구독 요청의 맥락(남은 시간·trace)을 물려받지 않게 한다 */
  readonly #detached = AsyncLocalStorage.snapshot();

  constructor(
    sources: readonly WidgetSource[],
    private readonly options: WidgetFeedOptions = {},
  ) {
    for (const s of sources) {
      for (const k of s.keys) {
        if (this.#sources.has(k)) throw new Error(`위젯 키 ${k}를 두 원천이 맡는다`);
        this.#sources.set(k, s);
      }
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** 이 파드가 값을 낼 수 있는 키인가(원천이 붙은 키) */
  has(key: WidgetKey): boolean {
    return this.#sources.has(key);
  }

  /** 위젯 조회(REST): 지금 값과 창의 점. 원천이 없거나 실패하면 source-unavailable */
  async read(key: WidgetKey, q: { eventId: string | null; fromMs?: number; toMs?: number }): Promise<WidgetValue> {
    const nowMs = this.now();
    const toMs = q.toMs ?? nowMs;
    // 창은 1시간 [가정]을 넘지 않는다(알림 표 보관과 같은 길이, 더 긴 지난 값은 Grafana)
    const fromMs = Math.max(q.fromMs ?? toMs - WIDGET_RANGE_MS, toMs - WIDGET_MAX_RANGE_MS);
    return this.readOnce(key, { eventId: q.eventId, nowMs, range: { fromMs, toMs } });
  }

  private async readOnce(key: WidgetKey, q: WidgetReadQuery): Promise<WidgetValue> {
    const source = this.#sources.get(key);
    if (!source) return unavailableValue(key, q.eventId, q.nowMs);
    try {
      return await source.read(key, q);
    } catch {
      return unavailableValue(key, q.eventId, q.nowMs);
    }
  }

  /** (회차, 키)를 구독한다. 이미 계산한 값이 있으면 바로 한 번 준다. 돌려준 함수로 끊는다 */
  subscribe(eventId: string | null, key: WidgetKey, listener: WidgetListener): () => void {
    const id = `${eventId ?? ''}|${key}`;
    let slot = this.#slots.get(id);
    if (!slot) {
      const created = this.#detached(() => {
        const c: Slot = { eventId, key, listeners: new Set(), reading: false, timer: setInterval(() => void this.tick(c), this.options.tickMs ?? WIDGET_TICK_MS) };
        c.timer.unref();
        void this.tick(c);
        return c;
      });
      this.#slots.set(id, created);
      slot = created;
    } else if (slot.last) {
      listener({ widgetKey: key, ...slot.last });
    }
    slot.listeners.add(listener);
    const s = slot;
    return () => {
      s.listeners.delete(listener);
      if (s.listeners.size === 0) {
        clearInterval(s.timer);
        this.#slots.delete(id);
      }
    };
  }

  private async tick(slot: Slot): Promise<void> {
    if (slot.reading) return;
    slot.reading = true;
    try {
      const atMs = this.now();
      const value = await this.readOnce(slot.key, { eventId: slot.eventId, nowMs: atMs });
      slot.last = { atMs, value };
      for (const l of [...slot.listeners]) l({ widgetKey: slot.key, atMs, value });
    } finally {
      slot.reading = false;
    }
  }

  /** 지금 도는 (회차, 키) 수(시험·지표) */
  get activeSlots(): number {
    return this.#slots.size;
  }
}
