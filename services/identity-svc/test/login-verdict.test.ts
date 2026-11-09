// 로그인 판정(docs/features/identity.md §7 '로그인 판정의 처리', BUILD_ORDER BOT-050): 판정으로 로그인을 막거나 늦추지 않고, 받지 못하면 UNKNOWN으로 안전 쪽에 둔다(I-T55).
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { DRAIN_TIMEOUT_MS } from '../src/modules/session/application/create-session.js';
import type { LoginRisk, LoginVerdictResult } from '../src/modules/session/domain/ports.js';
import { kit, newKey, testDeviceRefs, type Kit } from './support.js';

const verdict = (r: LoginVerdictResult | (() => Promise<LoginVerdictResult>)): LoginRisk & { seen: Parameters<LoginRisk['score']>[0][] } => {
  const seen: Parameters<LoginRisk['score']>[0][] = [];
  return {
    seen,
    score: async (i) => {
      seen.push(i);
      return typeof r === 'function' ? r() : r;
    },
  };
};

async function setup(risk?: LoginRisk): Promise<{ t: Kit; store: MemorySessionStore }> {
  const store = new MemorySessionStore();
  const t = await kit(store, { clock: fakeClock({ now: Date.parse('2026-11-09T01:00:00.000Z') }), ...(risk ? { loginRisk: risk } : {}) });
  return { t, store };
}

/** 낮음8: 판정은 응답과 떼어 뒤에서 돈다. 시험은 끝나기를 기다린 뒤 본다 */
const settled = async (t: Kit) => t.create.drain();

const login = (t: Kit, o: Partial<Parameters<Kit['create']['run']>[0]> = {}) =>
  t.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'sub-1', email: null, deviceId: 'device-1', userAgent: 'UA-1', clientIp: '198.51.100.7', asn: 64512, ...o });

describe('로그인 판정', () => {
  test('I-T55①_ALLOW는세션에남고사유가없다', async () => {
    const { t, store } = await setup(verdict({ verdict: 'ALLOW' }));
    const s = await login(t);
    await settled(t);
    expect(store.peekSession(s.sessionId)).toMatchObject({ loginVerdict: 'ALLOW', loginVerdictReason: null });
  });

  test('I-T55②_CHALLENGE여도세션을만들고_사유범주를남긴다', async () => {
    const { t, store } = await setup(verdict({ verdict: 'CHALLENGE', reason: 'DEVICE_HISTORY' }));
    const s = await login(t);
    expect(s.accessToken).toBeTruthy();
    await settled(t);
    expect(store.peekSession(s.sessionId)).toMatchObject({ loginVerdict: 'CHALLENGE', loginVerdictReason: 'DEVICE_HISTORY' });
  });

  test('I-T55③_받지못하면세션은만들고UNKNOWN을남긴다', async () => {
    const { t, store } = await setup(verdict({ verdict: 'UNKNOWN' }));
    const s = await login(t);
    await settled(t);
    expect(store.peekSession(s.sessionId)).toMatchObject({ loginVerdict: 'UNKNOWN' });
    expect(t.signals.seen).toContain('verdict:UNKNOWN');
  });

  test('[ASVS v5.0.0-2.4.1] 판정포트가던져도로그인은되고_UNKNOWN이다', async () => {
    const { t, store } = await setup({
      score: async () => {
        throw new Error('연결 끊김');
      },
    });
    const s = await login(t);
    await settled(t);
    expect(store.peekSession(s.sessionId)).toMatchObject({ loginVerdict: 'UNKNOWN' });
    expect(t.signals.seen).toContain('verdict:UNKNOWN');
  });

  test('낮음8_판정을기다리지않고응답을돌려주고_세션은판정이올때까지UNKNOWN이다', async () => {
    let answer!: (v: LoginVerdictResult) => void;
    const slow = new Promise<LoginVerdictResult>((r) => (answer = r));
    const { t, store } = await setup({ score: () => slow });
    const s = await login(t);
    expect(s.accessToken).toBeTruthy();
    expect(store.peekSession(s.sessionId)).toMatchObject({ loginVerdict: 'UNKNOWN' });
    answer({ verdict: 'CHALLENGE', reason: 'NETWORK' });
    await settled(t);
    expect(store.peekSession(s.sessionId)).toMatchObject({ loginVerdict: 'CHALLENGE', loginVerdictReason: 'NETWORK' });
  });

  test('재검토2_지표가던져도처리못한거부가없고_drain이끝난다', async () => {
    const store = new MemorySessionStore();
    const t = await kit(store, { loginRisk: verdict({ verdict: 'ALLOW' }) });
    t.signals.loginVerdict = () => {
      throw new Error('지표 오류');
    };
    await login(t);
    await expect(t.create.drain()).resolves.toBe(true);
  });

  test('재검토2_drain에는시간상한이있어_끝나지않는판정을넘어선다', async () => {
    const { t } = await setup({ score: () => new Promise<LoginVerdictResult>(() => undefined) });
    await login(t);
    await expect(t.create.drain(20)).resolves.toBe(false);
  });

  test('재검토2_drain의기본시간상한은5초다', () => {
    expect(DRAIN_TIMEOUT_MS).toBe(5_000);
  });

  test('판정기록을쓰지못해도로그인은되고_UNKNOWN에머문다', async () => {
    const store = new MemorySessionStore();
    const t = await kit(store, { loginRisk: verdict({ verdict: 'ALLOW' }) });
    const real = store.transaction.bind(store);
    let n = 0;
    store.transaction = (async (fn: Parameters<typeof real>[0]) => {
      n += 1;
      if (n === 2) throw new Error('DB 오류');
      return real(fn);
    }) as typeof store.transaction;
    const s = await login(t);
    await t.create.drain();
    expect(store.peekSession(s.sessionId)).toMatchObject({ loginVerdict: 'UNKNOWN' });
  });

  test('BOT-050_판정에는기기식별값·IP·ASN·UA·계정을넘기고_토큰은없다', async () => {
    const risk = verdict({ verdict: 'ALLOW' });
    const { t } = await setup(risk);
    const s = await login(t);
    await settled(t);
    expect(risk.seen).toEqual([{ accountId: s.accountId, deviceId: 'device-1', clientIp: '198.51.100.7', asn: 64512, userAgent: 'UA-1' }]);
  });

  test('같은멱등키의다시보내기는판정을다시받지않고_처음판정을유지한다', async () => {
    const risk = verdict({ verdict: 'CHALLENGE', reason: 'NETWORK' });
    const { t, store } = await setup(risk);
    const key = newKey();
    const a = await login(t, { idempotencyKey: key });
    await settled(t);
    const b = await login(t, { idempotencyKey: key });
    await settled(t);
    expect(b.sessionId).toBe(a.sessionId);
    expect(risk.seen).toHaveLength(1);
    expect(store.peekSession(a.sessionId)).toMatchObject({ loginVerdict: 'CHALLENGE' });
  });

  test('판정포트가없으면(trust-svc주소가없는환경)세션의판정은UNKNOWN이다', async () => {
    const { t, store } = await setup();
    const s = await login(t);
    expect(store.peekSession(s.sessionId)).toMatchObject({ loginVerdict: 'UNKNOWN' });
  });

  test('시험 도구의 기기 가명이 쓰인다', () => {
    expect(testDeviceRefs().ref('d')).toBeTruthy();
  });
});
