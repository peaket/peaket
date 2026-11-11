// v1 측정 무대(BUILD_ORDER PRF-215, ADR-0262 결정 4, docs/verification.md §3.8 '합본의 v1 무대'): 시험 키, 합본의 서비스별 환경 파일, 시드 값을 만드는 순수 함수.
// tools/local/cluster.mjs v1(kind 배포)과 services/bundle/test-int(합본·서비스 시작 파일을 실제 저장소로 띄우는 시험)가 같은 함수로 환경 값을 만든다.
// - 키는 모두 이 PC에서 만든 시험 값이다(local·ci만, 저장소에 두지 않는다). 클러스터에는 Secret으로만 넣고 로그·산출물·장부에 싣지 않는다.
// - 환경 파일 한 줄은 KEY=값이고 값에 줄바꿈이 있으면 던진다(합본의 parseEnvFile과 같은 꼴, services/bundle/src/bundle.ts).
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes } from 'node:crypto';

export const V1_NAMESPACE = 'v1';
/** 합본에 넣는 서비스(ADR-0262 결정 4). 켜는 차례 */
export const V1_SERVICES = Object.freeze(['payment-svc', 'purchase-svc', 'admission-ctrl', 'queue-svc']);
/**
 * 합본 안 서비스의 포트(서비스마다 다르다. 합본 관리 포트 9464는 차트의 managementPort). 앱 포트 queue-svc 8080은 차트 service.port, 나머지는 service.extraPorts
 * payment-svc의 업무 gRPC는 같은 파드 안 purchase-svc가 127.0.0.1로 부른다(서비스 사이 호출은 v1과 같은 gRPC, docs/verification.md §3.8 '같게 두는 것'). queue-svc의 업무 gRPC(VerificationAppealService)는 다른 포트로 127.0.0.1에만 연다
 */
/** @type {Readonly<V1Ports>} */
/**
 * BAT-032: 홀드 전용 purchase-svc 워커의 앱 포트. 합본 파드 안에서 별도 스레드가 듣고,
 * 차트 Service의 extraPorts로 k6가 직접 부른다(다른 구매 요청은 기존 purchase-svc 8081).
 */
export const V1_HOLD_PORT = 8083;
/** @type {Readonly<V1Ports>} */
export const V1_PORTS = Object.freeze({
  bundleManagement: 9464,
  'queue-svc': Object.freeze({ app: 8080, management: 9471, grpc: 50052 }),
  'purchase-svc': Object.freeze({ app: 8081, management: 9473 }),
  'admission-ctrl': Object.freeze({ app: 8082, management: 9472 }),
  'payment-svc': Object.freeze({ app: 8084, management: 9474, grpc: 50051 }),
});
/** @typedef {{ app: number, management: number }} V1ServicePorts */
/** @typedef {{ bundleManagement: number, 'queue-svc': V1ServicePorts & { grpc: number }, 'purchase-svc': V1ServicePorts, 'admission-ctrl': V1ServicePorts, 'payment-svc': V1ServicePorts & { grpc: number } }} V1Ports */
/** 입장 토큰 발급자(https 주소여야 한다. 시험 값) */
export const V1_ADMISSION_ISSUER = 'https://queue.v1.peaket.local';
/** 주문 동의 문안 판(시험 값, 1~32자 영문·숫자·._-) */
export const V1_CONSENT_VERSION = 'lt-v1-2026-11';
/** 합본 파드 안 경로(차트 service.volumes·volumeMounts) */
export const V1_PATHS = Object.freeze({
  envDir: '/etc/peaket/bundle',
  seatmapDir: '/etc/peaket/seatmaps',
  batchResultDir: '/var/peaket/batch-results',
  redisCaDir: '/etc/peaket/redis-tls',
});

const KEY = /^[A-Z_][A-Z0-9_]*$/;
/** @param {Uint8Array} buf */
const b64u = (buf) => Buffer.from(buf).toString('base64url');

/**
 * P-256 키 한 쌍의 개인·공개 JWK(kid를 단다)
 * @param {string} kid
 */
function ecJwk(kid) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const priv = /** @type {{ x: string, y: string, d: string }} */ (privateKey.export({ format: 'jwk' }));
  return { privateJwk: { kty: 'EC', crv: 'P-256', x: priv.x, y: priv.y, d: priv.d, kid }, publicJwk: { kty: 'EC', crv: 'P-256', x: priv.x, y: priv.y, kid } };
}

/**
 * 무대의 시험 키를 새로 만든다. 돌려준 값의 개인 성분은 Secret에만 넣는다.
 * - queueTokenKey: 대기표 HMAC 키 'kid:base64(32바이트)'
 * - admission: 입장 토큰 ES256 개인 JWK(queue-svc)와 공개키 묶음(purchase-svc)
 * - ecdh: 구매 세션 서버 ECDH 개인 JWK(purchase-svc)와 공개 JWK(queue-svc가 입장 확정 응답에 싣는다)
 * - batchRandomness: 시험 시드·비콘 값(base64 32바이트, admission-ctrl·queue-svc가 함께 쓴다)
 * - pgSim: 결제 시뮬레이터 시험 키(sim_sk_… 비밀 키, 결제창 clientKey)
 * @param {(n: number) => Buffer} [rand]
 */
export function v1Keys(rand = randomBytes) {
  const tag = rand(3).toString('hex');
  const admission = ecJwk(`v1-adm-${tag}`);
  const ecdh = ecJwk(`v1-ecdh-${tag}`);
  return {
    queueTokenKey: `v1q${tag}:${rand(32).toString('base64')}`,
    admission: { privateJwk: admission.privateJwk, jwks: { keys: [{ ...admission.publicJwk, use: 'sig', alg: 'ES256' }] } },
    ecdh,
    batchRandomness: rand(32).toString('base64'),
    pgSim: { secretKey: `sim_sk_${rand(18).toString('hex')}`, clientKey: `sim_ck_${rand(12).toString('hex')}` },
    // v1 무대 전용 PostgreSQL의 비밀번호(무대마다 새로, Secret v1-postgres와 DB 주소에만 둔다, 코드 리뷰 M2)
    dbPassword: rand(18).toString('base64url'),
  };
}

/**
 * 부하 발생기가 쓰는 구매 세션 클라이언트 키(BUILD_ORDER PRF-215 ④). 서버 ECDH 키가 고정이고 클라이언트 키 재사용을 서버가 막지 않으므로
 * 이 PC에서 클라이언트 키 한 쌍과 공유 비밀(x 좌표 32바이트)을 미리 계산해 k6에 넘긴다(k6에는 ECDH가 없다). 서버는 요청마다 ECDH를 그대로 계산한다.
 * 클라이언트 공개키는 압축하지 않은 점(0x04‖X‖Y) 65바이트의 base64url(87자)이다
 * @param {{ kty: 'EC', crv: 'P-256', x: string, y: string }} serverPublicJwk
 * @returns {{ clientPublicKey: string, sharedSecretHex: string }}
 */
export function v1ClientKey(serverPublicJwk) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = /** @type {{ x: string, y: string }} */ (publicKey.export({ format: 'jwk' }));
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
  const server = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: serverPublicJwk.x, y: serverPublicJwk.y }, format: 'jwk' });
  const shared = diffieHellman({ privateKey, publicKey: server });
  return { clientPublicKey: b64u(point), sharedSecretHex: shared.toString('hex') };
}

/**
 * 서버 개인 JWK와 클라이언트 공개키(87자)로 공유 비밀을 다시 계산한다(시험에서 v1ClientKey를 대조한다)
 * @param {import('node:crypto').JsonWebKey} serverPrivateJwk
 * @param {string} clientPublicKey
 */
export function v1SharedSecret(serverPrivateJwk, clientPublicKey) {
  const point = Buffer.from(clientPublicKey, 'base64url');
  if (point.length !== 65 || point[0] !== 4) throw new RangeError('클라이언트 공개키는 압축하지 않은 P-256 점 65바이트여야 한다');
  const client = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) }, format: 'jwk' });
  const priv = createPrivateKey({ key: serverPrivateJwk, format: 'jwk' });
  return diffieHellman({ privateKey: priv, publicKey: client }).toString('hex');
}

/**
 * 합본의 서비스별 환경 값(docs/verification.md §3.8 '합본의 v1 무대' 3). 프로세스 공통 값(PEAKET_ENV·파드 이름·OTel)은 넣지 않는다.
 * @param {{
 *   keys: ReturnType<typeof v1Keys>,
 *   queueRedisUrl: string, seatRedisUrl: string,
 *   purchaseDatabaseUrl: string, paymentDatabaseUrl: string,
 *   seatmapDir: string, batchResultDir: string,
 *   pgSimUrl?: string, kafkaBrokers?: string, prometheusUrl?: string,
 *   paymentPodCount?: number, ports?: V1Ports, logLevel?: string,
 * }} o
 * @returns {Record<'payment-svc'|'purchase-svc'|'admission-ctrl'|'queue-svc', Record<string, string>>}
 */
export function v1EnvFiles(o) {
  const ports = o.ports ?? V1_PORTS;
  const k = o.keys;
  /** @param {'payment-svc'|'purchase-svc'|'admission-ctrl'|'queue-svc'} svc @returns {Record<string, string>} */
  const common = (svc) => ({ PORT: String(ports[svc].app), PEAKET_MANAGEMENT_PORT: String(ports[svc].management), ...(o.logLevel ? { PEAKET_LOG_LEVEL: o.logLevel } : {}) });
  /** @type {Record<string, string>} */
  const kafka = o.kafkaBrokers ? { PEAKET_KAFKA_BROKERS: o.kafkaBrokers } : {};
  const payment = {
    ...common('payment-svc'),
    // 업무 gRPC는 같은 파드의 purchase-svc만 부른다(파드 밖에 열지 않는다, 코드 리뷰)
    PEAKET_GRPC_HOST: '127.0.0.1',
    PEAKET_GRPC_PORT: String(ports['payment-svc'].grpc),
    PEAKET_DATABASE_URL: o.paymentDatabaseUrl,
    // 결제사는 시뮬레이터 하나(실제 결제사·비용 없음, docs/verification.md §3.10 공통 규칙). 대체 결제사는 두지 않는다
    PEAKET_PG_DEFAULT: 'SIMULATOR',
    PEAKET_PG_FALLBACK: 'none',
    ...(o.pgSimUrl ? { PEAKET_PG_SIM_URL: o.pgSimUrl, PEAKET_PG_SIM_SECRET_KEY: k.pgSim.secretKey, PEAKET_PG_SIM_CLIENT_KEY: k.pgSim.clientKey } : {}),
    ...(o.paymentPodCount ? { PEAKET_PAYMENT_POD_COUNT: String(o.paymentPodCount) } : {}),
    ...(o.prometheusUrl ? { PEAKET_PROMETHEUS_URL: o.prometheusUrl } : {}),
  };
  const purchase = {
    ...common('purchase-svc'),
    PEAKET_SEAT_REDIS_URL: o.seatRedisUrl,
    PEAKET_DATABASE_URL: o.purchaseDatabaseUrl,
    PEAKET_ORDER_CONSENT_VERSION: V1_CONSENT_VERSION,
    PEAKET_ADMISSION_JWKS: JSON.stringify(k.admission.jwks),
    PEAKET_ADMISSION_ISSUER: V1_ADMISSION_ISSUER,
    PEAKET_PURCHASE_ECDH_KEY: JSON.stringify(k.ecdh.privateJwk),
    PEAKET_SEATMAP_DIR: o.seatmapDir,
    // 같은 파드의 payment-svc 업무 gRPC(합본 안에서도 v1과 같은 gRPC로 부른다)
    PEAKET_PAYMENT_GRPC_ADDR: `127.0.0.1:${ports['payment-svc'].grpc}`,
    ...kafka,
  };
  const admission = {
    ...common('admission-ctrl'),
    PEAKET_QUEUE_REDIS_URL: o.queueRedisUrl,
    PEAKET_BATCH_RESULT_DIR: o.batchResultDir,
    PEAKET_TEST_BATCH_RANDOMNESS: k.batchRandomness,
  };
  const queue = {
    ...common('queue-svc'),
    // 업무 gRPC(VerificationAppealService, BOT-090): 무대에서는 부르는 쪽(ops-svc)이 없어 파드 안 127.0.0.1에만 열고, payment-svc 업무 gRPC와 다른 포트를 준다
    PEAKET_GRPC_HOST: '127.0.0.1',
    PEAKET_GRPC_PORT: String(ports['queue-svc'].grpc),
    PEAKET_QUEUE_REDIS_URL: o.queueRedisUrl,
    PEAKET_QUEUE_TOKEN_KEY: k.queueTokenKey,
    PEAKET_ADMISSION_TOKEN_KEY: JSON.stringify(k.admission.privateJwk),
    PEAKET_ADMISSION_TOKEN_ISSUER: V1_ADMISSION_ISSUER,
    PEAKET_PURCHASE_ECDH_PUBLIC_JWK: JSON.stringify(k.ecdh.publicJwk),
    PEAKET_BATCH_RESULT_DIR: o.batchResultDir,
    PEAKET_TEST_BATCH_RANDOMNESS: k.batchRandomness,
    ...kafka,
  };
  return { 'payment-svc': payment, 'purchase-svc': purchase, 'admission-ctrl': admission, 'queue-svc': queue };
}

/**
 * 환경 값 묶음을 환경 파일 글로 쓴다(이름 차례). 이름이 규칙에 맞지 않거나 값에 줄바꿈이 있으면 던진다(값은 글에 싣지 않는다)
 * @param {Record<string, string>} values
 */
export function envFileText(values) {
  const lines = [];
  for (const key of Object.keys(values).sort()) {
    if (!KEY.test(key)) throw new RangeError(`환경 파일 이름이 대문자·숫자·밑줄이 아니다: ${key}`);
    const v = String(values[key]);
    if (/[\r\n]/.test(v)) throw new RangeError(`환경 파일 ${key}의 값에 줄바꿈이 있다`);
    lines.push(`${key}=${v}`);
  }
  return `${lines.join('\n')}\n`;
}
