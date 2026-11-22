// 원격 위젯에 넘기는 통로(ConsoleServices, docs/frontend.md §4.5, ADR-0100 결정 6, ADR-0360). 위젯 자리마다 하나 만든다.
// data.query는 REST 위젯 조회, data.subscribe는 위젯 흐름(같은 키는 한 흐름을 나눠 씀), live.on은 늘 여는 흐름의 사건이다.
// host는 읽기 전용(HostView)이고, 원격은 호스트 저장소를 바꾸지 못한다. 의존은 넘겨받는다(호스트 저장소·흐름은 connection.ts가 잇는다).
import type { ConsoleServices, HostView, MessageKey, Permission, Unsubscribe, WidgetKey } from '@peaket/console-contract';

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
  mark?(name: string, ms: number): void;
  error?(e: unknown): void;
}

export function createConsoleServices(d: ConsoleServicesDeps): ConsoleServices {
  return {
    data: {
      query<T>(key: WidgetKey, vars?: object): Promise<T> {
        return d.query(key, (vars ?? {}) as { eventId?: string | null; from?: string; to?: string }) as Promise<T>;
      },
      subscribe<T>(key: WidgetKey, _vars: object, next: (v: T) => void): Unsubscribe {
        return d.subscribe(key, (value) => next(value as T));
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
}
