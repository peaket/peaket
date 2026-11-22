// @peaket/console-contract — 관제 원격 위젯 계약(docs/frontend.md §4.5, ADR-0079 결정 16, ADR-0092 결정 3, ADR-0100).
// 원격 위젯과 호스트가 함께 쓰는 형식과 작은 확인 함수만 둔다. 원격 목록(remotes.json) 한 항목의 형식·검사와 실패 까닭 이름도 여기 있다(OPS-350, ADR-0361).
// 원격은 이 패키지와 공유 싱글턴만 가져온다(frontend §2.2 '원격 위젯'). 이 패키지는 공유 싱글턴이고 판(package.json version)의 큰 수가 CONTRACT_MAJOR와 같다
// (호스트·원격 빌드가 strictVersion으로 맞춘다, ADR-0361 결정 7).
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
  /**
   * 호스트가 접기를 맡을 때 준다(선택, 판 1 안에서 더함). 위젯 머리의 [접기]·접힌 줄 누르기가 바뀐 값을 알리고, 호스트가 collapsed를 바꿔 다시 넘긴다
   * (접힘은 호스트가 이 브라우저에만 남긴다, ADR-0361 결정 8)
   */
  onCollapsedChange?(collapsed: boolean): void;
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

/** 원격 목록(같은 출처 /remotes.json, docs/frontend.md §4.5) 한 항목. 호스트는 이 항목의 정식 주소·무결성 값으로만 원격을 싣는다 */
export interface RemoteListEntry {
  /** 원격 이름(호스트가 아는 이름, 예: queue) */
  name: string;
  /** 원격을 빌드한 커밋 SHA 앞부분(소문자 16진 7~40자) */
  sha: string;
  /** 진입 파일 주소. 정확히 remoteEntryPath(name, sha)여야 한다 */
  entry: string;
  /** 진입 파일의 SRI 값(sha384-<base64 64자>) */
  integrity: string;
  /** 원격이 쓰는 계약 판. 호스트의 CONTRACT_MAJOR와 다르면 받지 않는다 */
  contractMajor: number;
}

/** 원격 싣기가 실패한 까닭(remote_load_failed_total의 reason 라벨, docs/frontend.md §5.16) */
export type RemoteLoadFailReason = 'list' | 'contract' | 'policy' | 'integrity' | 'network' | 'timeout' | 'container';
export const REMOTE_LOAD_FAIL_REASONS: readonly RemoteLoadFailReason[] = ['list', 'contract', 'policy', 'integrity', 'network', 'timeout', 'container'];

const REMOTE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REMOTE_SHA = /^[0-9a-f]{7,40}$/;
/** sha384 48바이트의 base64는 채움 없이 64자다 */
const SRI_SHA384 = /^sha384-[A-Za-z0-9+/]{64}$/;

/** 원격 진입 파일의 정식 주소(같은 출처 경로). 이름·sha 꼴이 틀리면 던진다 */
export function remoteEntryPath(name: string, sha: string): string {
  if (!REMOTE_NAME.test(name)) throw new TypeError(`원격 이름 꼴이 아니다: ${name}`);
  if (!REMOTE_SHA.test(sha)) throw new TypeError(`원격 sha 꼴이 아니다: ${sha}`);
  return `/remotes/${name}/${sha}/remoteEntry.js`;
}

/**
 * 원격 목록을 검사한다. 틀린 항목은 그 항목만 거절하고(why에 까닭) 나머지는 돌려준다. 같은 이름이 둘 이상이면 그 이름 모두를 거절한다.
 * known을 주면 그 밖의 이름도 거절한다(호스트가 아는 원격만 싣는다). 목록이 배열이 아니면 entries가 비고 rejected에 하나를 적는다
 */
export function parseRemoteList(json: unknown, o: { known?: readonly string[] } = {}): { entries: RemoteListEntry[]; rejected: { name?: string; why: string }[] } {
  const entries: RemoteListEntry[] = [];
  const rejected: { name?: string; why: string }[] = [];
  if (!Array.isArray(json)) return { entries, rejected: [{ why: '목록이 배열이 아니다' }] };
  const seen = new Map<string, number>();
  for (const item of json as unknown[]) {
    const n = item && typeof item === 'object' ? (item as { name?: unknown }).name : undefined;
    if (typeof n === 'string') seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  for (const item of json as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      rejected.push({ why: '항목이 객체가 아니다' });
      continue;
    }
    const e = item as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name : undefined;
    const why = entryProblem(e, o.known, name ? (seen.get(name) ?? 0) : 0);
    if (why) {
      rejected.push(name !== undefined ? { name, why } : { why });
      continue;
    }
    entries.push({ name: e.name as string, sha: e.sha as string, entry: e.entry as string, integrity: e.integrity as string, contractMajor: e.contractMajor as number });
  }
  return { entries, rejected };
}

function entryProblem(e: Record<string, unknown>, known: readonly string[] | undefined, count: number): string | undefined {
  const keys = Object.keys(e).sort().join(',');
  if (keys !== 'contractMajor,entry,integrity,name,sha') return `칸이 정해진 다섯과 다르다: ${keys}`;
  if (typeof e.name !== 'string' || !REMOTE_NAME.test(e.name)) return '이름 꼴이 아니다';
  if (known && !known.includes(e.name)) return '호스트가 모르는 원격이다';
  if (count > 1) return '같은 이름이 둘 이상이다';
  if (typeof e.sha !== 'string' || !REMOTE_SHA.test(e.sha)) return 'sha 꼴이 아니다(소문자 16진 7~40자)';
  if (typeof e.integrity !== 'string' || !SRI_SHA384.test(e.integrity)) return 'integrity가 sha384-<base64 64자>가 아니다';
  if (typeof e.contractMajor !== 'number' || !Number.isInteger(e.contractMajor) || e.contractMajor < 1) return 'contractMajor가 1 이상의 정수가 아니다';
  if (e.entry !== remoteEntryPath(e.name, e.sha)) return 'entry가 정식 주소(/remotes/<name>/<sha>/remoteEntry.js)와 다르다';
  return undefined;
}
