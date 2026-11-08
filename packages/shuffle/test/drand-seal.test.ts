// drand 라운드 계산과 시드 봉인 시험 대역(ADR-0231 결정 6·7·11, docs/features/queue-admission.md §2 '로비 참가와 커밋 공시의 첫 구현')
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { BEACON_MIN_DELAY_MS, DRAND_GENESIS_MS, DRAND_PERIOD_MS, drandRoundAfter, drandRoundTimeMs, TEST_SEAL_ENV, TestSeedSealer } from '../src/index.js';

const vectors = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8')) as {
  drand: { genesisMs: number; periodMs: number; minDelayMs: number; cases: { atMs: number; round: number; timeMs: number }[] };
};

describe('drand 라운드 규칙(참조 구현과 같은 값)', () => {
  test('Q-T27 genesis·주기가 참조 구현과 같다', () => {
    expect([DRAND_GENESIS_MS, DRAND_PERIOD_MS, BEACON_MIN_DELAY_MS]).toEqual([vectors.drand.genesisMs, vectors.drand.periodMs, vectors.drand.minDelayMs]);
  });

  test('Q-T27 라운드와 예정 시각이 독립 참조 구현의 값과 같다', () => {
    expect(vectors.drand.cases.length).toBeGreaterThan(3);
    for (const c of vectors.drand.cases) {
      expect(drandRoundAfter(c.atMs)).toBe(c.round);
      expect(drandRoundTimeMs(c.round)).toBe(c.timeMs);
    }
  });
});

describe('drand quicknet 라운드', () => {
  test('Q-T27_공시라운드는_고정시각+3초이상뒤의첫라운드다', () => {
    const fix = DRAND_GENESIS_MS + 3_000 * 1_000_000 + 500;
    const r = drandRoundAfter(fix);
    expect(drandRoundTimeMs(r)).toBeGreaterThanOrEqual(fix + 3_000);
    // 바로 앞 라운드는 3초를 채우지 못한다
    expect(drandRoundTimeMs(r - 1)).toBeLessThan(fix + 3_000);
  });

  test('Q-T27_고정시각+3초가_라운드시각과딱맞으면_그라운드다', () => {
    const r = 500_000;
    const fix = drandRoundTimeMs(r) - 3_000;
    expect(drandRoundAfter(fix)).toBe(r);
  });

  test('라운드시각은_genesis+(라운드-1)×주기다', () => {
    expect(drandRoundTimeMs(1)).toBe(DRAND_GENESIS_MS);
    expect(drandRoundTimeMs(2)).toBe(DRAND_GENESIS_MS + DRAND_PERIOD_MS);
  });
});

describe('시드 봉인 시험 대역', () => {
  const sealer = new TestSeedSealer(Buffer.alloc(32, 7));
  const seed = Buffer.alloc(32, 9);

  test('[ASVS v5.0.0-11.3.2] 봉인한시드는_같은회차·구간으로만풀린다', async () => {
    const sealed = await sealer.seal('ev-1', 'lobby', seed);
    expect(await sealer.open('ev-1', 'lobby', sealed)).toEqual(seed);
    await expect(sealer.open('ev-2', 'lobby', sealed)).rejects.toThrow();
    await expect(sealer.open('ev-1', 1, sealed)).rejects.toThrow();
  });

  test('[ASVS v5.0.0-11.3.2] 봉인값을바꾸면_풀리지않는다', async () => {
    const sealed = Buffer.from(await sealer.seal('ev-1', 'lobby', seed), 'base64');
    sealed[sealed.length - 1]! ^= 1;
    await expect(sealer.open('ev-1', 'lobby', sealed.toString('base64'))).rejects.toThrow();
  });

  test('local·ci·demo에서만켠다', () => {
    const secret = Buffer.alloc(32, 1).toString('base64');
    expect(TestSeedSealer.fromEnv({ PEAKET_ENV: 'local', [TEST_SEAL_ENV]: secret })).toBeInstanceOf(TestSeedSealer);
    expect(() => TestSeedSealer.fromEnv({ PEAKET_ENV: 'prod', [TEST_SEAL_ENV]: secret })).toThrow();
    expect(() => TestSeedSealer.fromEnv({ PEAKET_ENV: 'local' })).toThrow();
  });
});
