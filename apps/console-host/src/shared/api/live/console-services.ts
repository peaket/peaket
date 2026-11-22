// 원격 위젯에 넘기는 통로(ConsoleServices, docs/frontend.md §4.5, ADR-0100 결정 6, ADR-0360, ADR-0361 결정 9). 위젯 자리마다 하나 만든다.
// data.query는 REST 위젯 조회, data.subscribe는 위젯 흐름(같은 키는 한 흐름을 나눠 씀), live.on은 늘 여는 흐름의 사건이다.
// host는 읽기 전용(HostView)이고, 원격은 호스트 저장소를 바꾸지 못한다. 의존은 넘겨받는다(호스트 저장소·흐름은 connection.ts가 잇는다).
// 자리 문(gate): 흐름 값은 자리마다 250ms [가정]에 한 번(처음 값은 바로, 그 사이 값은 마지막 것만) 넘기고(§5.7 '신선도' latestEvery),
// 자리가 화면 밖이면(setOnScreen(false)) 넘기지 않고 마지막 값만 들고 있다가 다시 보이면 한 번 넘긴다(§4.5, IntersectionObserver는 호스트 자리가 본다).
// 구독은 화면 밖이어도 그대로다(위젯마다 초당 1건 안팎, ADR-0091 결정 3).
import type { ConsoleServices, HostView, MessageKey, Permission, Unsubscribe, WidgetKey } from '@peaket/console-contract';

/** 위젯 그리기 묶음 250ms [가정](frontend §5.7·§5.8 관제 '위젯 그리기 묶음') */
export const WIDGET_RENDER_BATCH_MS = 250;

export interface ConsoleServicesDeps {
  /** 위젯 자리 이름(계측·오류 이름) */
  slot: string;
  /** REST 위젯 조회 */
  query(key: string, vars: { eventId?: string | null; from?: string; to?: string }): Promise<unknown>;
  /** 위젯 흐름 구독(value만 넘긴다) */
  subscribe(key: string, next: (value: unknown, at: string) => void): Unsubscribe;
  /** 늘 여는 흐름 사건 */
  on(event: 'alert' | 'command' | 'presence', h: (p: unknown) => void): Unsubscribe;
  host: { get(): HostView; subscribe(listener: (s: HostView) => void): Unsubscribe; use<T>(f: (s: HostView) => T): T };
  /** 권한(지금은 관제 읽기 ops:read만 있다) */
  permissions: readonly string[];
  /** 자리 문의 시계(없으면 전역 setTimeout) */
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  batchMs?: number;
  mark?(name: string, ms: number): void;
  error?(e: unknown): void;
}

/** 자리 하나: 원격에 넘길 통로와 호스트만 쥐는 손잡이(화면 안·밖, 버리기) */
export interface SlotServices {
  services: ConsoleServices;
  /** 자리가 화면 안인가(거짓이면 값을 들고만 있는다) */
  setOnScreen(on: boolean): void;
  /** 자리를 버린다(문의 타이머를 지운다. 구독은 위젯이 정리 함수에서 닫는다) */
  dispose(): void;
}

interface Gate {
  setOnScreen(on: boolean): void;
  stop(): void;
}

export function createSlotServices(d: ConsoleServicesDeps): SlotServices {
  const timers = d.timers ?? {
    setTimeout: (fn: () => void, ms: number): unknown => globalThis.setTimeout(fn, ms),
    clearTimeout: (h: unknown): void => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const batchMs = d.batchMs ?? WIDGET_RENDER_BATCH_MS;
  const gates = new Set<Gate>();
  let onScreen = true;

  /** 구독 하나의 문: 처음 값은 바로, 그 뒤 250ms 안의 값은 마지막 것만 창이 닫힐 때 넘긴다 */
  function gate<T>(next: (v: T) => void): Gate & { push(v: T): void } {
    let last: T | undefined;
    let pending = false;
    let cooling = false;
    let timer: unknown;
    const flush = () => {
      if (!pending) return;
      pending = false;
      const v = last as T;
      cooling = true;
      timer = timers.setTimeout(() => {
        timer = undefined;
        cooling = false;
        if (pending && onScreen) flush();
      }, batchMs);
      try {
        next(v);
      } catch (e) {
        d.error?.(e);
      }
    };
    return {
      push(v: T) {
        last = v;
        pending = true;
        if (onScreen && !cooling) flush();
      },
      setOnScreen(on: boolean) {
        if (on && pending && !cooling) flush();
      },
      stop() {
        if (timer !== undefined) timers.clearTimeout(timer);
        timer = undefined;
        pending = false;
      },
    };
  }

  const services: ConsoleServices = {
    data: {
      query<T>(key: WidgetKey, vars?: object): Promise<T> {
        return d.query(key, (vars ?? {}) as { eventId?: string | null; from?: string; to?: string }) as Promise<T>;
      },
      subscribe<T>(key: WidgetKey, _vars: object, next: (v: T) => void): Unsubscribe {
        const g = gate<T>(next);
        gates.add(g);
        const stop = d.subscribe(key, (value) => g.push(value as T));
        return () => {
          gates.delete(g);
          g.stop();
          stop();
        };
      },
    },
    live: { on: (event, h) => d.on(event, h) },
    host: { use: (f) => d.host.use(f), get: () => d.host.get(), subscribe: (l) => d.host.subscribe(l) },
    telemetry: {
      mark: (name, ms) => d.mark?.(`${d.slot}:${name}`, ms),
      error: (e) => d.error?.(e),
    },
    i18n: { t: (key: MessageKey) => String(key) },
    can: (permission: Permission) => d.permissions.includes(permission),
    flags: { isOn: () => false },
  };
  return {
    services,
    setOnScreen(on: boolean) {
      if (on === onScreen) return;
      onScreen = on;
      for (const g of [...gates]) g.setOnScreen(on);
    },
    dispose() {
      for (const g of gates) g.stop();
      gates.clear();
    },
  };
}

export function createConsoleServices(d: ConsoleServicesDeps): ConsoleServices {
  return createSlotServices(d).services;
}
