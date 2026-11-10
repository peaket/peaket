// 한 프로세스 합본(docs/verification.md §3.8 (가), BUILD_ORDER PRF-215, ADR-0262 결정 4). 같은 v1 코드의 서비스를 Node 프로세스 하나에 띄운다.
// - 켤 서비스는 PEAKET_BUNDLE_SERVICES(쉼표)로 고른다. 서비스 분리 비교의 갈래 스위치(wbs 2.12.5, BUILD_ORDER HOT-500)가 같은 값을 그대로 쓴다.
// - 서비스마다 환경 파일 PEAKET_BUNDLE_ENV_DIR/<서비스>.env를 읽어 프로세스 공통 값 위에 얹고, 그 서비스의 start({ env })에만 넘긴다(다른 서비스의 값은 섞이지 않는다).
//   process.env에는 공통 값(PEAKET_ENV·파드 이름·쿠버네티스·OTel·Node 설정)만 둔다. 파일이 PEAKET_ENV를 적거나 포트가 겹치면 시작하지 않는다.
// - 시험 도구다: PEAKET_ENV가 local·ci가 아니면 시작하지 않는다(운영에 배포하지 않는다, docs/verification.md §3.8).
// - 켜는 차례는 결제 → 구매 → 입장 제어 → 대기열이고(부르는 쪽보다 불리는 쪽이 먼저 선다), 닫는 차례는 그 반대다(입구부터 닫는다).
//   서비스 하나가 시작에 실패하면 이미 켠 서비스를 반대 차례로 닫고 그 오류를 다시 던진다.
// - 서비스 사이 호출은 v1과 같은 gRPC로 둔다(같은 프로세스 안 함수 호출로 바꾸지 않는다, docs/verification.md §3.8 '같게 두는 것').
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

/** 합본에 넣을 수 있는 서비스(ADR-0262 결정 4). 배열 차례가 켜는 차례다 */
export const BUNDLE_SERVICES = ['payment-svc', 'purchase-svc', 'admission-ctrl', 'queue-svc'] as const;
export type BundleService = (typeof BUNDLE_SERVICES)[number];

/** 합본을 시작할 수 있는 환경 */
export const BUNDLE_ENVS = ['local', 'ci'] as const;

/** 합본의 관리 포트 기본값(서비스 관리 포트와 같은 9464, 차트의 managementPort) */
export const DEFAULT_BUNDLE_MANAGEMENT_PORT = 9464;

/** 환경 파일 이름 규칙: 대문자·숫자·밑줄 */
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
/**
 * 서비스 환경 파일이 정하지 못하는 이름(프로세스 하나에 하나뿐이거나 합본·파드의 값). 파드 이름·네임스페이스·쿠버네티스 주소를 서비스마다 바꾸면
 * 같은 Lease 이름으로 리더가 둘 생기거나 다른 네임스페이스의 Lease를 잡을 수 있다(코드 리뷰 낮음)
 */
const RESERVED_KEYS = new Set(['PEAKET_ENV', 'PEAKET_BUNDLE_SERVICES', 'PEAKET_BUNDLE_ENV_DIR', 'HOSTNAME', 'PEAKET_POD', 'PEAKET_AZ', 'POD_NAMESPACE']);
/** 정하지 못하는 앞머리(OTel·Node·쿠버네티스는 프로세스에 하나다) */
const RESERVED_PREFIXES = ['KUBERNETES_', 'OTEL_', 'NODE_'];
/** 서비스 환경 파일에 꼭 있어야 하는 포트(없으면 공통 값의 관리 포트를 서비스가 함께 집어 겹친다) */
const REQUIRED_PORT_KEYS = ['PORT', 'PEAKET_MANAGEMENT_PORT'] as const;

export interface BundleConfig {
  env: (typeof BUNDLE_ENVS)[number];
  /** 켜는 차례로 맞춘 서비스 목록 */
  services: BundleService[];
  envDir: string;
  managementPort: number;
}

/**
 * 합본 설정을 읽는다. PEAKET_ENV가 local·ci가 아니거나(빈 값 포함), 서비스 목록이 비었거나 모르는 이름·겹친 이름이 있거나,
 * 환경 파일 폴더가 없거나, 관리 포트가 1~65535가 아니면 Error다(시작하지 않는다)
 */
export function loadBundleConfig(env: Record<string, string | undefined>): BundleConfig {
  const peaketEnv = env.PEAKET_ENV ?? '';
  if (!(BUNDLE_ENVS as readonly string[]).includes(peaketEnv)) throw new Error(`합본은 PEAKET_ENV ${BUNDLE_ENVS.join('·')}에서만 시작한다(지금 '${peaketEnv}'. 운영에 배포하지 않는 시험 도구다)`);
  const names = (env.PEAKET_BUNDLE_SERVICES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) throw new Error(`PEAKET_BUNDLE_SERVICES가 비었다(켤 서비스, 쉼표로: ${BUNDLE_SERVICES.join(',')})`);
  const seen = new Set<string>();
  for (const n of names) {
    if (!(BUNDLE_SERVICES as readonly string[]).includes(n)) throw new Error(`PEAKET_BUNDLE_SERVICES에 모르는 서비스가 있다: ${n}(넣을 수 있는 것: ${BUNDLE_SERVICES.join(',')})`);
    if (seen.has(n)) throw new Error(`PEAKET_BUNDLE_SERVICES에 같은 서비스가 두 번 있다: ${n}`);
    seen.add(n);
  }
  const envDir = env.PEAKET_BUNDLE_ENV_DIR?.trim();
  if (!envDir) throw new Error('PEAKET_BUNDLE_ENV_DIR가 없다(서비스별 환경 파일 <서비스>.env가 있는 폴더)');
  const managementPort = portOf('PEAKET_MANAGEMENT_PORT', env.PEAKET_MANAGEMENT_PORT, DEFAULT_BUNDLE_MANAGEMENT_PORT);
  return { env: peaketEnv as BundleConfig['env'], services: BUNDLE_SERVICES.filter((s) => seen.has(s)), envDir, managementPort };
}

function portOf(name: string, raw: string | undefined, fallback?: number): number {
  if (raw === undefined || raw.trim() === '') {
    if (fallback === undefined) throw new Error(`${name}가 없다`);
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65_535 || !/^[0-9]+$/.test(raw.trim())) throw new Error(`${name}는 1~65535의 정수여야 한다`);
  return n;
}

/**
 * 환경 파일 하나를 읽는다: 한 줄에 KEY=값, 빈 줄과 #로 시작하는 줄은 건너뛴다. 값은 = 뒤 그대로다(따옴표·이스케이프를 풀지 않는다. JSON 값을 한 줄로 넣는다).
 * 이름이 규칙에 맞지 않거나, 같은 이름이 두 번이거나, =가 없는 줄은 Error다. 오류 글에는 줄 번호와 이름만 싣고 값은 싣지 않는다(비밀이 있다)
 */
export function parseEnvFile(text: string, file = '환경 파일'): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  lines.forEach((line, i) => {
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    const at = line.indexOf('=');
    if (at <= 0) throw new Error(`${file} ${i + 1}째 줄에 KEY=값 꼴이 아니다`);
    const key = line.slice(0, at).trim();
    if (!ENV_KEY.test(key)) throw new Error(`${file} ${i + 1}째 줄의 이름이 대문자·숫자·밑줄이 아니다`);
    if (Object.hasOwn(out, key)) throw new Error(`${file}에 ${key}가 두 번 있다`);
    out[key] = line.slice(at + 1);
  });
  return out;
}

/**
 * 한 서비스에 넘길 환경 값: 프로세스 공통 값 위에 그 서비스 파일의 값을 얹는다. 파일이 정하지 못하는 이름(PEAKET_ENV 등)이 있거나
 * PORT·PEAKET_MANAGEMENT_PORT가 빠졌으면 Error다
 */
export function serviceEnv(service: BundleService, common: Record<string, string | undefined>, file: Record<string, string>): Record<string, string | undefined> {
  for (const key of Object.keys(file)) if (RESERVED_KEYS.has(key) || RESERVED_PREFIXES.some((x) => key.startsWith(x))) throw new Error(`${service}.env에 ${key}를 적지 않는다(프로세스 공통 값이다)`);
  for (const key of REQUIRED_PORT_KEYS) if (!file[key]) throw new Error(`${service}.env에 ${key}가 없다(서비스마다 다른 포트를 준다)`);
  return { ...common, ...file };
}

/** 업무 gRPC 포트를 여는 서비스와 그 기본값(파일에 없을 때 서비스가 여는 포트. payment-svc·queue-svc 모두 50051이라 둘 다 빠지면 겹침으로 잡는다) */
const GRPC_DEFAULT_PORTS: Partial<Record<BundleService, number>> = { 'payment-svc': 50_051, 'queue-svc': 50_051 };

/** 서비스마다 쓰는 포트 이름(앱·관리, payment-svc·queue-svc는 업무 gRPC도) */
export function portsOf(service: BundleService, env: Record<string, string | undefined>): { name: string; port: number }[] {
  const out = (['PORT', 'PEAKET_MANAGEMENT_PORT'] as const)
    .filter((k) => env[k] !== undefined && env[k] !== '')
    .map((k) => ({ name: `${service} ${k}`, port: portOf(`${service}.env의 ${k}`, env[k]) }));
  const grpcDefault = GRPC_DEFAULT_PORTS[service];
  if (grpcDefault !== undefined) {
    const v = env.PEAKET_GRPC_PORT;
    out.push({ name: `${service} PEAKET_GRPC_PORT`, port: v === undefined || v === '' ? grpcDefault : portOf(`${service}.env의 PEAKET_GRPC_PORT`, v) });
  }
  return out;
}

/** 포트 겹침 검사: 합본 관리 포트와 서비스들의 포트가 모두 달라야 한다(겹치면 그 둘의 이름을 싣고 Error) */
export function assertDistinctPorts(managementPort: number, perService: { name: string; port: number }[]): void {
  const used = new Map<number, string>([[managementPort, '합본 PEAKET_MANAGEMENT_PORT']]);
  for (const p of perService) {
    const other = used.get(p.port);
    if (other) throw new Error(`포트 ${p.port}가 겹친다: ${other}와 ${p.name}`);
    used.set(p.port, p.name);
  }
}

export interface ServiceStartOptions {
  env: Record<string, string | undefined>;
  logDestination?: Writable;
  onFatal?: (err: unknown) => void;
}
export type ServiceStarter = (o: ServiceStartOptions) => Promise<{ close(): Promise<void> }>;

/** 운영 시작 파일과 같은 start()를 그 서비스가 켜질 때만 싣는다(고르지 않은 서비스의 코드는 읽지 않는다) */
export const SERVICE_STARTERS: Record<BundleService, () => Promise<ServiceStarter>> = {
  'payment-svc': async () => (await import('@peaket/payment-svc/start')).start,
  'purchase-svc': async () => (await import('@peaket/purchase-svc/start')).start,
  'admission-ctrl': async () => (await import('@peaket/admission-ctrl/start')).start,
  'queue-svc': async () => (await import('@peaket/queue-svc/start')).start,
};

export interface StartBundleOptions {
  config: BundleConfig;
  /** 프로세스 공통 환경 값(기본 process.env) */
  common?: Record<string, string | undefined>;
  /** 서비스 시작 함수(기본 SERVICE_STARTERS. 시험이 대역으로 바꾼다) */
  starters?: Partial<Record<BundleService, () => Promise<ServiceStarter>>>;
  /** 환경 파일 읽기(기본 파일 시스템) */
  readEnvFile?: (path: string) => Promise<string>;
  logDestination?: Writable;
  /** 듣기 시작한 뒤 서비스 하나가 치명적으로 실패했다(합본은 모두 닫기 시작했다). 시작 파일은 종료 코드 1을 둔다 */
  onFatal?: (service: BundleService, err: unknown) => void;
  /** 닫기 신호(시작 파일의 SIGTERM). 켜는 중에 오면 켠 것을 반대 차례로 닫고 뒤 서비스는 켜지 않은 채 던진다(코드 리뷰 낮음) */
  stop?: AbortSignal;
  /** 진행 기록(기본 없음) */
  log?: (event: { service: BundleService; step: 'starting' | 'started' | 'closing' | 'closed' | 'close-failed'; err?: unknown }) => void;
}

export interface RunningBundle {
  /** 켠 차례의 서비스와 그 관리 포트(합본 관리 포트의 /ready·/metrics가 모은다) */
  services: { service: BundleService; managementPort: number }[];
  /** 반대 차례로 하나씩 닫는다. 여러 번 불러도 한 번만 닫는다. 서비스 하나가 닫기에 실패해도 나머지를 닫는다 */
  close(): Promise<void>;
}

/** 서비스 환경 파일을 모두 먼저 읽고 검사한 뒤(포트 겹침 포함) 켠다 */
export async function startBundle(o: StartBundleOptions): Promise<RunningBundle> {
  const common = o.common ?? process.env;
  const read = o.readEnvFile ?? ((p: string) => readFile(p, 'utf8'));
  const plans: { service: BundleService; env: Record<string, string | undefined> }[] = [];
  for (const service of o.config.services) {
    const file = join(o.config.envDir, `${service}.env`);
    const env = serviceEnv(service, common, parseEnvFile(await read(file), `${service}.env`));
    plans.push({ service, env });
  }
  assertDistinctPorts(o.config.managementPort, plans.flatMap((p) => portsOf(p.service, p.env)));

  /** 켰고 아직 닫지 않은 서비스(켠 차례). 닫기는 끝에서부터 꺼낸다 */
  const open: { service: BundleService; managementPort: number; close(): Promise<void> }[] = [];
  const all: { service: BundleService; managementPort: number }[] = [];
  let closing: Promise<void> | undefined;
  const closeOne = async (s: (typeof open)[number]): Promise<void> => {
    o.log?.({ service: s.service, step: 'closing' });
    try {
      await s.close();
      o.log?.({ service: s.service, step: 'closed' });
    } catch (err) {
      o.log?.({ service: s.service, step: 'close-failed', err });
    }
  };
  const close = (): Promise<void> => {
    closing ??= (async () => {
      for (let s = open.pop(); s; s = open.pop()) await closeOne(s);
    })();
    return closing;
  };
  const stopped = (service: BundleService, what: string) => new Error(`합본을 닫는 중이라 ${service}를 ${what}(앞 서비스가 실패했다)`);
  const signalled = (service: BundleService) => new Error(`닫기 신호를 받아 ${service}를 켜지 않았다`);
  for (const p of plans) {
    if (o.stop?.aborted) {
      await close();
      throw signalled(p.service);
    }
    const loader = o.starters?.[p.service] ?? SERVICE_STARTERS[p.service];
    o.log?.({ service: p.service, step: 'starting' });
    let running: { close(): Promise<void> };
    try {
      const start = await loader();
      // 코드를 싣는 사이에 앞 서비스가 치명적으로 실패해 닫기가 시작됐거나 닫기 신호가 왔으면 더 켜지 않는다
      if (closing) throw stopped(p.service, '켜지 않았다');
      if (o.stop?.aborted) throw signalled(p.service);
      running = await start({
        env: p.env,
        ...(o.logDestination ? { logDestination: o.logDestination } : {}),
        onFatal: (err) => {
          void close();
          o.onFatal?.(p.service, err);
        },
      });
    } catch (err) {
      await close();
      throw err;
    }
    const entry = { service: p.service, managementPort: Number(p.env.PEAKET_MANAGEMENT_PORT), close: () => running.close() };
    all.push({ service: entry.service, managementPort: entry.managementPort });
    if (closing) {
      // 이 서비스가 뜨는 동안 닫기가 시작됐다(앞 서비스의 치명적 실패): 이 서비스도 닫고 멈춘다
      await closing;
      await closeOne(entry);
      throw stopped(p.service, '바로 닫았다');
    }
    open.push(entry);
    o.log?.({ service: p.service, step: 'started' });
    if (o.stop?.aborted) {
      await close();
      throw signalled(p.service);
    }
  }
  return { services: all, close };
}
