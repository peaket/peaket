// 요청 때 세는 판정 피처(docs/features/bot-defense.md §3.2·§4.9, ADR-0251): 기기 공유 수(B-T22), 호스팅·프록시 대역 진입 수(B-T23), 기기 라벨 키 실패(B-T24), 로그인 근거(B-T25).
// 판정 기준값은 합성 값이다(POL-006).
import { describe, expect, test } from 'vitest';
import { type DeviceSignals, type Scorer, SCORER_LIST } from '../src/modules/scoring/domain/scorers.js';
import type { NetClass } from '../src/modules/scoring/domain/types.js';
import { DEVICE_ID, DEVICE_REF, deviceId, EVENT, HUMAN_UA, request, rulesWith, world } from './support.js';

const pid = (n: number) => `pid-${n}`;
/** 공유 수만 보이게 계정 수의 기준을 크게 둔 합성 규칙 */
const ONLY_SHARED = rulesWith({ device: { accountsFrom: 1000, accountsAt: 2000 } });
/** 대역 등급의 위험은 낮게, 진입 수의 기준은 합성 값(1~3) */
const RATE_RULES = rulesWith({ network: { hosting: 0.1, proxy: 0.1, entriesFrom: 1, entriesAt: 3 } });
const ASN = 64512;
const HOSTING = (): NetClass => 'HOSTING';

function spying(): { scorers: readonly Scorer[]; seen: DeviceSignals[] } {
  const seen: DeviceSignals[] = [];
  const scorers = SCORER_LIST.map((s) =>
    s.name === 'DeviceTrust'
      ? {
          ...s,
          score: (i: Parameters<Scorer['score']>[0], p: Parameters<Scorer['score']>[1]) => {
            seen.push(i.device);
            return s.score(i, p);
          },
        }
      : s,
  );
  return { scorers, seen };
}

const LOGIN = { context: 'LOGIN', journeyId: '', eventId: '', pid: '', humanCheckToken: '', shuffle: 'NONE', behavior: undefined } as const;

describe('B-T22 기기 공유 수', () => {
  test('[ASVS v5.0.0-2.4.1] B-T22①_서로다른pid를세고_같은pid는한번이며_기준에닿으면기기기록으로CHALLENGE다', async () => {
    const w = world({ rules: ONLY_SHARED });
    expect(await w.score.run(request({ pid: pid(1) }))).toMatchObject({ verdict: 'ALLOW', degraded: false });
    await w.score.run(request({ pid: pid(1) }));
    expect(w.features.shareCount(DEVICE_REF, EVENT)).toBe(1);
    expect(await w.score.run(request({ pid: pid(2) }))).toMatchObject({ verdict: 'ALLOW' });
    expect(await w.score.run(request({ pid: pid(3) }))).toMatchObject({ verdict: 'CHALLENGE', reason: 'DEVICE_HISTORY', degraded: false });
    expect(w.features.shareCount(DEVICE_REF, EVENT)).toBe(3);
  });

  test.each(['FAILED', 'PENDING'] as const)('[ASVS v5.0.0-2.4.1] B-T22②_사람확인이%s여도집합에넣는다_일부러실패해공유수를피하지못한다', async (result) => {
    const { scorers, seen } = spying();
    const w = world({ rules: ONLY_SHARED, scorers });
    await w.score.run(request({ pid: pid(1) }));
    w.human.set(result);
    await w.score.run(request({ pid: pid(2) }));
    expect(w.features.shareCount(DEVICE_REF, EVENT)).toBe(2);
    expect(seen.at(-1)).toMatchObject({ state: 'READ', shared: 2 });
  });

  test('B-T22②_사람확인토큰이없는요청도넣는다', async () => {
    const w = world({ rules: ONLY_SHARED });
    await w.score.run(request({ humanCheckToken: '' }));
    expect(w.features.shareCount(DEVICE_REF, EVENT)).toBe(1);
  });

  test('B-T22②_사람확인을기다리지않고입력정리단계에서센다_사람확인뒤에는요청경로의Redis호출이없다', async () => {
    const w = world({ rules: ONLY_SHARED });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const verify = w.human.verify;
    w.human.verify = async (r) => {
      await gate;
      return verify(r);
    };
    const pending = w.score.run(request({ pid: pid(1) }));
    await new Promise((r) => setTimeout(r, 0));
    expect(w.features.shareCalls).toBe(1);
    const reads = w.features.readCalls;
    release();
    await pending;
    expect(w.features.readCalls).toBe(reads);
    expect(w.features.shareCalls).toBe(1);
  });

  test('B-T22_회차가다르면따로센다', async () => {
    const w = world({ rules: ONLY_SHARED });
    await w.score.run(request({ pid: pid(1) }));
    await w.score.run(request({ pid: pid(2), eventId: 'ev-2' }));
    expect([w.features.shareCount(DEVICE_REF, EVENT), w.features.shareCount(DEVICE_REF, 'ev-2')]).toEqual([1, 1]);
  });

  test('B-T22_로비입장도센다', async () => {
    const w = world({ rules: ONLY_SHARED });
    await w.score.run(request({ context: 'LOBBY_ENTRY', behavior: undefined }));
    expect(w.features.shareCount(DEVICE_REF, EVENT)).toBe(1);
  });

  test('B-T22⑤_로그인과추가검증제출은세지않는다', async () => {
    const w = world({ rules: ONLY_SHARED });
    await w.score.run(request({ ...LOGIN }));
    await w.score.run(request({ context: 'VERIFICATION', shuffle: 'NONE' }));
    expect(w.features.shareCalls).toBe(0);
  });

  test('B-T22⑤_추가검증을통과해도공유수는그대로이고_같은사람의뒤판정은한번으로센다', async () => {
    const { scorers, seen } = spying();
    const w = world({ rules: ONLY_SHARED, scorers });
    await w.score.run(request({ pid: pid(1) }));
    await w.score.run(request({ pid: pid(2) }));
    expect(await w.score.run(request({ pid: pid(3) }))).toMatchObject({ verdict: 'CHALLENGE', reason: 'DEVICE_HISTORY' });
    expect(await w.score.run(request({ context: 'VERIFICATION', shuffle: 'NONE', pid: pid(3) }))).toMatchObject({ verdict: 'ALLOW' });
    expect(w.features.shareCount(DEVICE_REF, EVENT)).toBe(3);
    await w.score.run(request({ pid: pid(3) }));
    expect(w.features.shareCount(DEVICE_REF, EVENT)).toBe(3);
    expect(seen.at(-1)).toMatchObject({ state: 'READ', shared: 3 });
  });

  test('[ASVS v5.0.0-16.3.4] B-T22⑥_공유수를세지못하면degraded가참이고_지표가오르며_판정은이어진다', async () => {
    const { scorers, seen } = spying();
    const w = world({ rules: ONLY_SHARED, scorers });
    w.features.failFeature('shared');
    const r = await w.score.run(request({ pid: pid(1) }));
    expect(r).toMatchObject({ verdict: 'ALLOW', degraded: true });
    expect(w.signals.seen).toContain('feature:shared');
    expect(seen.at(-1)).toMatchObject({ state: 'READ', shared: undefined });
    expect(w.recorder.records.at(-1)).toMatchObject({ degraded: true });
  });

  test('B-T22⑥_저장소전체가던져도판정은이어지고공유수는실패로센다', async () => {
    const w = world({ rules: ONLY_SHARED });
    w.features.fail(true);
    expect(await w.score.run(request({ pid: pid(1) }))).toMatchObject({ verdict: 'ALLOW', degraded: true });
    expect(w.signals.seen).toContain('feature:shared');
  });

  test('B-T22⑦_기기식별값이없으면세지않고_degraded가아니다', async () => {
    const w = world({ rules: ONLY_SHARED });
    expect(await w.score.run(request({ deviceId: '' }))).toMatchObject({ degraded: false });
    expect(w.features.shareCalls).toBe(0);
    expect(w.signals.seen).not.toContain('feature:shared');
    expect(w.recorder.records.at(-1)).toMatchObject({ refMissing: false });
  });

  test('B-T22_pid가비면세지않는다', async () => {
    const w = world({ rules: ONLY_SHARED });
    await w.score.run(request({ pid: '' }));
    expect(w.features.shareCalls).toBe(0);
  });

  test('B-T22_처음보는기기의첫판정은공유수1이고위험이없다', async () => {
    const { scorers, seen } = spying();
    const w = world({ rules: ONLY_SHARED, scorers });
    await w.score.run(request({ deviceId: deviceId(5) }));
    expect(seen.at(-1)).toMatchObject({ state: 'READ', shared: 1 });
  });
});

describe('B-T23 호스팅·프록시 대역 진입 수', () => {
  test('[ASVS v5.0.0-2.4.1] B-T23①_호스팅대역을10초칸으로세고_수가늘면사유가RAPID_REQUESTS다', async () => {
    const w = world({ rules: RATE_RULES, netClass: HOSTING });
    expect(await w.score.run(request({ pid: pid(1), deviceId: deviceId(1) }))).toMatchObject({ verdict: 'ALLOW', degraded: false });
    expect(await w.score.run(request({ pid: pid(2), deviceId: deviceId(2) }))).toMatchObject({ verdict: 'ALLOW' });
    expect(await w.score.run(request({ pid: pid(3), deviceId: deviceId(3) }))).toMatchObject({ verdict: 'CHALLENGE', reason: 'RAPID_REQUESTS', degraded: false });
    expect(w.features.hostEntries(ASN, EVENT, w.clock.now())).toBe(3);
  });

  test('B-T23①_프록시대역도센다', async () => {
    const w = world({ rules: RATE_RULES, netClass: () => 'PROXY' });
    await w.score.run(request({ context: 'LOBBY_ENTRY', behavior: undefined }));
    expect(w.features.hostEntries(ASN, EVENT, w.clock.now())).toBe(1);
  });

  test('B-T23②_통신사대역과분류표에없는ASN은세지않는다', async () => {
    const w = world({ rules: RATE_RULES, netClass: () => 'OTHER' });
    await w.score.run(request());
    expect(w.features.hostEntries(ASN, EVENT, w.clock.now())).toBe(0);
    expect(w.features.hostEntryCalls).toBe(0);
  });

  test('B-T23③_칸이바뀌면다시센다', async () => {
    const w = world({ rules: RATE_RULES, netClass: HOSTING });
    await w.score.run(request({ pid: pid(1), deviceId: deviceId(1) }));
    await w.score.run(request({ pid: pid(2), deviceId: deviceId(2) }));
    w.clock.advance(10_000);
    await w.score.run(request({ pid: pid(3), deviceId: deviceId(3) }));
    expect(w.features.hostEntries(ASN, EVENT, w.clock.now())).toBe(1);
  });

  test('[ASVS v5.0.0-16.3.4] B-T23⑤_진입수를세지못하면degraded가참이고_대역등급은그대로본다', async () => {
    const w = world({ rules: RATE_RULES, netClass: HOSTING });
    w.features.failFeature('entries');
    expect(await w.score.run(request())).toMatchObject({ verdict: 'ALLOW', degraded: true });
    expect(w.signals.seen).toContain('feature:entries');
  });

  test('B-T23⑥_로그인과추가검증제출은세지않는다', async () => {
    const w = world({ rules: RATE_RULES, netClass: HOSTING });
    await w.score.run(request({ ...LOGIN }));
    await w.score.run(request({ context: 'VERIFICATION', shuffle: 'NONE' }));
    expect(w.features.hostEntryCalls).toBe(0);
  });
});

describe('B-T24 기기 라벨 키를 받지 못할 때', () => {
  test('[ASVS v5.0.0-16.3.4] B-T24②_라벨키가없으면기기칸을비우고refMissing을내며degraded가참이다', async () => {
    const w = world({ deviceRef: () => undefined });
    const r = await w.score.run(request());
    expect(r).toMatchObject({ degraded: true });
    expect(w.recorder.records.at(-1)).toMatchObject({ refMissing: true });
    expect(w.recorder.records.at(-1)?.deviceRef).toBeUndefined();
    expect(w.behaviors.records.at(-1)).toMatchObject({ refMissing: true });
    expect(w.behaviors.records.at(-1)?.deviceRef).toBeUndefined();
    expect(w.signals.seen).toContain('missing:DeviceTrust:dependency');
    expect(w.features.shareCalls).toBe(0);
  });
});

describe('B-T25 로그인 판정의 근거는 기기 이력뿐이다', () => {
  const login = { ...LOGIN, client: { ip: '198.51.100.7', userAgent: HUMAN_UA, clientHints: {}, asn: ASN } };

  test('B-T25_이력없는새기기의로그인은통신사대역ASN이있어도degraded가참이다', async () => {
    const r = await world().score.run(request({ ...login, deviceId: DEVICE_ID }));
    expect(r).toEqual({ verdict: 'ALLOW', degraded: true });
  });

  test('B-T25_이력없는새기기는호스팅대역의위험이기준아래면ALLOW여도degraded가참이다', async () => {
    const r = await world({ rules: RATE_RULES, netClass: HOSTING }).score.run(request({ ...login, deviceId: DEVICE_ID }));
    expect(r).toEqual({ verdict: 'ALLOW', degraded: true });
  });

  test('B-T25_호스팅대역의위험이기준에닿으면이력이없어도CHALLENGE다', async () => {
    const r = await world({ netClass: HOSTING }).score.run(request({ ...login, deviceId: DEVICE_ID }));
    expect(r).toMatchObject({ verdict: 'CHALLENGE', reason: 'NETWORK', degraded: true });
  });

  test('B-T25_브라우저정보일치·세션나이의값도근거로세지않는다', async () => {
    const w = world();
    const r = await w.score.run(request({ ...login, deviceId: DEVICE_ID, client: { ...login.client, clientHints: { 'sec-ch-ua-platform': '"Windows"', 'sec-ch-ua-mobile': '?0' } }, sessionCreatedAtMs: w.clock.now() - 10_000 }));
    expect(r).toEqual({ verdict: 'ALLOW', degraded: true });
  });

  test('B-T25_이력이있는기기는통신사대역이어도근거가있다', async () => {
    const w = world();
    await w.score.run(request({ deviceId: deviceId(9) }));
    await w.flush();
    expect(await w.score.run(request({ ...login, deviceId: deviceId(9) }))).toEqual({ verdict: 'ALLOW', degraded: false });
  });
});
