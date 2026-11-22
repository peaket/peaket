// @peaket/console-contract — 관제 원격 위젯 계약(docs/frontend.md §4.5, ADR-0079 결정 16, ADR-0092 결정 3, ADR-0100).
// 원격 위젯과 호스트가 함께 쓰는 형식과 작은 확인 함수만 둔다. 원격 무결성(sha384)·대체 카드·remotes.json·빌드 워크플로는 OPS-350에서 더한다.
// 원격은 이 패키지와 공유 싱글턴만 가져온다(frontend §2.2 '원격 위젯').
import type { ComponentType } from 'react';

/** 계약 주판. 위젯 정보의 contractMajor가 이것과 다르면 호스트가 싣지 않는다 */
export const CONTRACT_MAJOR = 1 as const;

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };
/** 문구 키(§5.12) */
export type MessageKey = Brand<string, 'MessageKey'>;
/** 권한(예: ops:read, docs/planning/03 §3) */
export type Permission = Brand<string, 'Permission'>;
/** 위젯 조회·흐름 키(§4.4.5) */
export type WidgetKey = Brand<string, 'WidgetKey'>;
export type Unsubscribe = () => void;
export interface DetailLink {
  href: string;
  label: MessageKey;
}

/** 경보 한 건(asyncapi OpsAlert의 화면 몫, frontend §3.10 alerts) */
export interface HostAlert {
  alertId: string;
  status: 'firing' | 'resolved';
  severity: 'SEV1' | 'SEV2' | 'SEV3';
  title: string;
  kind: string;
  startsAt: string;
  endsAt?: string;
  eventId?: string;
}

/** 접속 중 운영자 한 명(asyncapi OpsPresence operators의 항목) */
export interface HostOperator {
  accountRef: string;
  role: string;
  screen: string;
}

/**
 * 원격이 읽을 수 있는 호스트 상태(§3.10, OPS-340에서 칸을 정함, ADR-0360). session·commands는 넘기지 않는다.
 * control·autoActions는 원천 기능(F-02-1 자동 제어, F-03-4 자동 조치)이 늘 여는 흐름의 control·autoAction 사건으로 채운다. 그 전에는 비어 있다
 */
export interface HostState {
  scope: { eventId: string | null; stage?: string; tab?: string; timeRange?: { from: string; to: string } };
  /** 자동 제어 다섯 값(정상·일시정지·자동 증액 멈춤·입력 없음·긴급 정지)과 우선순위. 모르면 kind 'unknown' */
  control: { kind: 'ok' | 'paused' | 'raise-stopped' | 'no-input' | 'emergency-stop' | 'unknown'; updatedAt?: string };
  /** 걸린 자동 조치(이름·대상·상태·시작 시각). 본문 모양은 원천 기능이 정한다 */
  autoActions: readonly { name: string; target?: string; state: string; startedAt?: string }[];
  /** 걸린 경보와 풀린 지 60분 [가정] 안의 경보(500건 [가정]까지) */
  alerts: readonly HostAlert[];
  /** 고른 회차의 접속 운영자 */
  presence: readonly HostOperator[];
}
export type HostView = Readonly<Pick<HostState, 'scope' | 'control' | 'autoActions' | 'alerts' | 'presence'>>;

/** 원격이 쓰는 유일한 바깥 통로(통신은 REST·SSE, ADR-0100) */
export interface ConsoleServices {
  data: {
    query<T>(key: WidgetKey, vars?: object): Promise<T>;
    subscribe<T>(key: WidgetKey, vars: object, next: (v: T) => void): Unsubscribe;
  };
  live: { on(event: 'alert' | 'command' | 'presence', h: (p: unknown) => void): Unsubscribe };
  host: { use<T>(f: (s: HostView) => T): T; get(): HostView; subscribe(listener: (s: HostView) => void): Unsubscribe };
  telemetry: { mark(name: string, ms: number): void; error(e: unknown): void };
  i18n: { t(key: MessageKey, vars?: object): string };
  can(permission: Permission): boolean;
  flags: { isOn(name: string): boolean };
}

/** 호스트가 위젯에 넘기는 속성 */
export interface WidgetProps {
  eventId: string | null;
  timeRange: { from: string; to: string };
  density: 'comfortable' | 'dense';
  /** 참이면 머리(제목·상태 점·핵심 숫자 한 줄)만 그린다(ADR-0091) */
  collapsed: boolean;
  services: ConsoleServices;
  onOpenDetail(link: DetailLink): void;
  onStatus(s: { freshnessMs: number; source: 'rt' | 'prometheus'; error?: MessageKey }): void;
}

/** 원격이 내보내는 위젯 정보 */
export interface WidgetManifest {
  name: string;
  contractMajor: typeof CONTRACT_MAJOR;
  title: MessageKey;
  permissions: Permission[];
  refresh: 'subscription' | { pollMs: number };
  load: () => Promise<{ default: ComponentType<WidgetProps> }>;
}

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** 위젯 정보를 정의할 때 모양을 본다(틀리면 원격 빌드에서 바로 멈춘다) */
export function defineWidget(m: WidgetManifest): WidgetManifest {
  if (!NAME.test(m.name)) throw new TypeError(`위젯 이름은 케밥 표기여야 한다: ${m.name}`);
  if (m.permissions.length === 0) throw new TypeError(`위젯 권한이 비었다: ${m.name}`);
  if (typeof m.refresh === 'object' && !(Number.isInteger(m.refresh.pollMs) && m.refresh.pollMs > 0)) {
    throw new TypeError(`refresh.pollMs는 양의 정수여야 한다: ${m.name}`);
  }
  return m;
}

/** 호스트가 실을 수 있는 위젯인가(계약 주판이 같은가) */
export function isLoadable(m: Pick<WidgetManifest, 'contractMajor'>): boolean {
  return m.contractMajor === CONTRACT_MAJOR;
}
