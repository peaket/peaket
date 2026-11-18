// realtime-gw 환경 값(docs/features/seat-hold.md §7 'realtime-gw의 첫 구현' '틀과 설정', ADR-0296 결정 1, BUILD_ORDER HOT-090).
// 필수: PEAKET_SEAT_REDIS_URL 또는 PEAKET_SEAT_REDIS_CLUSTER_URLS, PEAKET_ADMISSION_JWKS, PEAKET_ADMISSION_ISSUER, PEAKET_SEATMAP_DIR(purchase-svc와 같은 이름과 뜻).
// 선택: PEAKET_WEB_ORIGIN(허용 출처 하나), PEAKET_REALTIME_MAX_CONNECTIONS(파드 연결 상한, 1~1,000,000, 기본 5,000 [가정], ADR-0297 결정 3)과
// 플랫폼 공통 값(PORT·PEAKET_MANAGEMENT_PORT·PEAKET_ENV·로그 값).
// PEAKET_ENV가 local·ci가 아니면(없으면 운영으로 본다) 좌석 Redis 주소가 모두 rediss://이고 사용자 이름이 있으며 default가 아니어야 한다
// (ASVS v5.0.0-12.3.1·13.2.1·13.2.3). Redis 서버 인증서 확인을 끄는 설정은 두지 않는다(12.3.2). 오류 글에는 주소·비밀번호·키 값을 싣지 않는다.
import { type AdmissionKeys, loadPlatformConfig, parseAdmissionJwks } from '@peaket/platform';

/** 허용 출처의 기본값(docs/frontend.md §4.4.1) */
export const DEFAULT_WEB_ORIGIN = 'https://www.peaket.example';
/** 파드 연결 상한의 기본값([가정], 좌석 단계 동시 인원 docs/architecture.md §9.1, ADR-0297 결정 3) */
export const DEFAULT_MAX_CONNECTIONS = 5_000;
const MAX_CONNECTIONS_LIMIT = 1_000_000;

export interface RealtimeGwConfig {
  /** 좌석 Redis 단일 노드 주소(로컬·CI). 클러스터 주소가 있으면 undefined */
  seatRedisUrl?: string;
  /** 좌석 Redis 클러스터 시작 노드 주소들(운영) */
  seatRedisClusterUrls: string[];
  admissionKeys: AdmissionKeys;
  admissionIssuer: string;
  seatMapDir: string;
  /** 허용 출처(글자 그대로 비교한다) */
  webOrigin: string;
  /** 파드 연결 상한. 닿으면 핸드셰이크를 503으로 거절한다 */
  maxConnections: number;
}

/** local·ci만 평문·사용자 없는 Redis 주소를 받는다 */
const RELAXED_ENVS: readonly string[] = ['local', 'ci'];

/** 주소 하나의 규칙을 본다. 던지는 글에는 몇 번째 주소인지만 싣는다(주소에 비밀번호가 들어 있다) */
function checkRedisUrl(raw: string, at: string, strict: boolean): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`좌석 Redis 주소 ${at}가 주소 모양이 아니다`);
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') throw new Error(`좌석 Redis 주소 ${at}는 redis:// 또는 rediss://여야 한다`);
  if (!strict) return;
  if (url.protocol !== 'rediss:') throw new Error(`좌석 Redis 주소 ${at}는 운영 쪽 환경에서 rediss://(TLS)여야 한다`);
  let user: string;
  try {
    user = decodeURIComponent(url.username);
  } catch {
    throw new Error(`좌석 Redis 주소 ${at}의 사용자 이름을 읽지 못했다`);
  }
  if (user === '') throw new Error(`좌석 Redis 주소 ${at}에 사용자 이름이 없다(구독 명령만 허용한 사용자로 붙는다)`);
  if (user === 'default') throw new Error(`좌석 Redis 주소 ${at}의 사용자가 default다(구독 명령만 허용한 사용자로 붙는다)`);
}

/**
 * 환경 값을 읽는다. 필수 값이 없거나 규칙에 어긋나면 Error다(시작하지 않는다)
 * @throws Error 오류 글에 주소·비밀번호·키 값을 싣지 않는다
 */
export function loadRealtimeGwConfig(env: Record<string, string | undefined>): RealtimeGwConfig {
  const platform = loadPlatformConfig(env);
  const strict = !RELAXED_ENVS.includes(platform.env);
  const clusterUrls = (env.PEAKET_SEAT_REDIS_CLUSTER_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const url = env.PEAKET_SEAT_REDIS_URL || undefined;
  if (!url && clusterUrls.length === 0) throw new Error('PEAKET_SEAT_REDIS_URL이나 PEAKET_SEAT_REDIS_CLUSTER_URLS가 없다(비밀 관리에서 넣는다)');
  if (clusterUrls.length > 0) clusterUrls.forEach((u, n) => checkRedisUrl(u, `PEAKET_SEAT_REDIS_CLUSTER_URLS[${n}]`, strict));
  else checkRedisUrl(url!, 'PEAKET_SEAT_REDIS_URL', strict);

  const need = (name: string, what: string): string => {
    const v = env[name];
    if (!v) throw new Error(`${name}가 없다(${what})`);
    return v;
  };
  const admissionKeys = parseAdmissionJwks(need('PEAKET_ADMISSION_JWKS', '입장 토큰 공개키 묶음 JWKS JSON'));
  const admissionIssuer = need('PEAKET_ADMISSION_ISSUER', '입장 토큰 발급자 iss');
  const seatMapDir = need('PEAKET_SEATMAP_DIR', '회차별 좌석맵 판 파일 {eventId}.json이 있는 폴더');
  const webOrigin = env.PEAKET_WEB_ORIGIN || DEFAULT_WEB_ORIGIN;
  const rawMax = env.PEAKET_REALTIME_MAX_CONNECTIONS;
  let maxConnections = DEFAULT_MAX_CONNECTIONS;
  if (rawMax !== undefined && rawMax !== '') {
    if (!/^[1-9][0-9]{0,6}$/.test(rawMax) || Number(rawMax) > MAX_CONNECTIONS_LIMIT) throw new Error(`PEAKET_REALTIME_MAX_CONNECTIONS는 1~${MAX_CONNECTIONS_LIMIT}의 정수여야 한다`);
    maxConnections = Number(rawMax);
  }
  return {
    ...(clusterUrls.length > 0 ? {} : { seatRedisUrl: url! }),
    seatRedisClusterUrls: clusterUrls,
    admissionKeys,
    admissionIssuer,
    seatMapDir,
    webOrigin,
    maxConnections,
  };
}
