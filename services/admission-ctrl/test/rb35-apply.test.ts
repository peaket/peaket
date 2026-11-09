// RB-35 적용(Q-T27의 CLI 몫, ADR-0239 결정 8~12). 받는 쪽(리더)이 다시 검증하고 지금 상태와 맞을 때만 적용한다.
import { fakeClock } from '@peaket/platform';
import { drandRoundAfter, drandRoundTimeMs } from '@peaket/shuffle';
import { describe, expect, test } from 'vitest';
import { ApplyRb35, MemoryRb35Store, RECOMMIT_MIN_LEAD_MS } from '../src/modules/rb35/index.js';
import { bundleOf, CMD_ID, keysOf, NOW, operator, signedBy } from './rb35-support.js';

const E = 'evt-rb35';
const a = operator('commander-a');
const b = operator('commander-b');
const keys = keysOf(a, b);
const STOP = `${NOW - 1_000}:beacon`;
const COMMIT = 'a'.repeat(64);
const OPENS = NOW - 60_000;
const OLD_ROUND = 8_000_000;

function world(o: { stop?: string | null; round?: number; published?: boolean; opensAtMs?: number; atMs?: number; beacon?: boolean; emergency?: boolean; recommits?: { at: number; prev: number; round: number; reason: string }[]; storeAheadMs?: number } = {}) {
  const clock = fakeClock({ now: NOW });
  const store = new MemoryRb35Store({ now: () => clock.now() + (o.storeAheadMs ?? 0) });
  store.setForTest(E, 'lobby', { stop: o.stop === undefined ? STOP : o.stop, commit: COMMIT, round: o.round ?? OLD_ROUND, published: o.published ?? false, atMs: o.atMs ?? 0, ...(o.beacon ? { beacon: true } : {}), ...(o.emergency ? { emergency: { at: 1, stop: 'beacon', reason: 'x' } } : {}), ...(o.recommits ? { recommits: o.recommits } : {}) });
  store.setSchedule(E, { startsAtMs: NOW + 5 * 86_400_000, opensAtMs: o.opensAtMs ?? OPENS });
  const applied: string[] = [];
  const apply = new ApplyRb35(store, keys, clock, { applied: (c) => applied.push(`${c.command}:${c.signers.join('+')}`), rejected: (c, r) => applied.push(`rejected:${c}:${r}`) });
  const raw = (s: unknown) => JSON.stringify(s);
  return { clock, store, apply, applied, raw };
}

const params = { stop: STOP, commit: COMMIT, round: OLD_ROUND };

describe('ApplyRb35', () => {
  test('Q-T27 비상 셔플은 commander 두 명이 서명하면 멈춤을 풀고 emergency를 쓴다', async () => {
    const { apply, store, applied, raw } = world();
    const r = await apply.run(E, 'lobby', raw(signedBy(bundleOf({ params }), a, b)));
    expect(r).toEqual({ status: 'applied', commandId: CMD_ID });
    expect(store.stateOf(E, 'lobby')).toMatchObject({ stop: null, emergency: { stop: 'beacon', reason: '공개 중계가 모두 응답하지 않음', signed: { bundle: { commandId: CMD_ID }, signatures: [{ signer: 'commander-a' }, { signer: 'commander-b' }] } } });
    expect(store.resultOf(E, CMD_ID)).toBe('applied');
    expect(store.pendingOf(E, 'lobby')).toBeUndefined();
    expect(applied).toEqual(['rb35.emergency-shuffle:commander-a+commander-b']);
  });

  test.each([
    ['서명 하나', () => signedBy(bundleOf({ params }), a), 'two_commanders'],
    ['같은 commander 둘', () => signedBy(bundleOf({ params }), a, a), 'two_commanders'],
  ])('Q-T27 %s는 적용하지 않고 멈춤을 그대로 둔다', async (_n, make, reason) => {
    const { apply, store, raw, applied } = world();
    expect(await apply.run(E, 'lobby', raw(make()))).toEqual({ status: 'rejected', commandId: CMD_ID, reason });
    expect(store.stateOf(E, 'lobby').stop).toBe(STOP);
    expect(store.resultOf(E, CMD_ID)).toBe(`rejected:${reason}`);
    expect(applied).toEqual([`rejected:rb35.emergency-shuffle:${reason}`]);
  });

  test('Q-T27 만료된 묶음은 적용하지 않는다', async () => {
    const { apply, clock, store, raw } = world();
    const s = raw(signedBy(bundleOf({ params }), a, b));
    clock.advance(300_001);
    expect(await apply.run(E, 'lobby', s)).toMatchObject({ status: 'rejected', reason: 'expired' });
    expect(store.stateOf(E, 'lobby').stop).toBe(STOP);
  });

  test('Q-T27 서명 대상과 다른 회차·구간에 넣으면 거절한다', async () => {
    const { apply, store, raw } = world();
    store.setForTest('evt-other', 'lobby', { stop: STOP, commit: COMMIT, round: OLD_ROUND, published: false });
    expect(await apply.run('evt-other', 'lobby', raw(signedBy(bundleOf({ params }), a, b)))).toMatchObject({ status: 'rejected', reason: 'target' });
    expect(await apply.run(E, 1, raw(signedBy(bundleOf({ params }), a, b)))).toMatchObject({ status: 'rejected', reason: 'target' });
  });

  test('Q-T27 같은 묶음을 다시 넣어도(리플레이) 한 번만 적용한다', async () => {
    const { apply, store, raw, applied } = world();
    const s = raw(signedBy(bundleOf({ params }), a, b));
    expect(await apply.run(E, 'lobby', s)).toEqual({ status: 'applied', commandId: CMD_ID });
    store.setForTest(E, 'lobby', { ...store.stateOf(E, 'lobby'), stop: STOP });
    expect(await apply.run(E, 'lobby', s)).toEqual({ status: 'rejected', commandId: CMD_ID, reason: 'replay' });
    expect(store.stateOf(E, 'lobby').stop).toBe(STOP);
    expect(applied).toEqual(['rb35.emergency-shuffle:commander-a+commander-b', 'rejected:rb35.emergency-shuffle:replay']);
  });

  test('Q-T27 묶음이 묶인 멈춤 값이 지금과 다르면 거절한다(서명 뒤 상태가 바뀜)', async () => {
    const { apply, store, raw } = world({ stop: `${NOW + 5}:beacon` });
    expect(await apply.run(E, 'lobby', raw(signedBy(bundleOf({ params }), a, b)))).toMatchObject({ status: 'rejected', reason: 'stale_state' });
    expect(store.stateOf(E, 'lobby').emergency).toBeUndefined();
  });

  test('Q-T27 이미 게시한 구간은 비상 셔플을 받지 않는다', async () => {
    const { apply, raw } = world({ published: true });
    expect(await apply.run(E, 'lobby', raw(signedBy(bundleOf({ params }), a, b)))).toMatchObject({ status: 'rejected', reason: 'published' });
  });

  test.each(['no_commit', 'members_changed', 'unknown', 'stale_round', 'late_commit', 'late_root', 'unauthorized', 'seed_unavailable'])('Q-T27 %s로 멈춘 구간은 비상 셔플로 풀지 않는다', async (why) => {
    const stop = `${NOW - 1_000}:${why}`;
    const { apply, store, raw } = world({ stop });
    expect(await apply.run(E, 'lobby', raw(signedBy(bundleOf({ params: { ...params, stop } }), a, b)))).toMatchObject({ status: 'rejected', reason: 'not_eligible' });
    expect(store.stateOf(E, 'lobby').stop).toBe(stop);
  });

  test.each(['beacon'])('Q-T27 %s로 멈춘 구간은 비상 셔플을 받는다', async (why) => {
    const stop = `${NOW - 1_000}:${why}`;
    const { apply, store, raw } = world({ stop });
    expect(await apply.run(E, 'lobby', raw(signedBy(bundleOf({ params: { ...params, stop } }), a, b)))).toMatchObject({ status: 'applied' });
    expect(store.stateOf(E, 'lobby').emergency?.stop).toBe(why);
  });

  test('Q-T27 실제 비콘을 기록한 구간은 받지 않는다(M1)', async () => {
    const { apply, store, raw } = world({ beacon: true });
    expect(await apply.run(E, 'lobby', raw(signedBy(bundleOf({ params }), a, b)))).toMatchObject({ status: 'rejected', reason: 'beacon_recorded' });
    expect(store.stateOf(E, 'lobby').stop).toBe(STOP);
  });

  test('Q-T27 비콘을 기록한 구간도 더 기다리기는 받는다(영구 정지를 막는다)', async () => {
    const { apply, store, raw } = world({ beacon: true });
    expect(await apply.run(E, 'lobby', raw(signedBy(bundleOf({ command: 'rb35.wait', params: { ...params, extendSec: 120 } }), a, b)))).toMatchObject({ status: 'applied' });
    expect(store.stateOf(E, 'lobby')).toMatchObject({ stop: null, waitUntilMs: NOW + 120_000 });
  });

  test('Q-T27 사유 칸이 깨진 묶음은 모양에서 거절한다', async () => {
    const { apply, store } = world();
    expect(await apply.run(E, 'lobby', '{"not":"a bundle"}')).toEqual({ status: 'rejected', commandId: null, reason: 'shape' });
    expect(store.pendingOf(E, 'lobby')).toBeUndefined();
  });

  describe('더 기다리기', () => {
    const wait = (extendSec: number) => bundleOf({ command: 'rb35.wait', params: { ...params, extendSec } });

    test('Q-T27 beacon 멈춤을 풀고 저장소 시각 + extendSec까지 기다린다', async () => {
      const { apply, store, raw } = world();
      expect(await apply.run(E, 'lobby', raw(signedBy(wait(120), a, b)))).toMatchObject({ status: 'applied' });
      expect(store.stateOf(E, 'lobby')).toMatchObject({ stop: null, waitUntilMs: NOW + 120_000 });
      expect(store.stateOf(E, 'lobby').emergency).toBeUndefined();
    });

    test('Q-T27 시드를 풀지 못해 멈춘 구간(seed_unavailable)도 더 기다릴 수 있다', async () => {
      const stop = `${NOW}:seed_unavailable`;
      const { apply, store, raw } = world({ stop });
      expect(await apply.run(E, 'lobby', raw(signedBy(bundleOf({ command: 'rb35.wait', params: { ...params, stop, extendSec: 120 } }), a, b)))).toMatchObject({ status: 'applied' });
      expect(store.stateOf(E, 'lobby').stop).toBeNull();
    });

    test.each(['stale_round', 'late_commit', 'late_root'])('Q-T27 %s로 멈춘 구간은 기다려도 풀리지 않아 거절한다', async (why) => {
      const stop = `${NOW}:${why}`;
      const { apply, raw } = world({ stop });
      expect(await apply.run(E, 'lobby', raw(signedBy(bundleOf({ command: 'rb35.wait', params: { ...params, stop, extendSec: 120 } }), a, b)))).toMatchObject({ status: 'rejected', reason: 'not_eligible' });
    });

    test.each([29, 601])('Q-T27 extendSec가 범위 밖이면(%s) 거절한다', async (sec) => {
      const { apply, raw } = world();
      expect(await apply.run(E, 'lobby', raw(signedBy(wait(sec), a, b)))).toMatchObject({ status: 'rejected', reason: 'shape' });
    });

    test('Q-T27 extendSec가 정수가 아니면 거절한다', async () => {
      const { apply, raw } = world();
      const s = signedBy(wait(120), a, b);
      expect(await apply.run(E, 'lobby', raw({ ...s, bundle: { ...s.bundle, params: { ...s.bundle.params, extendSec: 1.5 } } }))).toMatchObject({ status: 'rejected', reason: 'shape' });
    });

    test('Q-T27 멈추지 않은 구간은 더 기다리기를 받지 않는다(멈춤 값이 없다)', async () => {
      const { apply, raw } = world({ stop: null });
      expect(await apply.run(E, 'lobby', raw(signedBy(wait(120), a, b)))).toMatchObject({ status: 'rejected', reason: 'stale_state' });
    });
  });

  describe('커밋 다시 공시(ADR-0231 결정 13, ADR-0239 결정 12)', () => {
    const stop = `${NOW - 1_000}:stale_round`;
    /** ADR의 공식: 목록 고정 뒤의 첫 라운드와 묶음 만료 + 30초 뒤의 첫 라운드 중 늦은 쪽(bundleOf의 만료는 NOW + 5분) */
    const formula = (opens: number) => Math.max(drandRoundAfter(opens), drandRoundAfter(NOW + 300_000, RECOMMIT_MIN_LEAD_MS));
    const R_NEW = formula(OPENS);
    const recommit = (newRound: number, extra: Partial<Omit<typeof params, 'stop'>> & { stop?: string | null } = {}) => bundleOf({ command: 'rb35.recommit', params: { ...params, stop, ...extra, newRound } });
    /** 아직 공개 전인 라운드 */
    const FUTURE_ROUND = drandRoundAfter(NOW + 600_000);

    test('Q-T27 라운드를 바꾸고 멈춤을 풀며 이력을 남긴다(커밋·시드는 그대로)', async () => {
      const { apply, store, raw } = world({ stop });
      expect(await apply.run(E, 'lobby', raw(signedBy(recommit(R_NEW), a, b)))).toMatchObject({ status: 'applied' });
      expect(store.stateOf(E, 'lobby')).toMatchObject({ stop: null, round: R_NEW, commit: COMMIT, recommits: [{ at: NOW, prev: OLD_ROUND, round: R_NEW, reason: '공개 중계가 모두 응답하지 않음', signed: { bundle: { commandId: CMD_ID } } }] });
    });

    test('Q-T27 멈추기 전이어도 공시 라운드가 지금 일정과 다르면 받는다', async () => {
      const opensAtMs = NOW + 3_600_000;
      const { apply, store, raw } = world({ stop: null, opensAtMs, round: FUTURE_ROUND });
      const newRound = formula(opensAtMs);
      expect(await apply.run(E, 'lobby', raw(signedBy(bundleOf({ command: 'rb35.recommit', params: { ...params, stop: null, round: FUTURE_ROUND, newRound } }), a, b)))).toMatchObject({ status: 'applied' });
      expect(store.stateOf(E, 'lobby').round).toBe(newRound);
    });

    test('Q-T27 공시 라운드가 지금 일정과 같으면 다시 공시할 일이 없다', async () => {
      const opensAtMs = NOW + 3_600_000;
      const round = drandRoundAfter(opensAtMs);
      const { apply, raw } = world({ stop: null, opensAtMs, round });
      expect(await apply.run(E, 'lobby', raw(signedBy(bundleOf({ command: 'rb35.recommit', params: { ...params, stop: null, round, newRound: formula(opensAtMs) } }), a, b)))).toMatchObject({ status: 'rejected', reason: 'not_eligible' });
    });

    test('Q-T27 beacon 멈춤은 다시 공시로 풀지 않는다', async () => {
      const { apply, raw } = world();
      expect(await apply.run(E, 'lobby', raw(signedBy(recommit(R_NEW, { stop: STOP }), a, b)))).toMatchObject({ status: 'rejected', reason: 'not_eligible' });
    });

    test.each(['late_commit', 'late_root'])('Q-T27 %s로 멈춘 구간은 커밋 뒤의 새 라운드로 다시 공시할 수 있다(M2)', async (why) => {
      const s2 = `${NOW}:${why}`;
      const { apply, store, raw } = world({ stop: s2, atMs: NOW - 10_000 });
      expect(await apply.run(E, 'lobby', raw(signedBy(recommit(R_NEW, { stop: s2 }), a, b)))).toMatchObject({ status: 'applied' });
      expect(store.stateOf(E, 'lobby').round).toBe(R_NEW);
    });

    test('Q-T27 새 라운드가 커밋 + 3초보다 앞서면 저장소에서 거절한다(M2)', async () => {
      const s2 = `${NOW}:late_commit`;
      const { apply, store, raw } = world({ stop: s2, atMs: drandRoundTimeMs(R_NEW) - 2_999 });
      expect(await apply.run(E, 'lobby', raw(signedBy(recommit(R_NEW, { stop: s2 }), a, b)))).toMatchObject({ status: 'rejected', reason: 'too_late' });
      expect(store.stateOf(E, 'lobby').stop).toBe(s2);
    });

    test('Q-T27 새 라운드가 저장소 시각으로 30초 안이면 거절한다', async () => {
      const { apply, raw } = world({ stop, storeAheadMs: drandRoundTimeMs(R_NEW) - RECOMMIT_MIN_LEAD_MS + 1 - NOW });
      expect(await apply.run(E, 'lobby', raw(signedBy(recommit(R_NEW), a, b)))).toMatchObject({ status: 'rejected', reason: 'too_late' });
    });

    test('Q-T27 새 라운드는 ADR의 공식과 같아야 한다(더 뒤의 라운드도 고를 수 없다)', async () => {
      const { apply, raw } = world({ stop });
      expect(await apply.run(E, 'lobby', raw(signedBy(recommit(R_NEW + 1), a, b)))).toMatchObject({ status: 'rejected', reason: 'not_eligible' });
      expect(await apply.run(E, 'lobby', raw(signedBy(recommit(R_NEW - 1), a, b)))).toMatchObject({ status: 'rejected', reason: 'not_eligible' });
    });

    test('Q-T27 새 라운드가 목록 고정보다 앞서면 거절한다', async () => {
      const { apply, raw } = world({ stop, opensAtMs: NOW + 3_600_000 });
      expect(await apply.run(E, 'lobby', raw(signedBy(recommit(R_NEW), a, b)))).toMatchObject({ status: 'rejected', reason: 'not_eligible' });
    });

    test('Q-T27 stale_round로 멈춘 구간은 비상 셔플을 거절하고 같은 구간의 다시 공시는 받는다', async () => {
      const { apply, store, raw } = world({ stop });
      const emergencyBundle = bundleOf({ commandId: '01957f5a-0000-7000-8000-000000000011', params: { ...params, stop } });
      expect(await apply.run(E, 'lobby', raw(signedBy(emergencyBundle, a, b)))).toMatchObject({ status: 'rejected', reason: 'not_eligible' });
      expect(store.stateOf(E, 'lobby')).toMatchObject({ stop });
      expect(store.stateOf(E, 'lobby').emergency).toBeUndefined();
      expect(await apply.run(E, 'lobby', raw(signedBy(recommit(R_NEW), a, b)))).toMatchObject({ status: 'applied' });
      expect(store.stateOf(E, 'lobby')).toMatchObject({ stop: null, round: R_NEW });
    });

    test('Q-T27 실제 비콘을 기록한 구간은 다시 공시를 받지 않는다', async () => {
      const { apply, store, raw } = world({ stop, beacon: true });
      expect(await apply.run(E, 'lobby', raw(signedBy(recommit(R_NEW), a, b)))).toMatchObject({ status: 'rejected', reason: 'beacon_recorded' });
      expect(store.stateOf(E, 'lobby').stop).toBe(stop);
    });

    describe('다시 뽑기를 막는다(H2)', () => {
      const scheduled = drandRoundAfter(OPENS);

      test('Q-T27 멈추기 전에는 지금 라운드가 이미 공개됐으면 거절한다', async () => {
        const R1 = drandRoundAfter(NOW, -3_000 - 1_000);
        expect(drandRoundTimeMs(R1)).toBeLessThanOrEqual(NOW);
        const { apply, store, raw } = world({ stop: null, round: R1 });
        expect(await apply.run(E, 'lobby', raw(signedBy(recommit(R_NEW, { stop: null, round: R1 }), a, b)))).toMatchObject({ status: 'rejected', reason: 'round_public' });
        expect(store.stateOf(E, 'lobby').round).toBe(R1);
      });

      test('Q-T27 공개까지 3초 안이면 공개된 것으로 본다', async () => {
        const R1 = drandRoundAfter(NOW, -1_000);
        expect(drandRoundTimeMs(R1) - NOW).toBeLessThanOrEqual(3_000);
        const { apply, raw } = world({ stop: null, round: R1 });
        expect(await apply.run(E, 'lobby', raw(signedBy(recommit(R_NEW, { stop: null, round: R1 }), a, b)))).toMatchObject({ status: 'rejected', reason: 'round_public' });
      });

      test('Q-T27 공개까지 정확히 3초 남았으면 받고, 그보다 적으면 거절한다', async () => {
        const R1 = drandRoundAfter(NOW, 10_000);
        const atThree = drandRoundTimeMs(R1) - 3_000 - NOW;
        const yes = world({ stop: null, round: R1, storeAheadMs: atThree });
        expect(await yes.apply.run(E, 'lobby', yes.raw(signedBy(recommit(R_NEW, { stop: null, round: R1 }), a, b)))).toMatchObject({ status: 'applied' });
        const no = world({ stop: null, round: R1, storeAheadMs: atThree + 1 });
        expect(await no.apply.run(E, 'lobby', no.raw(signedBy(recommit(R_NEW, { stop: null, round: R1 }), a, b)))).toMatchObject({ status: 'rejected', reason: 'round_public' });
      });

      test('Q-T27 일정이 바뀌지 않았으면 두 번째 다시 공시를 받지 않는다', async () => {
        const R1 = FUTURE_ROUND;
        expect(R1).toBeGreaterThan(scheduled);
        const { apply, store, raw } = world({ stop: null, round: R1, recommits: [{ at: NOW - 100, prev: OLD_ROUND, round: R1, reason: 'x' }] });
        expect(await apply.run(E, 'lobby', raw(signedBy(recommit(R_NEW, { stop: null, round: R1 }), a, b)))).toMatchObject({ status: 'rejected', reason: 'already_recommitted' });
        expect(store.stateOf(E, 'lobby').round).toBe(R1);
      });

      test('Q-T27 일정이 다시 뒤로 밀렸으면(라운드 < 지금 일정) 두 번째 다시 공시를 받는다', async () => {
        const R1 = FUTURE_ROUND;
        const opensAtMs = drandRoundTimeMs(R1) + 60_000;
        const { apply, store, raw } = world({ stop: null, round: R1, opensAtMs, recommits: [{ at: NOW - 100, prev: OLD_ROUND, round: R1, reason: 'x' }] });
        const newRound = formula(opensAtMs);
        expect(await apply.run(E, 'lobby', raw(signedBy(bundleOf({ command: 'rb35.recommit', params: { ...params, stop: null, round: R1, newRound } }), a, b)))).toMatchObject({ status: 'applied' });
        expect(store.stateOf(E, 'lobby').recommits).toHaveLength(2);
      });

      test('Q-T27 비상 셔플을 허가한 구간은 다시 공시를 받지 않는다', async () => {
        const { apply, raw } = world({ stop, emergency: true });
        expect(await apply.run(E, 'lobby', raw(signedBy(recommit(R_NEW), a, b)))).toMatchObject({ status: 'rejected', reason: 'already_emergency' });
      });
    });
  });
});
