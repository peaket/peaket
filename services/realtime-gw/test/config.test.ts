// realtime-gw 환경 값 단위 시험(BUILD_ORDER HOT-090, BAT-052).
// 정본: docs/features/seat-hold.md §7 'realtime-gw의 첫 구현' '틀과 설정'(필수 값 넷, PEAKET_ENV가 local·ci가 아니면 좌석 Redis 주소가 모두 rediss://이고
// 사용자 이름이 있으며 default가 아니어야 시작, Redis 서버 인증서 확인을 끄는 설정은 두지 않음), §12 S-T42 ⑬(오류 글에 비밀번호가 없다).
// 허용 목록 밖 값(prod·staging·demo, 그리고 값 없음)마다 거절을 보고, 맞는 값으로 통과하는 대조도 둔다.
// 리뷰 반영(BAT-052 RF-T6, SEC-02): 파드 연결 상한 PEAKET_REALTIME_MAX_CONNECTIONS(seat-hold §7 '핸드셰이크' ②, ADR-0297 결정 3). 읽은 칸 이름은 maxConnections다.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { loadRealtimeGwConfig } from '../src/config.js';

const PW = 'Pw-7f3K9-secret';
const jwk = (kid: string) => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, kid };
};
const JWKS = JSON.stringify({ keys: [jwk('k1')] });

const base = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  PEAKET_ENV: 'local',
  PEAKET_SEAT_REDIS_URL: `redis://127.0.0.1:6379`,
  PEAKET_ADMISSION_JWKS: JWKS,
  PEAKET_ADMISSION_ISSUER: 'https://queue.peaket.example',
  PEAKET_SEATMAP_DIR: '/srv/seatmaps',
  ...over,
});

/** 던진 오류 글(던지지 않으면 undefined) */
const errorOf = (env: Record<string, string | undefined>): string | undefined => {
  try {
    loadRealtimeGwConfig(env);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

const STRICT_ENVS = ['prod', 'staging', 'demo', undefined] as const;
const GOOD_TLS = `rediss://rtgw:${PW}@seat-redis.internal:6380`;

describe('S-T42 ⑬ 환경 값', () => {
  test('S-T42 ⑬ 필수 값 넷이 있으면 읽고, 허용 출처는 없으면 https://www.peaket.example이다', () => {
    const c = loadRealtimeGwConfig(base());
    expect(c.seatRedisUrl).toBe('redis://127.0.0.1:6379');
    expect(c.admissionIssuer).toBe('https://queue.peaket.example');
    expect(c.seatMapDir).toBe('/srv/seatmaps');
    expect([...c.admissionKeys.keys()]).toEqual(['k1']);
    expect(c.webOrigin).toBe('https://www.peaket.example');
    expect(loadRealtimeGwConfig(base({ PEAKET_WEB_ORIGIN: 'https://m.peaket.example' })).webOrigin).toBe('https://m.peaket.example');
  });

  test('S-T42 ⑬ 필수 값(좌석 Redis 주소·JWKS·발급자·판 폴더)을 하나씩 빼면 던진다. 클러스터 주소는 단일 주소를 갈음한다', () => {
    for (const name of ['PEAKET_SEAT_REDIS_URL', 'PEAKET_ADMISSION_JWKS', 'PEAKET_ADMISSION_ISSUER', 'PEAKET_SEATMAP_DIR']) {
      expect(errorOf(base({ [name]: undefined })), name).toBeDefined();
      expect(errorOf(base({ [name]: '' })), `${name} 빈 값`).toBeDefined();
    }
    const cluster = loadRealtimeGwConfig(base({ PEAKET_SEAT_REDIS_URL: undefined, PEAKET_SEAT_REDIS_CLUSTER_URLS: 'redis://10.0.0.1:6379,redis://10.0.0.2:6379' }));
    expect(cluster.seatRedisClusterUrls).toEqual(['redis://10.0.0.1:6379', 'redis://10.0.0.2:6379']);
  });

  test('S-T42 ⑬ PEAKET_ENV prod·staging·demo·값 없음에서 redis://·사용자 없음·default 사용자는 던지고 오류 글에 비밀번호가 없다 [ASVS v5.0.0-12.3.1] [ASVS v5.0.0-13.2.1] [ASVS v5.0.0-13.2.3]', () => {
    const bad = [`redis://rtgw:${PW}@seat-redis.internal:6379`, `rediss://:${PW}@seat-redis.internal:6380`, `rediss://seat-redis.internal:6380`, `rediss://default:${PW}@seat-redis.internal:6380`];
    for (const env of STRICT_ENVS) {
      for (const url of bad) {
        const err = errorOf(base({ PEAKET_ENV: env, PEAKET_LOG_PSEUDONYM_KEY: undefined, PEAKET_SEAT_REDIS_URL: url }));
        expect(err, `${env} ${url}`).toBeDefined();
        expect(err).not.toContain(PW);
        expect(err).not.toContain('seat-redis.internal');
        // 클러스터 주소에 하나만 섞여도 던진다
        const cerr = errorOf(base({ PEAKET_ENV: env, PEAKET_SEAT_REDIS_URL: undefined, PEAKET_SEAT_REDIS_CLUSTER_URLS: `${GOOD_TLS},${url}` }));
        expect(cerr, `${env} cluster ${url}`).toBeDefined();
        expect(cerr).not.toContain(PW);
      }
      // 대조: rediss://와 default가 아닌 사용자면 받는다
      expect(errorOf(base({ PEAKET_ENV: env, PEAKET_SEAT_REDIS_URL: GOOD_TLS })), String(env)).toBeUndefined();
      expect(errorOf(base({ PEAKET_ENV: env, PEAKET_SEAT_REDIS_URL: undefined, PEAKET_SEAT_REDIS_CLUSTER_URLS: `${GOOD_TLS},rediss://rtgw:${PW}@seat-redis-2.internal:6380` })), String(env)).toBeUndefined();
    }
  });

  test('S-T42 ⑬ local·ci는 redis://와 사용자 없는 주소를 받는다', () => {
    for (const env of ['local', 'ci']) {
      expect(errorOf(base({ PEAKET_ENV: env, PEAKET_SEAT_REDIS_URL: 'redis://127.0.0.1:6379' })), env).toBeUndefined();
      expect(errorOf(base({ PEAKET_ENV: env, PEAKET_SEAT_REDIS_URL: `redis://default:${PW}@127.0.0.1:6379` })), env).toBeUndefined();
    }
  });

  test('S-T42 ⑬ 주소 모양이 아니거나 redis 주소가 아니면 던지고 글에 값을 싣지 않는다', () => {
    for (const url of [`http://rtgw:${PW}@seat-redis.internal`, `not a url ${PW}`]) {
      const err = errorOf(base({ PEAKET_SEAT_REDIS_URL: url }));
      expect(err, url).toBeDefined();
      expect(err).not.toContain(PW);
    }
  });

  test('S-T42 ⑬ 설정에는 Redis 서버 인증서 확인을 끄는 칸이 없다(읽은 설정의 칸은 정본 값뿐이다) [ASVS v5.0.0-12.3.2]', () => {
    const c = loadRealtimeGwConfig(base({ PEAKET_ENV: 'prod', PEAKET_SEAT_REDIS_URL: GOOD_TLS, NODE_TLS_REJECT_UNAUTHORIZED: '0', PEAKET_SEAT_REDIS_TLS_INSECURE: 'true' }));
    expect(Object.keys(c).sort()).toEqual(['admissionIssuer', 'admissionKeys', 'maxConnections', 'seatMapDir', 'seatRedisClusterUrls', 'seatRedisUrl', 'webOrigin']);
    expect(c.seatRedisUrl).toBe(GOOD_TLS);
  });
});

describe('S-T42 ⑯ 파드 연결 상한(ADR-0297 결정 3)', () => {
  test('S-T42 ⑯ PEAKET_REALTIME_MAX_CONNECTIONS는 1~1,000,000의 정수이고 없으면 5,000 [가정]이다. 0·소수·음수·1,000,001·글자는 던진다 [ASVS v5.0.0-2.4.1]', () => {
    expect(loadRealtimeGwConfig(base()).maxConnections).toBe(5_000);
    expect(loadRealtimeGwConfig(base({ PEAKET_REALTIME_MAX_CONNECTIONS: '' })).maxConnections).toBe(5_000);
    for (const [raw, want] of [['1', 1], ['3', 3], ['5000', 5_000], ['1000000', 1_000_000]] as const) {
      expect(loadRealtimeGwConfig(base({ PEAKET_REALTIME_MAX_CONNECTIONS: raw })).maxConnections, raw).toBe(want);
    }
    for (const raw of ['0', '2.5', '-1', '1000001', 'abc']) {
      const err = errorOf(base({ PEAKET_REALTIME_MAX_CONNECTIONS: raw }));
      expect(err, raw).toBeDefined();
    }
  });
});
