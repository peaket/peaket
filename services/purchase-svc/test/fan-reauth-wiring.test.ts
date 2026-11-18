// 팬 취소 재인증 확인기의 시작 조립(R-T39 ⑥, BAT-415-reauth, 시험 담당 l3-b415r-test).
// 정본: docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인'의 '시작 조립'(PEAKET_IDENTITY_FAN_JWKS_URL·PEAKET_IDENTITY_ISSUER.
// 발급자가 없거나 빈 값이면 local·ci만 https://identity.peaket.example이고 그 밖 환경은 시작하지 않는다(리뷰 RV-06 (나)).
// 주소가 없으면 local·ci는 닫힌 대역과 경고, 그 밖 환경은 시작하지 않는다. PEAKET_ENV가 없으면 운영)와 '거절 기록'(리뷰 RV-06 (가)).
// 자주 놓친 결함 '시작 파일 조립은 시험 조립과 따로 본다': 조립 함수를 따로 띄우고, start.ts는 글을 읽어 좌석 Redis의 jti 저장소로 꽂는지 본다.
// 거절 기록을 로그로 잇는 함수(fanReauthResultLogger, 리뷰 다시 보기 RN-03·고친 곳 검증 L7)는 가짜 로거로 403 info·503 warn 한 줄씩을 본다.
import { readFileSync } from 'node:fs';
import { fakeClock, RedisReauthJtiStore } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { JwksFanReauthGate, type FanReauthResult } from '../src/modules/refund/index.js';
import { fanReauthGateFromEnv, fanReauthResultLogger } from '../src/refund-wiring.js';
import { DEFAULT_ISS, fakeJwksFetch, fakeSeatRedis, fanKey, ISS, reauthClaims, signReauth } from './fan-reauth-fixtures.js';

const NOW = Date.parse('2026-11-13T10:00:00+09:00');
const ACCOUNT = '0193a300-0000-7000-8000-000000000001';
const LOGIN = '0193a300-0000-7000-8000-000000000002';
const ENV_URL = 'https://identity.internal.test/internal/jwks/fan.json';
const fan = fanKey('fan-w1');
const NOT_STUB_ENVS: (string | undefined)[] = ['prod', 'production', 'staging', 'demo', undefined];

const envOf = (peaketEnv: string | undefined, more: Record<string, string | undefined> = {}) => ({ ...(peaketEnv !== undefined ? { PEAKET_ENV: peaketEnv } : {}), ...more });

describe('팬 취소 재인증 시작 조립 [BAT-415-reauth]', () => {
  test('R-T39 ⑥ 팬 공개키 묶음 주소 없이는 운영에서 시작하지 않는다', () => {
    for (const url of [undefined, '']) {
      for (const peaketEnv of NOT_STUB_ENVS) {
        const what = `PEAKET_ENV=${peaketEnv ?? '(없음)'}, 주소=${url === undefined ? '(없음)' : '빈 값'}`;
        const warns: string[] = [];
        expect(
          () => fanReauthGateFromEnv({ env: envOf(peaketEnv, url !== undefined ? { PEAKET_IDENTITY_FAN_JWKS_URL: url } : {}), jti: new RedisReauthJtiStore(fakeSeatRedis()), warn: (m) => void warns.push(m) }),
          what,
        ).toThrow(/PEAKET_IDENTITY_FAN_JWKS_URL/);
      }
    }
  });

  test('R-T39 ⑥ 주소가 없으면 local·ci만 닫힌 대역(undefined)이고 경고를 한 번 남긴다', () => {
    for (const url of [undefined, '']) {
      for (const peaketEnv of ['local', 'ci']) {
        const what = `${peaketEnv}, 주소=${url === undefined ? '(없음)' : '빈 값'}`;
        const warns: string[] = [];
        const got = fanReauthGateFromEnv({ env: envOf(peaketEnv, url !== undefined ? { PEAKET_IDENTITY_FAN_JWKS_URL: url } : {}), jti: new RedisReauthJtiStore(fakeSeatRedis()), warn: (m) => void warns.push(m) });
        expect(got, what).toBeUndefined();
        expect(warns, what).toHaveLength(1);
      }
    }
  });

  test('R-T39 ⑥ 주소가 있으면 환경과 무관하게 확인기를 만들고 그 주소에서 팬 공개키 묶음을 읽는다', async () => {
    for (const peaketEnv of [...NOT_STUB_ENVS, 'local', 'ci']) {
      const what = `PEAKET_ENV=${peaketEnv ?? '(없음)'}`;
      const jwks = fakeJwksFetch([fan]);
      const warns: string[] = [];
      const gate = fanReauthGateFromEnv({
        env: envOf(peaketEnv, { PEAKET_IDENTITY_FAN_JWKS_URL: ENV_URL, PEAKET_IDENTITY_ISSUER: ISS }),
        jti: new RedisReauthJtiStore(fakeSeatRedis()),
        warn: (m) => void warns.push(m),
        clock: fakeClock({ now: NOW }),
        fetch: jwks.fetch,
      });
      expect(gate, what).toBeInstanceOf(JwksFanReauthGate);
      expect(warns, what).toHaveLength(0);
      const t = signReauth(fan, reauthClaims({ nowMs: NOW, accountId: ACCOUNT, sessionId: LOGIN }));
      expect(await gate!.verify(t, { accountId: ACCOUNT, sessionId: LOGIN, act: 'FAN_SENSITIVE' }), what).toBe(true);
      expect(jwks.urls, what).toEqual([ENV_URL]);
    }
  });

  test('R-T39 ⑥ local·ci에서 PEAKET_IDENTITY_ISSUER가 없으면 발급자 https://identity.peaket.example만 받고, 있으면 그 값만 받는다', async () => {
    const accepts = async (env: Record<string, string>, iss: string) => {
      const gate = fanReauthGateFromEnv({ env, jti: new RedisReauthJtiStore(fakeSeatRedis()), clock: fakeClock({ now: NOW }), fetch: fakeJwksFetch([fan]).fetch });
      const t = signReauth(fan, reauthClaims({ nowMs: NOW, accountId: ACCOUNT, sessionId: LOGIN }, { iss }));
      return gate!.verify(t, { accountId: ACCOUNT, sessionId: LOGIN, act: 'FAN_SENSITIVE' });
    };
    for (const peaketEnv of ['local', 'ci']) {
      for (const issuer of [undefined, '']) {
        const what = `${peaketEnv}, 발급자=${issuer === undefined ? '(없음)' : '빈 값'}`;
        const noIssuer: Record<string, string> = { PEAKET_ENV: peaketEnv, PEAKET_IDENTITY_FAN_JWKS_URL: ENV_URL, ...(issuer !== undefined ? { PEAKET_IDENTITY_ISSUER: issuer } : {}) };
        expect(await accepts(noIssuer, DEFAULT_ISS), what).toBe(true);
        expect(await accepts(noIssuer, ISS), what).toBe(false);
      }
      const withIssuer = { PEAKET_ENV: peaketEnv, PEAKET_IDENTITY_FAN_JWKS_URL: ENV_URL, PEAKET_IDENTITY_ISSUER: ISS };
      expect(await accepts(withIssuer, ISS), peaketEnv).toBe(true);
      expect(await accepts(withIssuer, DEFAULT_ISS), peaketEnv).toBe(false);
    }
  });

  test('R-T39 ⑥ 주소는 있고 PEAKET_IDENTITY_ISSUER가 없으면 운영에서 시작하지 않는다', () => {
    for (const issuer of [undefined, '']) {
      for (const peaketEnv of NOT_STUB_ENVS) {
        const what = `PEAKET_ENV=${peaketEnv ?? '(없음)'}, 발급자=${issuer === undefined ? '(없음)' : '빈 값'}`;
        expect(
          () =>
            fanReauthGateFromEnv({
              env: envOf(peaketEnv, { PEAKET_IDENTITY_FAN_JWKS_URL: ENV_URL, ...(issuer !== undefined ? { PEAKET_IDENTITY_ISSUER: issuer } : {}) }),
              jti: new RedisReauthJtiStore(fakeSeatRedis()),
              warn: () => undefined,
            }),
          what,
        ).toThrow(/PEAKET_IDENTITY_ISSUER/);
      }
    }
  });

  test('R-T39 ② fanReauthGateFromEnv는 거절 기록을 받는 곳(onResult)을 확인기에 넘긴다', async () => {
    const results: unknown[] = [];
    const gate = fanReauthGateFromEnv({
      env: { PEAKET_ENV: 'prod', PEAKET_IDENTITY_FAN_JWKS_URL: ENV_URL, PEAKET_IDENTITY_ISSUER: ISS },
      jti: new RedisReauthJtiStore(fakeSeatRedis()),
      clock: fakeClock({ now: NOW }),
      fetch: fakeJwksFetch([fan]).fetch,
      onResult: (r: unknown) => void results.push(r),
    });
    const other = '0193a300-0000-7000-8000-0000000000ff';
    const t = signReauth(fan, reauthClaims({ nowMs: NOW, accountId: other, sessionId: LOGIN }));
    expect(await gate!.verify(t, { accountId: ACCOUNT, sessionId: LOGIN, act: 'FAN_SENSITIVE' })).toBe(false);
    expect(results).toEqual([{ outcome: 'rejected', reason: 'sub' }]);
  });
});

/** 주석을 뺀 시작 파일 */
const startSource = (): string =>
  readFileSync(new URL('../src/start.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** at 뒤 첫 open 글자와 짝인 close 글자까지 */
function pairFrom(s: string, at: number, open = '{', close = '}'): string {
  const from = s.indexOf(open, at);
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return s.slice(from, i + 1);
  }
  throw new Error('짝이 닫히지 않는다');
}

describe('start.ts 팬 취소 재인증 조립 [BAT-415-reauth]', () => {
  test('R-T39 ⑥ start.ts는 좌석 Redis의 jti 저장소로 확인기를 만들어 예매 취소 조립에 넣는다', () => {
    const s = startSource();
    expect(s, '좌석 Redis').toMatch(/const redis = await createHotRedis\(/);
    const at = s.indexOf('if (database && ticketGrpcAddr && paymentGrpcAddr)');
    expect(at, '예매 취소 조립 블록').toBeGreaterThan(-1);
    const block = pairFrom(s, at);
    const head = /const (\w+) = fanReauthGateFromEnv\(/.exec(block);
    expect(head, '예매 취소 조립 블록 안에서 fanReauthGateFromEnv를 부른다').not.toBeNull();
    const name = head![1]!;
    const args = pairFrom(block, head!.index + head![0].length - 1, '(', ')');
    expect(args, '좌석 Redis의 RedisReauthJtiStore').toMatch(/\bjti\s*:\s*new RedisReauthJtiStore\(redis\)/);
    expect(args).not.toMatch(/MemoryReauthJtiStore|UnavailableReauthJtiStore|reauthJtiStoreFromEnv/);
    expect(args, '시작 환경을 넘긴다').toMatch(/(^|[\s,{])env(\s*[,}]|\s*:\s*env\b|\s*$)/);
    expect(args, '경고를 받는다').toMatch(/\bwarn\s*:/);
    const refundObj = block.slice(block.indexOf('refund = {'));
    expect(refundObj, '결과를 refund.reauth로 넣는다').toMatch(new RegExp(`\\breauth\\s*:\\s*${name}\\b`));
    expect(s).not.toMatch(/reauthJtiStoreFromEnv\(/);
  });

  test('R-T39 ② start.ts는 확인기 조립의 onResult로 fanReauthResultLogger를 넘긴다', () => {
    const s = startSource();
    const at = s.indexOf('if (database && ticketGrpcAddr && paymentGrpcAddr)');
    expect(at, '예매 취소 조립 블록').toBeGreaterThan(-1);
    const block = pairFrom(s, at);
    const head = /fanReauthGateFromEnv\(/.exec(block);
    expect(head, '예매 취소 조립 블록 안에서 fanReauthGateFromEnv를 부른다').not.toBeNull();
    const args = pairFrom(block, head!.index + head![0].length - 1, '(', ')');
    // 리뷰 다시 보기 RN-03·고친 곳 검증 L7: 로그로 잇는 몸체를 start.ts에 두지 않고 이름 붙인 함수를 넘긴다(그 함수는 아래에서 가짜 로거로 본다)
    expect(args, 'onResult: fanReauthResultLogger(…)').toMatch(/\bonResult\s*:\s*fanReauthResultLogger\(/);
  });
});

/** 로거 호출을 적는 가짜 로거(인자 전부를 적는다) */
function fakeLog() {
  const calls: { level: 'info' | 'warn'; args: unknown[] }[] = [];
  return {
    calls,
    info: (...args: unknown[]) => void calls.push({ level: 'info', args }),
    warn: (...args: unknown[]) => void calls.push({ level: 'warn', args }),
  };
}

describe('팬 취소 재인증 거절 기록을 로그로 잇기 [BAT-415-reauth]', () => {
  // 정본 §3.1 '거절 기록'의 이름표(403은 info, 503은 warn)
  const REJECT_REASONS = ['missing', 'format', 'alg', 'kid', 'signature', 'typ', 'iss', 'aud', 'expired', 'claims', 'sub', 'lifetime', 'replay'] as const;
  const UNAVAILABLE_REASONS = ['keys', 'store'] as const;
  // 넘긴 값에 비밀이 섞여 와도 로그 줄에 옮기지 않는지 보려고, 결과에 형 밖의 칸을 얹어 넘긴다
  const SECRETS = { token: 'eyJhbGciOiJFUzI1NiJ9.secret-token.sig', jti: 'jti-secret-0193', accountId: ACCOUNT, sessionId: LOGIN };

  const lineOk = (args: unknown[], reason: string, what: string) => {
    const fields = args[0] as Record<string, unknown>;
    expect(typeof fields === 'object' && fields !== null, `${what}: 첫 인자는 필드 객체`).toBe(true);
    expect(fields.reason, what).toBe(reason);
    // 정본이 정한 칸은 까닭 하나다. 사건 이름(event)만 더 둘 수 있다
    for (const k of Object.keys(fields)) expect(['reason', 'event'], `${what}: 칸 ${k}`).toContain(k);
    if ('event' in fields) expect(typeof fields.event, `${what}: event`).toBe('string');
    const text = JSON.stringify(args);
    for (const v of Object.values(SECRETS)) expect(text.includes(v), `${what}: 토큰·jti·계정·세션 ID가 없다`).toBe(false);
  };

  test('R-T39 ② fanReauthResultLogger는 403을 info 한 줄, 503을 warn 한 줄로 남기고 까닭 이름표 말고는 싣지 않는다', () => {
    for (const reason of REJECT_REASONS) {
      const log = fakeLog();
      fanReauthResultLogger(log)({ outcome: 'rejected', reason, ...SECRETS } as FanReauthResult);
      expect(log.calls.map((c) => c.level), `rejected ${reason}`).toEqual(['info']);
      lineOk(log.calls[0]!.args, reason, `rejected ${reason}`);
    }
    for (const reason of UNAVAILABLE_REASONS) {
      const log = fakeLog();
      fanReauthResultLogger(log)({ outcome: 'unavailable', reason, ...SECRETS } as FanReauthResult);
      expect(log.calls.map((c) => c.level), `unavailable ${reason}`).toEqual(['warn']);
      lineOk(log.calls[0]!.args, reason, `unavailable ${reason}`);
    }
  });

  test('R-T39 ② 실제 확인기의 거절과 확인 못 함이 fanReauthResultLogger를 거쳐 info·warn 한 줄씩 남는다', async () => {
    const log = fakeLog();
    const redis = fakeSeatRedis();
    const gate = fanReauthGateFromEnv({
      env: { PEAKET_ENV: 'prod', PEAKET_IDENTITY_FAN_JWKS_URL: ENV_URL, PEAKET_IDENTITY_ISSUER: ISS },
      jti: new RedisReauthJtiStore(redis),
      clock: fakeClock({ now: NOW }),
      fetch: fakeJwksFetch([fan]).fetch,
      onResult: fanReauthResultLogger(log),
    })!;
    const q = { accountId: ACCOUNT, sessionId: LOGIN, act: 'FAN_SENSITIVE' } as const;
    const other = '0193a300-0000-7000-8000-0000000000ff';
    const t = signReauth(fan, reauthClaims({ nowMs: NOW, accountId: other, sessionId: LOGIN }));
    expect(await gate.verify(t, q)).toBe(false);
    expect(log.calls.map((c) => c.level)).toEqual(['info']);
    lineOk(log.calls[0]!.args, 'sub', '다른 계정');
    expect(JSON.stringify(log.calls).includes(t), '토큰이 없다').toBe(false);
    expect(JSON.stringify(log.calls).includes(other), '토큰의 계정 ID가 없다').toBe(false);

    log.calls.length = 0;
    redis.mode = 'throw';
    const claims = reauthClaims({ nowMs: NOW, accountId: ACCOUNT, sessionId: LOGIN });
    await expect(gate.verify(signReauth(fan, claims), q)).rejects.toThrow();
    expect(log.calls.map((c) => c.level)).toEqual(['warn']);
    lineOk(log.calls[0]!.args, 'store', 'jti 저장소 오류');
    expect(JSON.stringify(log.calls).includes(claims.jti as string), 'jti가 없다').toBe(false);
  });
});
