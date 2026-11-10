// 점수기 목록 파이프라인(docs/features/bot-defense.md §4, 시험 B-T1·B-T2·B-T3·B-T11·B-T17). 판정 기준값과 가중치는 합성 값이다(POL-006).
import { describe, expect, test } from 'vitest';
import { TrustError } from '../src/modules/scoring/application/trust-error.js';
import { SCORER_LIST, type Scorer, type ScorerOutcome } from '../src/modules/scoring/domain/scorers.js';
import { deviceId, DEVICE_ID, DEVICE_REF, EVENT, JOURNEY, PID, request, world } from './support.js';

const DAY = 86_400_000;

const SIX = ['HumanCheck', 'DeviceTrust', 'BehaviorScore', 'NetworkScore', 'AgeScore', 'ConsistencyScore'] as const;

const quietScorer = (name: Scorer['name'], calls: string[], risk = 0): Scorer => ({
  name,
  score: (): ScorerOutcome => {
    calls.push(name);
    return { name, risk, reason: 'INTERACTION' };
  },
});

describe('B-T1 점수기 목록', () => {
  test('B-T1_확정신호가없는요청은_점수기여섯이모두돌고_하나가높아도나머지를건너뛰지않는다', async () => {
    const calls: string[] = [];
    const w = world({ scorers: SIX.map((n) => quietScorer(n, calls, n === 'HumanCheck' ? 1 : 0)) });
    const r = await w.score.run(request());
    expect(calls).toEqual([...SIX]);
    expect(r.verdict).toBe('CHALLENGE');
  });

  test('B-T1_차단목록기기는가중합과관계없이CHALLENGE이고_사람확인검증과점수기여섯은그대로돈다', async () => {
    const calls: string[] = [];
    const w = world({ scorers: SIX.map((n) => quietScorer(n, calls)) });
    w.features.blockDevice(DEVICE_REF);
    const r = await w.score.run(request());
    expect(r).toEqual({ verdict: 'CHALLENGE', reason: 'DEVICE_HISTORY', degraded: false });
    expect(calls).toEqual([...SIX]);
    expect(w.human.calls).toHaveLength(1);
  });

  test('B-T1_허니팟적중은CHALLENGE이고사유는화면조작모양이며_사람확인은한번만검증한다', async () => {
    const w = world();
    w.features.markHoneypot(PID);
    const r = await w.score.run(request());
    expect(r).toEqual({ verdict: 'CHALLENGE', reason: 'INTERACTION', degraded: false });
    expect(w.human.calls).toHaveLength(1);
  });

  test('B-T1_가중합이기준값보다작으면ALLOW다', async () => {
    const w = world({ scorers: SIX.map((n) => quietScorer(n, [])) });
    expect(await w.score.run(request())).toEqual({ verdict: 'ALLOW', degraded: false });
  });

  test('B-T1_사유범주는가중합에가장크게기여한점수기의범주하나다', async () => {
    const w = world({
      scorers: SIX.map((n): Scorer => ({ name: n, score: () => ({ name: n, risk: n === 'NetworkScore' ? 1 : 0.2, reason: n === 'NetworkScore' ? 'NETWORK' : 'INTERACTION' }) })),
    });
    const r = await w.score.run(request());
    expect(r.verdict).toBe('CHALLENGE');
    expect(r.reason).toBe('NETWORK');
  });

  test('B-T1_실제점수기목록은이름여섯을차례대로가진다', () => {
    expect(SCORER_LIST.map((s) => s.name)).toEqual([...SIX]);
  });
});

describe('B-T2 값 없음', () => {
  test('B-T2_피처Redis가실패하면_기기점수기는값없음이고_degraded가참이며_판정기록에값없음점수기가남는다', async () => {
    const w = world();
    w.features.fail(true);
    const r = await w.score.run(request());
    expect(r.degraded).toBe(true);
    expect(w.recorder.records[0]!.missingScorers).toContain('DeviceTrust');
    expect(w.signals.seen).toContain('missing:DeviceTrust:dependency');
  });

  test('B-T2_사람확인보류는값없음으로0을더하고_다른점수기가중치는바뀌지않으며_degraded다', async () => {
    const pending = world();
    pending.human.set('PENDING');
    const r = await pending.score.run(request());
    expect(r).toEqual({ verdict: 'ALLOW', degraded: true });
    expect(pending.recorder.records[0]!.missingScorers).toEqual(expect.arrayContaining(['HumanCheck']));
  });

  test('B-T2_로비입장의행동요약은원래없는값이라_degraded가아니다', async () => {
    const w = world();
    const r = await w.score.run(request({ context: 'LOBBY_ENTRY', behavior: undefined }));
    expect(r).toEqual({ verdict: 'ALLOW', degraded: false });
    expect(w.recorder.records[0]!.missingScorers).toContain('BehaviorScore');
    expect(w.signals.seen).toContain('missing:BehaviorScore:absent');
  });

  test('B-T2_기기식별값이없으면기기신호는원래없는값이고_키를못받았으면refMissing에degraded다', async () => {
    const none = world();
    const r0 = await none.score.run(request({ deviceId: '' }));
    expect(r0.degraded).toBe(false);
    expect(none.recorder.records[0]).toMatchObject({ refMissing: false });
    const keyless = world({ deviceRef: () => undefined });
    const r = await keyless.score.run(request());
    expect(r.degraded).toBe(true);
    expect(keyless.recorder.records[0]).toMatchObject({ refMissing: true });
    expect(keyless.recorder.records[0]!.deviceRef).toBeUndefined();
  });

  test('B-T2_점수기하나를끈비교에서_값없음은그점수기하나만늘고_같은입력의판정은다른가중치를키우지않는다', async () => {
    const results = [] as string[];
    for (const off of [null, 'BehaviorScore'] as const) {
      const w = world({ scorers: SIX.map((n): Scorer => ({ name: n, score: () => ({ name: n, risk: n === off ? null : n === 'NetworkScore' ? 0.4 : 0.1, reason: 'NETWORK', ...(n === off ? { missing: 'absent' as const } : {}) }) })) });
      const r = await w.score.run(request());
      results.push(`${r.verdict}:${w.recorder.records[0]!.missingScorers.join(',')}`);
    }
    // 합성 규칙의 기준은 1이다. 끄기 전 합 0.9 → ALLOW, 끈 뒤 합 0.8 → ALLOW(남은 값을 다시 나누면 1.0이 되어 CHALLENGE가 된다)
    expect(results).toEqual(['ALLOW:', 'ALLOW:BehaviorScore']);
  });

  test('[ASVS v5.0.0-16.3.4] 값없음과_보류는지표로남고_피처오류는_판정을막지않는다', async () => {
    const w = world();
    w.features.fail(true);
    w.human.set('PENDING');
    await expect(w.score.run(request())).resolves.toMatchObject({ degraded: true });
    expect(w.signals.seen).toEqual(expect.arrayContaining(['human:PENDING', 'missing:DeviceTrust:dependency']));
  });
});

describe('기록과 응답 범위', () => {
  test('B-T3_응답은판정·사유범주하나·degraded뿐이고_기록에도점수·가중치·기준값이없다', async () => {
    const w = world();
    w.features.blockDevice(DEVICE_REF);
    const r = await w.score.run(request());
    expect(Object.keys(r).sort()).toEqual(['degraded', 'reason', 'verdict']);
    const rec = w.recorder.records[0]!;
    expect(rec.verdict).toBe('CHALLENGE');
    expect(Object.keys(rec).filter((k) => /weight|threshold|risk|^score$/i.test(k))).toEqual([]);
    const numeric = Object.entries(rec).filter(([, v]) => typeof v === 'number').map(([k]) => k).sort();
    expect(numeric).toEqual(['decidedAtMs', 'durationMs', 'profileVersion']);
  });

  test('[ASVS v5.0.0-16.3.3] 판정기록은설정판번호와값없음점수기를싣고_원문기기식별값과IP를싣지않는다', async () => {
    const w = world();
    await w.score.run(request());
    const rec = w.recorder.records[0]!;
    expect(rec.profileVersion).toBe(7);
    // 값 없음 점수기: 사전 검증의 이 요청은 쿠키·세션 나이가 없어 AgeScore 하나다. 로비 입장은 행동 요약도 없다(점수기 차례대로)
    expect(rec.missingScorers).toEqual(['AgeScore']);
    const lobby = world();
    await lobby.score.run(request({ context: 'LOBBY_ENTRY', behavior: undefined }));
    expect(lobby.recorder.records[0]!.missingScorers).toEqual(['BehaviorScore', 'AgeScore']);
    const failing = world();
    failing.features.fail(true);
    await failing.score.run(request());
    expect(failing.recorder.records[0]!.missingScorers).toEqual(['DeviceTrust', 'AgeScore']);
    const blob = JSON.stringify(rec);
    expect(blob).not.toContain(DEVICE_ID);
    expect(blob).not.toContain('device-id-01');
    expect(blob).not.toContain('198.51.100.7');
    expect(blob).not.toContain('turnstile-token-1');
  });

  test('B-T17②_journey_id만다르고나머지가같은두요청의판정과사유는같다', async () => {
    const w = world();
    const a = await w.score.run(request({ journeyId: '0190f3a1-7c2e-7a00-8000-0000000000bb' }));
    const b = await w.score.run(request({ journeyId: '0190f3a1-7c2e-7a00-8000-0000000000cc' }));
    expect(a).toEqual(b);
  });

  test('B-T17_판정기록의여정ID는요청의journey_id다', async () => {
    const w = world();
    await w.score.run(request());
    expect(w.recorder.records[0]).toMatchObject({ journeyId: JOURNEY, eventId: EVENT, deviceRef: DEVICE_REF });
  });

  test('B-T17③_로그인은여정ID·회차가없어도판정하고_사람확인토큰이없어도degraded가아니다', async () => {
    const w = world();
    // 이력이 있는 기기로 본다(로그인 근거는 기기 이력이다, ADR-0251 결정 7)
    await w.score.run(request());
    await w.flush();
    w.human.calls.length = 0;
    const r = await w.score.run(request({ context: 'LOGIN', journeyId: '', eventId: '', pid: '', humanCheckToken: '', shuffle: 'NONE', behavior: undefined }));
    expect(r).toEqual({ verdict: 'ALLOW', degraded: false });
    expect(w.human.calls).toHaveLength(0);
    expect(w.recorder.records.at(-1)!.missingScorers).toContain('HumanCheck');
  });

  test('B-T17④_사전검증의행동신호는screen이EVENT_DETAIL이고_여정ID를싣는다', async () => {
    const w = world();
    await w.score.run(request());
    expect(w.behaviors.records).toHaveLength(1);
    expect(w.behaviors.records[0]).toMatchObject({ screen: 'EVENT_DETAIL', journeyId: JOURNEY, eventId: EVENT, pid: PID, deviceRef: DEVICE_REF, refMissing: false, netClass: 'OTHER', asn: 64512 });
    expect(w.behaviors.records[0]!.features).toEqual(request().behavior);
    expect(w.behaviors.records[0]!.eventKey).toBe(w.recorder.records[0]!.eventKey);
  });

  test('B-T17④_B-T13_로비입장의행동신호는screen이LOBBY이고_요약이없다', async () => {
    const w = world();
    await w.score.run(request({ context: 'LOBBY_ENTRY', behavior: undefined }));
    expect(w.behaviors.records).toHaveLength(1);
    expect(w.behaviors.records[0]).toMatchObject({ screen: 'LOBBY', journeyId: JOURNEY });
    expect(w.behaviors.records[0]!.features).toBeUndefined();
  });

  test('B-T17③_로그인·추가검증제출은_행동신호를내지않는다', async () => {
    const w = world();
    await w.score.run(request({ context: 'LOGIN', journeyId: '', eventId: '', pid: '', humanCheckToken: '', shuffle: 'NONE', behavior: undefined }));
    await w.score.run(request({ context: 'VERIFICATION', journeyId: '', behavior: undefined }));
    expect(w.behaviors.records).toEqual([]);
  });

  test('B-T17_기기식별값이없거나_라벨키가없으면_행동신호의deviceRef를비우고refMissing을가른다', async () => {
    const noDevice = world();
    await noDevice.score.run(request({ deviceId: '' }));
    expect(noDevice.behaviors.records[0]).toMatchObject({ refMissing: false });
    expect(noDevice.behaviors.records[0]!.deviceRef).toBeUndefined();
    const noKey = world({ deviceRef: () => undefined });
    await noKey.score.run(request());
    expect(noKey.behaviors.records[0]).toMatchObject({ refMissing: true });
    expect(noKey.behaviors.records[0]!.deviceRef).toBeUndefined();
  });

  test('B-T14_CHALLENGE면기기이력의보냄수와판정근거키를쓰고_ALLOW면쓰지않는다', async () => {
    const w = world();
    w.human.set('FAILED');
    await w.score.run(request());
    await w.flush();
    expect(w.features.history(DEVICE_REF, w.clock.now())).toEqual({ sent: 1, passed: 0, failed: 0 });
    expect(w.features.evidence(PID, EVENT)).toMatchObject({ reason: 'HUMAN_CHECK', hardSignal: 'NONE', deviceRef: DEVICE_REF, profileVersion: 7 });

    const ok = world();
    await ok.score.run(request());
    await ok.flush();
    expect(ok.features.history(DEVICE_REF, ok.clock.now())).toEqual({ sent: 0, passed: 0, failed: 0 });
    expect(ok.features.evidence(PID, EVENT)).toBeUndefined();
  });

  test('한기기에서사람확인을통과한pid는계정집합에쌓이고_기기신뢰점수기가본다', async () => {
    const w = world();
    await w.score.run(request({ pid: 'pid-1' }));
    await w.flush();
    await w.score.run(request({ pid: 'pid-2' }));
    await w.flush();
    const r = await w.score.run(request({ pid: 'pid-3' }));
    expect(r).toEqual({ verdict: 'CHALLENGE', reason: 'DEVICE_HISTORY', degraded: false });
  });

  test('리뷰4_사람확인을통과하지못한요청은계정집합에쓰지않는다', async () => {
    for (const result of ['FAILED', 'PENDING'] as const) {
      const w = world();
      w.human.set(result);
      await w.score.run(request({ pid: 'pid-x' }));
      await w.flush();
      expect(w.features.accountCount(DEVICE_REF, w.clock.now())).toBe(0);
    }
    const ok = world();
    await ok.score.run(request({ pid: 'pid-x' }));
    await ok.flush();
    expect(ok.features.accountCount(DEVICE_REF, ok.clock.now())).toBe(1);
  });

  test('리뷰4_pid마다하루새기기수에상한이있고_넘은기기는계정집합에넣지않는다', async () => {
    const w = world();
    for (let i = 1; i <= 2; i++) await w.score.run(request({ deviceId: deviceId(i) }));
    await w.flush();
    await w.score.run(request({ deviceId: deviceId(3) }));
    await w.flush();
    expect(w.features.accountCount(`k1.ref-of-${deviceId(2)}`, w.clock.now())).toBe(1);
    expect(w.features.accountCount(`k1.ref-of-${deviceId(3)}`, w.clock.now())).toBe(0);
    // 이미 있는 기기는 상한과 관계없다. 날이 바뀌면 다시 받는다
    await w.score.run(request({ deviceId: deviceId(1) }));
    await w.flush();
    expect(w.features.accountCount(`k1.ref-of-${deviceId(1)}`, w.clock.now())).toBe(1);
    w.clock.advance(DAY);
    await w.score.run(request({ deviceId: deviceId(3) }));
    await w.flush();
    expect(w.features.accountCount(`k1.ref-of-${deviceId(3)}`, w.clock.now())).toBe(1);
  });

  test('리뷰4_뒤의CHALLENGE가앞선판정근거를덮지않는다', async () => {
    const w = world();
    w.human.set('FAILED');
    await w.score.run(request());
    await w.flush();
    const first = w.features.evidence(PID, EVENT);
    w.human.set('PASSED');
    w.features.blockDevice(DEVICE_REF);
    await w.score.run(request());
    await w.flush();
    expect(w.features.evidence(PID, EVENT)).toEqual(first);
  });

  test('리뷰5_지난30일이지난계정은세지않는다', async () => {
    const w = world();
    await w.score.run(request({ pid: 'pid-old' }));
    await w.flush();
    expect(w.features.accountCount(DEVICE_REF, w.clock.now())).toBe(1);
    w.clock.advance(29 * DAY);
    expect(w.features.accountCount(DEVICE_REF, w.clock.now())).toBe(1);
    w.clock.advance(2 * DAY);
    expect(w.features.accountCount(DEVICE_REF, w.clock.now())).toBe(0);
  });

  test('리뷰5_검증실패수는날짜칸으로나뉘어_30일이지난칸은더하지않는다', async () => {
    const w = world();
    w.human.set('FAILED');
    await w.score.run(request({ context: 'VERIFICATION', shuffle: 'NONE' }));
    await w.flush();
    expect(w.features.history(DEVICE_REF, w.clock.now())).toEqual({ sent: 0, passed: 0, failed: 1 });
    w.clock.advance(29 * DAY);
    expect(w.features.history(DEVICE_REF, w.clock.now()).failed).toBe(1);
    w.clock.advance(2 * DAY);
    expect(w.features.history(DEVICE_REF, w.clock.now()).failed).toBe(0);
  });

  test('응답뒤로미룬기록이실패해도판정은그대로이고_실패를센다', async () => {
    const w = world();
    w.human.set('FAILED');
    w.features.failWrites(true);
    await expect(w.score.run(request())).resolves.toMatchObject({ verdict: 'CHALLENGE' });
    await w.flush();
    expect(w.signals.seen).toContain('after:challenge');
  });
});

describe('리뷰2 피처 읽기 실패', () => {
  test('B-T6①_기기식별값이없어도피처Redis가실패하면degraded가참이다_허니팟읽기실패가숨지않는다', async () => {
    const w = world();
    w.features.fail(true);
    const r = await w.score.run(request({ deviceId: '' }));
    expect(r.degraded).toBe(true);
    expect(w.signals.seen).toContain('feature:honeypot');
  });

  test('리뷰2_차단목록읽기만실패하면확정신호없이다른신호로판정하고_degraded가참이다', async () => {
    const w = world();
    w.features.blockDevice(DEVICE_REF);
    w.features.failFeature('block');
    const r = await w.score.run(request());
    expect(r).toEqual({ verdict: 'ALLOW', degraded: true });
    expect(w.signals.seen).toContain('feature:block');
    expect(w.recorder.records[0]!.hardSignal).toBe('NONE');
    expect(w.recorder.records[0]!.missingScorers).not.toContain('DeviceTrust');
  });

  test('리뷰2_허니팟읽기만실패해도확정신호없이판정하고_degraded가참이다', async () => {
    const w = world();
    w.features.markHoneypot(PID);
    w.features.failFeature('honeypot');
    expect(await w.score.run(request())).toEqual({ verdict: 'ALLOW', degraded: true });
    expect(w.recorder.records[0]!.hardSignal).toBe('NONE');
  });

  test('리뷰2_계정수읽기만실패하면기록은이력으로점수를내고_degraded가참이다', async () => {
    const w = world();
    w.human.set('FAILED');
    await w.score.run(request({ context: 'VERIFICATION', shuffle: 'NONE' }));
    await w.score.run(request({ context: 'VERIFICATION', shuffle: 'NONE' }));
    await w.flush();
    w.human.set('PASSED');
    w.features.failFeature('accounts');
    const r = await w.score.run(request());
    expect(r).toEqual({ verdict: 'CHALLENGE', reason: 'DEVICE_HISTORY', degraded: true });
    expect(w.recorder.records.at(-1)!.missingScorers).not.toContain('DeviceTrust');
  });

  test('리뷰2_계정수와이력읽기가모두실패하면DeviceTrust가의존성값없음이다', async () => {
    const w = world();
    w.features.failFeature('accounts');
    w.features.failFeature('history');
    w.features.failFeature('shared');
    await w.score.run(request());
    expect(w.recorder.records[0]!.missingScorers).toContain('DeviceTrust');
    expect(w.signals.seen).toContain('missing:DeviceTrust:dependency');
  });
});

describe('리뷰1 로그인 안전장치', () => {
  const noSignal = { context: 'LOGIN', journeyId: '', eventId: '', pid: '', humanCheckToken: '', shuffle: 'NONE', behavior: undefined, deviceId: '', client: { ip: '', userAgent: 'UA', clientHints: {}, asn: 0 } } as const;

  test('리뷰1_근거신호가하나도없는로그인은ALLOW여도degraded가참이다', async () => {
    const r = await world().score.run(request(noSignal));
    expect(r).toEqual({ verdict: 'ALLOW', degraded: true });
  });

  test('재검토1_이력이없는새기기의로그인은ALLOW여도degraded가참이다', async () => {
    const r = await world().score.run(request({ ...noSignal, deviceId: deviceId(1) }));
    expect(r).toEqual({ verdict: 'ALLOW', degraded: true });
  });

  test('재검토1_검증이력이있는기기의로그인은degraded가아니다', async () => {
    const w = world();
    await w.score.run(request({ context: 'VERIFICATION', shuffle: 'NONE', deviceId: deviceId(2) }));
    await w.flush();
    expect(await w.score.run(request({ ...noSignal, deviceId: deviceId(2) }))).toEqual({ verdict: 'ALLOW', degraded: false });
  });

  test('재검토1_사람확인을통과한계정이있는기기의로그인은degraded가아니다', async () => {
    const w = world();
    await w.score.run(request({ deviceId: deviceId(3) }));
    await w.flush();
    expect(await w.score.run(request({ ...noSignal, deviceId: deviceId(3) }))).toEqual({ verdict: 'ALLOW', degraded: false });
  });

  test('재검토1_로비·사전검증은이력이없는새기기여도degraded가아니다', async () => {
    const pre = await world().score.run(request({ deviceId: deviceId(4) }));
    expect(pre).toEqual({ verdict: 'ALLOW', degraded: false });
    const lobby = await world().score.run(request({ context: 'LOBBY_ENTRY', behavior: undefined, deviceId: deviceId(5) }));
    expect(lobby).toEqual({ verdict: 'ALLOW', degraded: false });
  });

  test('리뷰1_사전검증은신호가없어도이규칙을쓰지않는다', async () => {
    const w = world();
    const r = await w.score.run(request({ deviceId: '', client: { ip: '', userAgent: '', clientHints: {}, asn: 0 }, behavior: undefined }));
    expect(r.degraded).toBe(false);
  });
});

describe('입력 검사와 규칙', () => {
  test.each(['abc', 'x'.repeat(23), '가'.repeat(22)])('리뷰4_deviceId형식(base64url22자)이아니면INVALID_ARGUMENT다: %s', async (id) => {
    await expect(world().score.run(request({ deviceId: id }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  test('낮음6_사람확인토큰은2048자까지다', async () => {
    await expect(world().score.run(request({ humanCheckToken: 'x'.repeat(2049) }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(world().score.run(request({ humanCheckToken: 'x'.repeat(2048) }))).resolves.toBeDefined();
  });

  test.each(['LOBBY_ENTRY', 'PREVERIFY'] as const)('%s에서정렬설정이없으면INVALID_ARGUMENT다', async (context) => {
    await expect(world().score.run(request({ context, shuffle: 'NONE' }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  test.each([
    ['eventId', 'bad}id'],
    ['pid', 'x'.repeat(65)],
  ] as const)('해시태그를깨는%s는INVALID_ARGUMENT다', async (k, v) => {
    await expect(world().score.run(request({ [k]: v }))).rejects.toBeInstanceOf(TrustError);
  });

  test('FR-039_비공개설정을한번도못읽었으면UNAVAILABLE로답한다_통과로보지않는다', async () => {
    const w = world({ rules: null });
    await expect(w.score.run(request())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

describe('B-T11 추가 검증 제출', () => {
  test('B-T11_사람확인성공이면차단목록기기라도ALLOW다_가중합을하지않는다', async () => {
    const calls: string[] = [];
    const w = world({ scorers: SIX.map((n) => quietScorer(n, calls, 1)) });
    w.features.blockDevice(DEVICE_REF);
    const r = await w.score.run(request({ context: 'VERIFICATION', shuffle: 'NONE', journeyId: '' }));
    expect(r).toEqual({ verdict: 'ALLOW', degraded: false });
    expect(calls).toEqual([]);
    await w.flush();
    expect(w.features.history(DEVICE_REF, w.clock.now())).toEqual({ sent: 0, passed: 1, failed: 0 });
  });

  test('B-T11_사람확인실패·보류·토큰없음이면CHALLENGE다_통과로보지않는다', async () => {
    const failed = world();
    failed.human.set('FAILED');
    expect(await failed.score.run(request({ context: 'VERIFICATION', shuffle: 'NONE' }))).toEqual({ verdict: 'CHALLENGE', reason: 'HUMAN_CHECK', degraded: false });
    const pending = world();
    pending.human.set('PENDING');
    expect(await pending.score.run(request({ context: 'VERIFICATION', shuffle: 'NONE' }))).toEqual({ verdict: 'CHALLENGE', reason: 'HUMAN_CHECK', degraded: true });
    const none = world();
    expect(await none.score.run(request({ context: 'VERIFICATION', shuffle: 'NONE', humanCheckToken: '' }))).toEqual({ verdict: 'CHALLENGE', reason: 'HUMAN_CHECK', degraded: false });
    expect(none.human.calls).toHaveLength(0);
  });

  test('B-T11_맥락마다기대하는action을사람확인에넘긴다', async () => {
    const w = world();
    await w.score.run(request({ context: 'VERIFICATION', shuffle: 'NONE' }));
    await w.score.run(request({ context: 'LOBBY_ENTRY', behavior: undefined }));
    await w.score.run(request({ context: 'PREVERIFY' }));
    expect(w.human.calls.map((c) => c.action)).toEqual(['verify', 'lobby', 'preverify']);
  });

  test('[ASVS v5.0.0-2.4.1] 사람확인토큰이없는사전검증은실패로세어CHALLENGE쪽으로간다', async () => {
    const w = world();
    const r = await w.score.run(request({ humanCheckToken: '' }));
    expect(r).toEqual({ verdict: 'CHALLENGE', reason: 'HUMAN_CHECK', degraded: false });
    expect(w.human.calls).toHaveLength(0);
  });
});
