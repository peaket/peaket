// v0 입구 설정 시험(docs/infra.md §3 'v0 배포'). 환경 값을 읽고, 없거나 틀리면 GatewayConfigError로 시작하지 않는다.
// 오류 문구에는 비밀(TLS 키)·공개키 목록·앱 주소의 값을 싣지 않는다(로그에 남지 않게).
import { beforeAll, describe, expect, test } from 'vitest';
import { GATEWAY_DEFAULTS, GatewayConfigError, loadGatewayConfig } from '../src/gateway/config.js';
import { ISSUER, makeFanKey, selfSignedCert } from './gateway-helpers.js';

const UPSTREAM = 'http://v0-monolith-secret.v0.svc:8080';
const key = makeFanKey('kid-cfg');
const JWKS = JSON.stringify({ keys: [key.publicJwk] });

let tlsCert = '';
let tlsKey = '';

beforeAll(() => {
  ({ cert: tlsCert, key: tlsKey } = selfSignedCert());
});

type Env = Record<string, string | undefined>;

function validEnv(over: Env = {}): Env {
  return {
    PEAKET_ENV: 'local',
    PEAKET_V0_UPSTREAM: UPSTREAM,
    PEAKET_V0_TLS_CERT: tlsCert,
    PEAKET_V0_TLS_KEY: tlsKey,
    PEAKET_V0_GATEWAY_JWKS: JWKS,
    PEAKET_V0_TOKEN_ISSUER: ISSUER,
    PEAKET_V0_ALLOWED_ORIGINS: 'https://www.peaket.local, https://127.0.0.1:8443',
    ...over,
  };
}

/** 키 PEM의 몸통 한 줄(머리·꼬리 줄 말고) */
function keyBodyLine(): string {
  const line = tlsKey.split(/\r?\n/).find((l) => l.length > 20 && !l.startsWith('-----'));
  if (!line) throw new Error('키 PEM 몸통이 없다');
  return line;
}

/** 그 환경이 GatewayConfigError를 던지는지 보고, 문구에 비밀 값이 없는지 본다 */
function expectConfigError(env: Env, what: string): void {
  let caught: unknown;
  try {
    loadGatewayConfig(env);
  } catch (err) {
    caught = err;
  }
  expect(caught, what).toBeInstanceOf(GatewayConfigError);
  const message = String((caught as Error).message);
  expect(message.length, what).toBeGreaterThan(0);
  for (const secret of [keyBodyLine(), '-----BEGIN', JWKS, key.publicJwk.x, key.privateJwk.d, UPSTREAM, 'v0-monolith-secret']) {
    expect(message, `${what}: 문구에 비밀 값이 실렸다`).not.toContain(secret);
  }
}

describe('loadGatewayConfig', () => {
  test('BSL050_맞는_환경값을_읽고_기본값을_채운다', () => {
    const config = loadGatewayConfig(validEnv());
    expect(config.env).toBe('local');
    expect(config.port).toBe(8443);
    expect(config.managementPort).toBe(9464);
    expect(config.trustedProxyHops).toBe(0);
    expect(config.ratePerSecond).toBe(10);
    expect(config.burst).toBe(20);
    expect(config.maxKeys).toBe(100_000);
    expect(config.upstreamTimeoutMs).toBe(20_000);
    expect(config.upstream).toBeInstanceOf(URL);
    expect(config.upstream.href).toBe(`${UPSTREAM}/`);
    expect(config.tlsCert).toBe(tlsCert);
    expect(config.tlsKey).toBe(tlsKey);
    expect(config.jwks.keys).toHaveLength(1);
    expect(config.jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', kid: 'kid-cfg', x: key.publicJwk.x, y: key.publicJwk.y });
    expect(config.issuer).toBe(ISSUER);
    expect(config.allowedOrigins).toEqual(['https://www.peaket.local', 'https://127.0.0.1:8443']);
    expect(GATEWAY_DEFAULTS).toEqual({ port: 8443, managementPort: 9464, trustedProxyHops: 0, ratePerSecond: 10, burst: 20, maxKeys: 100_000, upstreamTimeoutMs: 20_000 });
  });

  test('BSL050_고를_수_있는_값을_환경값으로_바꾼다(경계값_포함)', () => {
    const config = loadGatewayConfig(
      validEnv({
        PEAKET_ENV: 'ci',
        PEAKET_V0_GATEWAY_PORT: '9443',
        PEAKET_MANAGEMENT_PORT: '9500',
        PEAKET_V0_TRUSTED_PROXY_HOPS: '5',
        PEAKET_V0_RATE_PER_SECOND: '0.5',
        PEAKET_V0_RATE_BURST: '1',
        PEAKET_V0_UPSTREAM_TIMEOUT_MS: '15001',
        PEAKET_V0_ALLOWED_ORIGINS: 'https://www.peaket.local',
      }),
    );
    expect(config).toMatchObject({ env: 'ci', port: 9443, managementPort: 9500, trustedProxyHops: 5, ratePerSecond: 0.5, burst: 1, upstreamTimeoutMs: 15_001, allowedOrigins: ['https://www.peaket.local'] });
    expect(loadGatewayConfig(validEnv({ PEAKET_V0_TRUSTED_PROXY_HOPS: '0' })).trustedProxyHops).toBe(0);
    expect(loadGatewayConfig(validEnv({ PEAKET_V0_TRUSTED_PROXY_HOPS: '1' })).trustedProxyHops).toBe(1);
  });

  test('BSL050_PEAKET_ENV가_local·ci가_아니면_시작하지_않는다', () => {
    for (const value of ['prod', 'staging', 'demo', 'LOCAL', ' local', '', undefined]) {
      expectConfigError(validEnv({ PEAKET_ENV: value }), `PEAKET_ENV=${String(value)}`);
    }
  });

  test('BSL050_앱_주소가_없거나_http가_아니면_시작하지_않는다', () => {
    for (const value of [undefined, '', 'not a url', 'https://v0-monolith-secret.v0.svc:8080', 'ftp://v0-monolith-secret.v0.svc', 'v0-monolith-secret.v0.svc:8080']) {
      expectConfigError(validEnv({ PEAKET_V0_UPSTREAM: value }), `PEAKET_V0_UPSTREAM=${String(value)}`);
    }
  });

  test('BSL050_TLS_인증서나_키가_없으면_시작하지_않는다 [ASVS v5.0.0-12.2.1]', () => {
    for (const name of ['PEAKET_V0_TLS_CERT', 'PEAKET_V0_TLS_KEY']) {
      expectConfigError(validEnv({ [name]: undefined }), `${name} 없음`);
      expectConfigError(validEnv({ [name]: '' }), `${name} 빈 값`);
    }
  });

  test('BSL050_공개키_목록이_없거나_틀리거나_개인키가_들었으면_시작하지_않는다 [ASVS v5.0.0-9.1.2]', () => {
    const cases: Array<[string, string | undefined]> = [
      ['없음', undefined],
      ['빈 값', ''],
      ['JSON 아님', 'not json'],
      ['키 없음', '{"keys":[]}'],
      ['RSA', JSON.stringify({ keys: [{ ...key.publicJwk, kty: 'RSA' }] })],
      ['alg HS256', JSON.stringify({ keys: [{ ...key.publicJwk, alg: 'HS256' }] })],
      ['개인키 d', JSON.stringify({ keys: [key.privateJwk] })],
    ];
    for (const [what, value] of cases) {
      expectConfigError(validEnv({ PEAKET_V0_GATEWAY_JWKS: value }), `JWKS ${what}`);
    }
  });

  test('BSL050_발급자가_없으면_시작하지_않는다 [ASVS v5.0.0-9.2.3]', () => {
    expectConfigError(validEnv({ PEAKET_V0_TOKEN_ISSUER: undefined }), '발급자 없음');
    expectConfigError(validEnv({ PEAKET_V0_TOKEN_ISSUER: '' }), '발급자 빈 값');
  });

  test('BSL050_허용출처가_하나도_없으면_시작하지_않는다 [ASVS v5.0.0-3.5.1]', () => {
    for (const value of [undefined, '', ' ', ' , ']) {
      expectConfigError(validEnv({ PEAKET_V0_ALLOWED_ORIGINS: value }), `허용출처=${JSON.stringify(value)}`);
    }
  });

  test('BSL050_믿는_홉은_0~5_정수만_받는다 [ASVS v5.0.0-4.1.3]', () => {
    for (const value of ['-1', '6', '1.5', 'abc', '1e1']) {
      expectConfigError(validEnv({ PEAKET_V0_TRUSTED_PROXY_HOPS: value }), `홉=${value}`);
    }
  });

  test('K6_레이트리밋은_양수_속도와_1_이상_정수_버스트만_받는다 [ASVS v5.0.0-2.4.1]', () => {
    // Infinity는 Number()로 읽으면 양수지만 한도를 없앤다
    for (const value of ['0', '-1', 'abc', 'NaN', 'Infinity']) {
      expectConfigError(validEnv({ PEAKET_V0_RATE_PER_SECOND: value }), `속도=${JSON.stringify(value)}`);
    }
    for (const value of ['0', '-3', '1.5', 'abc', 'Infinity']) {
      expectConfigError(validEnv({ PEAKET_V0_RATE_BURST: value }), `버스트=${JSON.stringify(value)}`);
    }
  });

  test('BSL050_포트가_정수가_아니거나_65535를_넘으면_시작하지_않는다', () => {
    for (const name of ['PEAKET_V0_GATEWAY_PORT', 'PEAKET_MANAGEMENT_PORT']) {
      for (const value of ['abc', '-1', '65536', '84.43', '8443abc']) {
        expectConfigError(validEnv({ [name]: value }), `${name}=${value}`);
      }
    }
  });

  test('BSL050_앱_응답_대기는_요청마감_15초보다_길어야_한다', () => {
    for (const value of ['15000', '14999', '1000', '0', 'abc']) {
      expectConfigError(validEnv({ PEAKET_V0_UPSTREAM_TIMEOUT_MS: value }), `대기=${value}`);
    }
  });

  test('BSL050_오류문구에는_어느_비밀값도_싣지_않는다', () => {
    // 비밀이 모두 든 채 다른 이유(운영 환경)로 거절할 때도 문구에 값이 없다
    expectConfigError(validEnv({ PEAKET_ENV: 'prod' }), 'prod');
    // 틀린 칸의 값 자체를 되비추지 않는다
    expectConfigError(validEnv({ PEAKET_V0_UPSTREAM: 'https://v0-monolith-secret.v0.svc:8080' }), 'https 앱 주소');
    expectConfigError(validEnv({ PEAKET_V0_GATEWAY_JWKS: JSON.stringify({ keys: [key.privateJwk] }) }), '개인키 목록');
  });
});
