// payment-svc 설정 읽기(BUILD_ORDER PRF-180). 값은 docs/verification.md §4.1 'payment-svc 승인 명령 접수 쓰기와 결과 당기기 서버의 DB 연결'과 맞춘다.
import type { PortoneGatewayOptions } from './modules/payment/adapters/pg/portone-gateway.js';
import type { SimulatorGatewayOptions } from './modules/payment/adapters/pg/simulator-gateway.js';
import type { TossGatewayOptions } from './modules/payment/adapters/pg/toss-gateway.js';

/** 업무 gRPC 포트 [가정](identity-svc와 같다. BUILD_ORDER BAS-080이 공용 설정으로 옮긴다) */
export const DEFAULT_PAYMENT_GRPC_PORT = 50051;
/** 파드마다 핫패스 풀 연결 16개 [가정](ConfirmPayment) */
export const PAYMENT_HOT_POOL_MAX = 16;
/** 파드마다 일반 풀 연결 4개 [가정](BatchGetPayments, applicationName payment-svc-batch) */
export const PAYMENT_BATCH_POOL_MAX = 4;
/** local·ci에서 PEAKET_PAYMENT_POD_COUNT가 비었을 때의 파드 수 1개 [가정] */
export const DEFAULT_PAYMENT_POD_COUNT = 1;
/** PEAKET_PAYMENT_POD_COUNT의 상한 1000 [가정](값을 잘못 넣어 파드당 상한이 0에 가까워지는 일을 막는다) */
export const MAX_PAYMENT_POD_COUNT = 1_000;

/** 토스 공식 API 주소(PEAKET_PG_TOSS_URL의 기본값) */
export const DEFAULT_TOSS_API_URL = 'https://api.tosspayments.com';
/** 포트원 공식 API 주소(PEAKET_PG_PORTONE_URL의 기본값) */
export const DEFAULT_PORTONE_API_URL = 'https://api.portone.io';
const PORTONE_REQUIRED = ['PEAKET_PG_PORTONE_SECRET', 'PEAKET_PG_PORTONE_STORE_ID', 'PEAKET_PG_PORTONE_CHANNEL_KEY', 'PEAKET_PG_PORTONE_WEBHOOK_SECRET'] as const;
const TEST_ENVS: ReadonlySet<string> = new Set(['local', 'ci', 'demo', 'staging']);
/** 시험 키(test_)의 호출 상한 초당 1 [가정]. 토스 시험 환경은 API별 분당 100건이고(payment §2.1), 파드가 나눠 쓴다 */
export const TOSS_TEST_KEY_CALLS_PER_SECOND = 1;
const SIMULATOR_SECRET_PREFIX = 'sim_sk_';
const TOSS_TEST_KEY_PREFIX = 'test_';
const TOSS_TEST_SECRET_PREFIXES: readonly string[] = ['test_sk_', 'test_gsk_', SIMULATOR_SECRET_PREFIX];
const TOSS_LIVE_SECRET_PREFIXES: readonly string[] = ['live_sk_', 'live_gsk_'];
/** 시크릿 키 접두사 → 짝인 공개 키 접두사. 환경(test·live·sim)과 종류(API 개별 연동 sk↔ck, 주문서형 gsk↔gck)가 함께 맞아야 한다 */
const TOSS_CLIENT_PREFIX_OF: ReadonlyMap<string, string> = new Map([
  ['test_sk_', 'test_ck_'],
  ['test_gsk_', 'test_gck_'],
  ['live_sk_', 'live_ck_'],
  ['live_gsk_', 'live_gck_'],
  [SIMULATOR_SECRET_PREFIX, 'sim_ck_'],
]);

export interface PaymentServiceConfig {
  /** PEAKET_DATABASE_URL */
  readonly databaseUrl: string;
  /** PEAKET_GRPC_HOST(기본 0.0.0.0) */
  readonly grpcHost: string;
  /** PEAKET_GRPC_PORT(기본 DEFAULT_PAYMENT_GRPC_PORT) */
  readonly grpcPort: number;
}

/**
 * 환경 값을 읽는다.
 * @throws Error PEAKET_DATABASE_URL이 없음, PEAKET_GRPC_PORT가 1~65535 정수가 아님(시작 실패)
 */
export function loadPaymentServiceConfig(env: Record<string, string | undefined>): PaymentServiceConfig {
  const databaseUrl = env.PEAKET_DATABASE_URL;
  if (!databaseUrl) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 넣는다)');
  return { databaseUrl, grpcHost: env.PEAKET_GRPC_HOST ?? '0.0.0.0', grpcPort: grpcPortOf(env.PEAKET_GRPC_PORT) };
}

/**
 * 시뮬레이터 어댑터 설정을 읽는다(승인 실행기의 어댑터 등록부, BUILD_ORDER PRF-181). PEAKET_PG_SIM_URL·PEAKET_PG_SIM_SECRET_KEY·PEAKET_PG_SIM_CLIENT_KEY.
 * 주소가 없으면 환경을 가리지 않고 undefined다. 어댑터 없이 켜도 되는지는 assertPgAdapters가 본다(BUILD_ORDER PRF-184).
 * @throws Error 주소가 쿼리·조각·사용자 정보가 없는 http(s) 주소가 아님, 주소가 있는데 키가 없음(시작 실패). 글에 주소 값을 싣지 않는다
 */
export function loadSimulatorGatewayConfig(env: Record<string, string | undefined>): SimulatorGatewayOptions | undefined {
  const baseUrl = env.PEAKET_PG_SIM_URL?.trim();
  if (!baseUrl) return undefined;
  assertHttpUrl('PEAKET_PG_SIM_URL', baseUrl);
  const secretKey = env.PEAKET_PG_SIM_SECRET_KEY;
  if (!secretKey) throw new Error('PEAKET_PG_SIM_SECRET_KEY가 없다(PEAKET_PG_SIM_URL이 있으면 있어야 한다)');
  const clientKey = env.PEAKET_PG_SIM_CLIENT_KEY;
  if (!clientKey) throw new Error('PEAKET_PG_SIM_CLIENT_KEY가 없다(PEAKET_PG_SIM_URL이 있으면 있어야 한다)');
  return { baseUrl, secretKey, clientKey };
}

/**
 * 토스 어댑터 설정을 읽는다(BUILD_ORDER PRF-184, docs/features/payment.md §2.1 '토스 어댑터의 첫 구현'). PEAKET_PG_TOSS_URL·PEAKET_PG_TOSS_SECRET_KEY·PEAKET_PG_TOSS_CLIENT_KEY·PEAKET_PG_TOSS_CALLS_PER_SECOND.
 * 두 키가 다 없으면 undefined다. 키 접두사는 환경과 맞춰 본다: 시험 환경은 test_sk_·test_gsk_ 또는 시뮬레이터를 가리킬 때의 sim_sk_, 운영(PEAKET_ENV가 없거나 그 밖의 값)은 live_sk_·live_gsk_만 받는다.
 * 공개 키는 시크릿과 환경·종류가 짝이어야 한다. sim_sk_가 아닌 키는 토스 공식 호스트로만 나간다. 호출 상한은 값이 없으면 시험 키(test_) 초당 1 [가정], 그 밖은 어댑터 기본값이다.
 * @throws Error 키가 하나만 있음, 접두사가 환경과 어긋남, 공개 키가 시크릿과 짝이 아님, sim_sk_로 토스 공식 주소를 가리킴, sim_sk_가 아닌데 https가 아니거나 공식 호스트가 아님, 주소 모양이 틀림, 호출 상한이 양수가 아님(시작 실패). 글에 키·주소 값을 싣지 않는다
 */
export function loadTossGatewayConfig(env: Record<string, string | undefined>): TossGatewayOptions | undefined {
  const secretKey = env.PEAKET_PG_TOSS_SECRET_KEY?.trim();
  const clientKey = env.PEAKET_PG_TOSS_CLIENT_KEY?.trim();
  if (!secretKey && !clientKey) return undefined;
  if (!secretKey) throw new Error('PEAKET_PG_TOSS_SECRET_KEY가 없다(PEAKET_PG_TOSS_CLIENT_KEY가 있으면 있어야 한다)');
  if (!clientKey) throw new Error('PEAKET_PG_TOSS_CLIENT_KEY가 없다(PEAKET_PG_TOSS_SECRET_KEY가 있으면 있어야 한다)');
  const test = isTestEnv(env);
  const allowed = test ? TOSS_TEST_SECRET_PREFIXES : TOSS_LIVE_SECRET_PREFIXES;
  const secretPrefix = allowed.find((prefix) => secretKey.startsWith(prefix));
  if (secretPrefix === undefined) throw new Error(`PEAKET_PG_TOSS_SECRET_KEY의 접두사가 이 환경(${test ? '시험' : '운영'})에 맞지 않는다. 받는 접두사: ${allowed.join(', ')}`);
  const clientPrefix = TOSS_CLIENT_PREFIX_OF.get(secretPrefix)!;
  if (!clientKey.startsWith(clientPrefix)) throw new Error(`PEAKET_PG_TOSS_CLIENT_KEY의 접두사가 시크릿 키와 짝이 아니다. 받는 접두사: ${clientPrefix}`);
  const baseUrl = env.PEAKET_PG_TOSS_URL?.trim() || DEFAULT_TOSS_API_URL;
  assertHttpUrl('PEAKET_PG_TOSS_URL', baseUrl);
  const url = new URL(baseUrl);
  const officialHost = new URL(DEFAULT_TOSS_API_URL).host;
  if (secretKey.startsWith(SIMULATOR_SECRET_PREFIX)) {
    if (url.hostname === new URL(DEFAULT_TOSS_API_URL).hostname) throw new Error('PEAKET_PG_TOSS_URL이 토스 공식 주소인데 시크릿 키가 시뮬레이터용이다');
  } else if (url.protocol !== 'https:') {
    throw new Error('PEAKET_PG_TOSS_URL은 https 주소여야 한다(시뮬레이터용 키만 http를 쓸 수 있다)');
  } else if (url.host !== officialHost) {
    throw new Error('PEAKET_PG_TOSS_URL은 토스 공식 주소여야 한다(시뮬레이터용 키만 다른 주소를 쓸 수 있다)');
  }
  const callsPerSecond = tossCallsPerSecondOf(env.PEAKET_PG_TOSS_CALLS_PER_SECOND, secretKey);
  return { baseUrl, secretKey, clientKey, ...(callsPerSecond === undefined ? {} : { callsPerSecond }) };
}

/** 토스 호출 상한(초당). 값이 있으면 양수만 받고, 없으면 시험 키는 TOSS_TEST_KEY_CALLS_PER_SECOND, 그 밖은 undefined(어댑터 기본값)다 */
function tossCallsPerSecondOf(raw: string | undefined, secretKey: string): number | undefined {
  const text = raw?.trim();
  if (!text) return secretKey.startsWith(TOSS_TEST_KEY_PREFIX) ? TOSS_TEST_KEY_CALLS_PER_SECOND : undefined;
  const value = Number(text);
  if (!/^[0-9]+(\.[0-9]+)?$/.test(text) || !Number.isFinite(value) || value <= 0) throw new Error('PEAKET_PG_TOSS_CALLS_PER_SECOND는 양수여야 한다');
  return value;
}

/**
 * 포트원 어댑터 설정을 읽는다(BUILD_ORDER HOT-140, docs/features/payment.md §2.1 '포트원 어댑터의 첫 구현').
 * PEAKET_PG_PORTONE_URL(기본 공식 주소)·PEAKET_PG_PORTONE_SECRET·PEAKET_PG_PORTONE_STORE_ID·PEAKET_PG_PORTONE_CHANNEL_KEY·PEAKET_PG_PORTONE_WEBHOOK_SECRET(교체 중의 옛 값은 PEAKET_PG_PORTONE_WEBHOOK_SECRET_PREVIOUS).
 * 넷이 다 없으면 undefined다. 포트원 시크릿은 접두사가 정해져 있지 않아 환경과 맞춰 볼 수 없다. 대신 sim_sk_는 시험 환경의 시뮬레이터 주소에서만 받고, 그 밖의 시크릿은 공식 호스트 https로만 나간다.
 * @throws Error 일부만 있음, 운영에 sim_sk_, sim_sk_로 공식 주소를 가리킴, sim_sk_가 아닌데 https가 아니거나 공식 호스트가 아님, 주소 모양이 틀림(시작 실패). 글에 비밀 값·주소 값을 싣지 않는다
 */
export function loadPortoneGatewayConfig(env: Record<string, string | undefined>): PortoneGatewayOptions | undefined {
  const required = PORTONE_REQUIRED.map((name) => [name, env[name]?.trim()] as const);
  if (required.every(([, value]) => !value)) return undefined;
  for (const [name, value] of required) if (!value) throw new Error(`${name}이 없다(포트원 설정은 넷이 함께 있어야 한다)`);
  const [secret, storeId, channelKey, webhookSecret] = required.map(([, value]) => value!) as [string, string, string, string];
  const test = isTestEnv(env);
  const simulated = secret.startsWith(SIMULATOR_SECRET_PREFIX);
  if (simulated && !test) throw new Error('PEAKET_PG_PORTONE_SECRET이 이 환경(운영)에 맞지 않는다(시뮬레이터용 시크릿은 시험 환경에서만 받는다)');
  const baseUrl = env.PEAKET_PG_PORTONE_URL?.trim() || DEFAULT_PORTONE_API_URL;
  assertHttpUrl('PEAKET_PG_PORTONE_URL', baseUrl);
  const url = new URL(baseUrl);
  const official = new URL(DEFAULT_PORTONE_API_URL);
  if (simulated) {
    if (url.hostname === official.hostname) throw new Error('PEAKET_PG_PORTONE_URL이 포트원 공식 주소인데 시크릿이 시뮬레이터용이다');
  } else if (url.protocol !== 'https:') {
    throw new Error('PEAKET_PG_PORTONE_URL은 https 주소여야 한다(시뮬레이터용 시크릿만 http를 쓸 수 있다)');
  } else if (url.host !== official.host) {
    throw new Error('PEAKET_PG_PORTONE_URL은 포트원 공식 주소여야 한다(시뮬레이터용 시크릿만 다른 주소를 쓸 수 있다)');
  }
  const previous = env.PEAKET_PG_PORTONE_WEBHOOK_SECRET_PREVIOUS?.trim();
  return { baseUrl, secret, storeId, channelKey, webhookSecrets: previous ? [webhookSecret, previous] : [webhookSecret], isTest: test };
}

/**
 * 결제사 어댑터 시작 조건을 본다(BUILD_ORDER PRF-181이 넘긴 것, PRF-184). local·ci는 어댑터 없이도 켠다. 그 밖의 환경은 토스 어댑터가 있어야 한다.
 * 시뮬레이터 어댑터는 운영에서 켜지 못하고, demo·staging에서는 부하 시험·전환 훈련용으로 함께 켤 수 있지만 '어댑터 하나 이상'에는 세지 않는다.
 * @throws Error 조건을 어김(시작 실패)
 */
export function assertPgAdapters(env: Record<string, string | undefined>, adapters: { simulator: boolean; toss: boolean }): void {
  if (env.PEAKET_ENV === 'local' || env.PEAKET_ENV === 'ci') return;
  if (adapters.simulator && !isTestEnv(env)) throw new Error('PEAKET_PG_SIM_URL이 운영 환경에 있다(시뮬레이터 어댑터는 운영에서 켜지 않는다)');
  if (!adapters.toss) throw new Error('PEAKET_PG_TOSS_SECRET_KEY가 없다(local·ci 밖에서는 토스 어댑터가 있어야 시작한다)');
}

export interface PgCallGuardConfig {
  /** PEAKET_PAYMENT_POD_COUNT: 그 서비스의 최대 복제 수(local·ci에서 비면 1 [가정]) */
  readonly podCount: number;
}

/**
 * 결제사 호출 보호 설정을 읽는다(BUILD_ORDER PRF-183). 파드 수를 1로 잘못 보면 결제사 상한을 파드 수 배로 넘기므로 local·ci 밖에서는 반드시 받는다.
 * @throws Error local·ci 밖에서 PEAKET_PAYMENT_POD_COUNT가 비어 있음, 1~MAX_PAYMENT_POD_COUNT의 정수가 아님(시작 실패)
 */
export function loadPgCallGuardConfig(env: Record<string, string | undefined>): PgCallGuardConfig {
  const raw = env.PEAKET_PAYMENT_POD_COUNT?.trim();
  if (!raw) {
    if (env.PEAKET_ENV === 'local' || env.PEAKET_ENV === 'ci') return { podCount: DEFAULT_PAYMENT_POD_COUNT };
    throw new Error('PEAKET_PAYMENT_POD_COUNT가 없다(local·ci 밖에서는 그 서비스의 최대 복제 수를 넣는다)');
  }
  const podCount = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(podCount) || podCount < 1 || podCount > MAX_PAYMENT_POD_COUNT) throw new Error(`PEAKET_PAYMENT_POD_COUNT가 1~${MAX_PAYMENT_POD_COUNT}의 정수가 아니다: ${raw}`);
  return { podCount };
}

/** 외부 호출 클라이언트가 받는 주소 모양인지 본다(잘못된 주소가 듣기 시작한 뒤에 드러나지 않게). 값에 비밀번호가 있을 수 있어 글에 싣지 않는다 */
function assertHttpUrl(name: 'PEAKET_PG_SIM_URL' | 'PEAKET_PG_TOSS_URL' | 'PEAKET_PG_PORTONE_URL', raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name}이 URL이 아니다`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.search || url.hash || url.username || url.password) {
    throw new Error(`${name}은 쿼리·조각·사용자 정보가 없는 http(s) 주소여야 한다`);
  }
}

/** 시험 키만 받는 환경인가. PEAKET_ENV가 없거나 모르는 값이면 운영으로 본다(docs/api/guidelines.md) */
function isTestEnv(env: Record<string, string | undefined>): boolean {
  return TEST_ENVS.has(env.PEAKET_ENV ?? '');
}

function grpcPortOf(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PAYMENT_GRPC_PORT;
  const port = Number(raw);
  if (!/^[0-9]+$/.test(raw) || port < 1 || port > 65_535) throw new Error(`PEAKET_GRPC_PORT가 틀렸다: ${raw}`);
  return port;
}
