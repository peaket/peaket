// 팬 취소 재인증 확인기의 시작 조립(R-T39 ⑥, BAT-415-reauth, 시험 담당 l3-b415r-test).
// 정본: docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인'의 '시작 조립'(PEAKET_IDENTITY_FAN_JWKS_URL·PEAKET_IDENTITY_ISSUER.
// 발급자가 없거나 빈 값이면 local·ci만 https://identity.peaket.example이고 그 밖 환경은 시작하지 않는다(리뷰 RV-06 (나)).
// 주소가 없으면 local·ci는 닫힌 대역과 경고, 그 밖 환경은 시작하지 않는다. PEAKET_ENV가 없으면 운영)와 '거절 기록'(리뷰 RV-06 (가)).
// 자주 놓친 결함 '시작 파일 조립은 시험 조립과 따로 본다': 조립 함수를 따로 띄우고, start.ts는 글을 읽어 좌석 Redis의 jti 저장소로 꽂는지 본다.
import { readFileSync } from 'node:fs';
import { fakeClock, RedisReauthJtiStore } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { JwksFanReauthGate } from '../src/modules/refund/index.js';
import { fanReauthGateFromEnv } from '../src/refund-wiring.js';
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

  test('R-T39 ② start.ts는 확인기 조립에 거절 기록을 받는 곳(onResult)을 넘긴다', () => {
    const s = startSource();
    const at = s.indexOf('if (database && ticketGrpcAddr && paymentGrpcAddr)');
    expect(at, '예매 취소 조립 블록').toBeGreaterThan(-1);
    const block = pairFrom(s, at);
    const head = /fanReauthGateFromEnv\(/.exec(block);
    expect(head, '예매 취소 조립 블록 안에서 fanReauthGateFromEnv를 부른다').not.toBeNull();
    const args = pairFrom(block, head!.index + head![0].length - 1, '(', ')');
    expect(args, '거절·확인 못 함 기록을 받는 곳').toMatch(/\bonResult\s*[:,(]/);
  });
});
