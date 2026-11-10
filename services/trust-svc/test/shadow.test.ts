// 그림자 판(docs/features/bot-defense.md §10.1·§10.4)과 출시 첫 판 설정(B-T21). 규칙 값은 시험만을 위한 합성 값이다(POL-006).
import { TrustVerdict } from '@peaket/contracts/asyncapi';
import { describe, expect, test } from 'vitest';
import { JsonTelemetryRecorder } from '../src/modules/scoring/adapters/json-telemetry-recorder.js';
import { LogVerdictRecorder } from '../src/modules/scoring/adapters/prom-trust-signals.js';
import { parseRuleSet, type RuleSet } from '../src/modules/scoring/domain/rules.js';
import { SCORER_LIST, type Scorer } from '../src/modules/scoring/domain/scorers.js';
import { DEVICE_REF, LAUNCH_RULES, launchRulesJson, PID, request, SYNTHETIC_RULES_JSON, world } from './support.js';

const parseError = (json: string): string => {
  try {
    parseRuleSet(json);
  } catch (e) {
    return (e as Error).message;
  }
  return '';
};

/** 행동 요약만 위험한 세션(포인터 엔트로피가 낮다). 나머지 점수기는 위험 0이다 */
const behaviorOnly = () => request({ behavior: { v: 1, windowMs: 30_000, pointerMoves: 100, pointerEntropy: 0.05, inputIntervalMeanMs: 200, inputIntervalStdMs: 300 } });

describe('B-T21 출시 첫 판 설정', () => {
  test('B-T21①_출시첫판은적용판BehaviorScore가중치가모든강도·정렬에서0이고_그림자판은원래가중치다', () => {
    expect(LAUNCH_RULES.stage).toBe('LAUNCH');
    expect(LAUNCH_RULES.shadow?.version).toBe(8);
    for (const i of ['RELAXED', 'BASE', 'STRICT'] as const) {
      for (const s of ['ON', 'OFF', 'NONE'] as const) {
        expect(LAUNCH_RULES.intensities[i][s].weights.BehaviorScore).toBe(0);
        expect(LAUNCH_RULES.shadow!.intensities[i][s].weights.BehaviorScore).toBeGreaterThan(0);
      }
    }
  });

  test('B-T21①_출시첫판에서적용판BehaviorScore가중치가0이아니거나_그림자판이0이면읽지않는다', () => {
    expect(parseError(launchRulesJson((r) => (r.intensities.STRICT!.NONE!.weights.BehaviorScore = 0.5)))).toContain('intensities.STRICT.NONE.weights.BehaviorScore');
    expect(parseError(launchRulesJson((r) => (r.shadow!.intensities.RELAXED!.ON!.weights.BehaviorScore = 0)))).toContain('shadow.intensities.RELAXED.ON.weights.BehaviorScore');
  });

  test('B-T21①③_출시첫판에서나머지가중치·기준값·매개변수가두판에다르면읽지않는다', () => {
    expect(parseError(launchRulesJson((r) => (r.shadow!.intensities.BASE!.OFF!.weights.NetworkScore = 0.75)))).toContain('shadow.intensities.BASE.OFF.weights.NetworkScore');
    expect(parseError(launchRulesJson((r) => (r.shadow!.intensities.BASE!.OFF!.threshold = 0.9)))).toContain('shadow.intensities.BASE.OFF.threshold');
    expect(parseError(launchRulesJson((r) => (r.shadow!.params.device!.accountsAt = 4)))).toContain('shadow.params');
    // 오류 문구에는 칸 이름만 있고 값은 없다
    expect(parseError(launchRulesJson((r) => (r.shadow!.intensities.BASE!.OFF!.weights.NetworkScore = 0.7531)))).not.toContain('0.7531');
  });

  test('B-T21①_출시첫판표시가있으면그림자판이있어야하고_그림자판번호는적용판과달라야한다', () => {
    expect(parseError(launchRulesJson((r) => delete r.shadow))).toContain('shadow');
    expect(parseError(launchRulesJson((r) => (r.shadow!.version = r.version)))).toContain('shadow.version');
    // 출시 첫 판이 아니면 그림자 판의 값은 자유롭지만 판 번호는 달라야 한다
    const free = JSON.parse(SYNTHETIC_RULES_JSON) as Record<string, unknown>;
    const shadow = JSON.parse(SYNTHETIC_RULES_JSON) as { version: number; intensities: { BASE: { OFF: { threshold: number } } } };
    shadow.intensities.BASE.OFF.threshold = 3;
    expect(parseError(JSON.stringify({ ...free, shadow }))).toContain('shadow.version');
    shadow.version = 9;
    expect(parseRuleSet(JSON.stringify({ ...free, shadow })).shadow?.intensities.BASE.OFF.threshold).toBe(3);
    expect(parseError(JSON.stringify({ ...free, stage: 'SOMETHING' }))).toContain('stage');
  });

  test('B-T21②_BehaviorScore만높은세션은적용판ALLOW_그림자판CHALLENGE이고_그림자기록은shadow참·action NONE이다', async () => {
    const w = world({ rules: LAUNCH_RULES });
    const r = await w.score.run(behaviorOnly());
    await w.flush();
    expect(r).toEqual({ verdict: 'ALLOW', degraded: false });
    const rec = w.recorder.records[0]!;
    expect(rec.verdict).toBe('ALLOW');
    expect(rec.shadow).toEqual({ eventKey: expect.any(String), verdict: 'CHALLENGE', reason: 'INTERACTION', profileVersion: 8 });
    expect(rec.shadow!.eventKey).not.toBe(rec.eventKey);
    expect(w.signals.seen).toContain('shadow:shadow_only');
    // 그림자 판의 CHALLENGE는 판정 근거 키와 기기 이력을 쓰지 않는다
    expect(w.features.evidence(PID, 'ev-1')).toBeUndefined();
    expect(w.features.history(DEVICE_REF, w.clock.now())).toEqual({ sent: 0, passed: 0, failed: 0 });
    // 판정 기록은 두 건: 적용(shadow false)과 그림자(shadow true, action NONE)
    const offered: Record<string, unknown>[] = [];
    new JsonTelemetryRecorder({ offer: (_r, _t, m) => void offered.push(JSON.parse(m.value.toString('utf8')) as Record<string, unknown>) }).record(rec);
    expect(offered).toEqual([
      expect.objectContaining({ category: 'PASS', action: 'ALLOW', source: 'REALTIME', shadow: false, eventKey: rec.eventKey }),
      expect.objectContaining({ category: 'CHALLENGED', action: 'NONE', source: 'REALTIME', shadow: true, eventKey: rec.shadow!.eventKey, pairedEventKey: rec.eventKey, journeyId: rec.journeyId, deviceRef: rec.deviceRef }),
    ]);
    expect(offered[0]).not.toHaveProperty('pairedEventKey');
    for (const o of offered) expect(TrustVerdict.safeParse(o).success).toBe(true);
  });

  test('그림자판은적용판이읽은강도를그대로쓴다_요청도중강도가바뀌어도두판이같은강도로계산한다', async () => {
    // 행동 요약 위험 0.6인 세션: 그림자 판(BehaviorScore 가중치 1)은 BASE(기준 1)면 ALLOW, STRICT(기준 0.5)면 CHALLENGE다
    const reads: string[] = [];
    const intensity = () => {
      const v = reads.length === 0 ? 'BASE' : 'STRICT';
      reads.push(v);
      return v;
    };
    const w = world({ rules: LAUNCH_RULES, intensity });
    const r = await w.score.run(request({ behavior: { v: 1, windowMs: 30_000, pointerMoves: 100, pointerEntropy: 0.46, inputIntervalMeanMs: 200, inputIntervalStdMs: 300 } }));
    expect(r.verdict).toBe('ALLOW');
    expect(reads).toEqual(['BASE']);
    expect(w.recorder.records[0]!.shadow).toMatchObject({ verdict: 'ALLOW', profileVersion: 8 });
    // 같은 세션을 처음부터 STRICT로 받으면 그림자 판은 CHALLENGE다(위의 ALLOW가 강도를 한 번만 읽은 결과임을 보인다)
    const strict = world({ rules: LAUNCH_RULES, intensity: () => 'STRICT' });
    await strict.score.run(request({ behavior: { v: 1, windowMs: 30_000, pointerMoves: 100, pointerEntropy: 0.46, inputIntervalMeanMs: 200, inputIntervalStdMs: 300 } }));
    expect(strict.recorder.records[0]!.shadow).toMatchObject({ verdict: 'CHALLENGE' });
  });

  test('B-T21③_나머지다섯점수기와확정신호는두판에같게더해진다', async () => {
    const cases: { name: string; prep: (w: ReturnType<typeof world>) => void; req?: Parameters<typeof request>[0] }[] = [
      { name: '평소', prep: () => undefined },
      { name: '사람 확인 실패', prep: (w) => w.human.set('FAILED') },
      { name: '사람 확인 보류', prep: (w) => w.human.set('PENDING') },
      { name: '차단 목록', prep: (w) => w.features.blockDevice(DEVICE_REF) },
      { name: '허니팟', prep: (w) => w.features.markHoneypot(PID) },
      { name: '피처 Redis 오류', prep: (w) => w.features.fail(true) },
      { name: '브라우저 정보 모순', prep: () => undefined, req: { client: { ip: '198.51.100.7', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile', clientHints: { 'sec-ch-ua-platform': '"Windows"' }, asn: 64512 } } },
      { name: '쿠키가 갓 생김', prep: () => undefined, req: { firstVisitAtMs: Date.UTC(2026, 10, 9, 1, 0, 0) } },
    ];
    for (const c of cases) {
      const w = world({ rules: LAUNCH_RULES, netClass: () => 'OTHER' });
      c.prep(w);
      const r = await w.score.run(request(c.req));
      const rec = w.recorder.records[0]!;
      expect({ case: c.name, verdict: rec.shadow?.verdict, reason: rec.shadow?.reason }).toEqual({ case: c.name, verdict: r.verdict, reason: r.reason });
    }
    // 점수기는 같은 입력(사람 확인 결과·읽은 피처)으로 판마다 한 번씩, 판의 매개변수로 돈다
    const seen: { name: string; input: unknown; params: unknown }[] = [];
    const spy: Scorer[] = SCORER_LIST.map((s) => ({ name: s.name, score: (input, params) => (seen.push({ name: s.name, input, params }), s.score(input, params)) }));
    const w = world({ rules: LAUNCH_RULES, scorers: spy });
    await w.score.run(request());
    expect(seen).toHaveLength(12);
    expect(seen.slice(0, 6).map((x) => x.params)).toEqual(Array(6).fill(LAUNCH_RULES.params));
    for (let i = 0; i < 6; i++) {
      expect(seen[6 + i]!.name).toBe(seen[i]!.name);
      expect(seen[6 + i]!.input).toBe(seen[i]!.input);
      expect(seen[6 + i]!.params).toBe(LAUNCH_RULES.shadow!.params);
    }
    expect(w.human.calls).toHaveLength(1);
    expect(w.features.readCalls).toBe(1);
  });
});

describe('그림자 판의 기록과 실패', () => {
  test('[ASVS v5.0.0-16.3.3] 정규로그줄은적용판정한줄에그림자판정과그판번호를함께적는다', async () => {
    const w = world({ rules: LAUNCH_RULES });
    await w.score.run(behaviorOnly());
    const lines: Record<string, unknown>[] = [];
    new LogVerdictRecorder({ info: (f) => void lines.push(f) }).record(w.recorder.records[0]!);
    expect(lines).toEqual([expect.objectContaining({ verdict: 'ALLOW', profileVersion: 7, shadowVerdict: 'CHALLENGE', shadowProfileVersion: 8 })]);
    // 그림자 판이 없으면 그 칸도 없다
    const plain = world();
    await plain.score.run(request());
    const plainLines: Record<string, unknown>[] = [];
    new LogVerdictRecorder({ info: (f) => void plainLines.push(f) }).record(plain.recorder.records[0]!);
    expect(Object.keys(plainLines[0]!)).not.toContain('shadowVerdict');
  });

  test('그림자판만통과시키면active_only로센다', async () => {
    // 그림자 판의 기준값이 더 높은 판(출시 첫 판이 아니다)
    const raw = JSON.parse(SYNTHETIC_RULES_JSON) as { shadow?: unknown; intensities: Record<string, Record<string, { threshold: number }>> } & Record<string, unknown>;
    const shadow = JSON.parse(SYNTHETIC_RULES_JSON) as { version: number; intensities: Record<string, Record<string, { threshold: number }>> };
    shadow.version = 9;
    shadow.intensities.BASE!.OFF!.threshold = 5;
    const rules: RuleSet = parseRuleSet(JSON.stringify({ ...raw, shadow }));
    const w = world({ rules });
    w.human.set('FAILED');
    expect((await w.score.run(request())).verdict).toBe('CHALLENGE');
    expect(w.recorder.records[0]!.shadow?.verdict).toBe('ALLOW');
    expect(w.signals.seen).toContain('shadow:active_only');
  });

  test('그림자계산이던지면적용판정은그대로이고_그요청의그림자기록만없다', async () => {
    const throwing: Scorer[] = SCORER_LIST.map((s) => ({
      name: s.name,
      score: (input, params) => {
        if (params === LAUNCH_RULES.shadow!.params) throw new Error('그림자 점수기 오류');
        return s.score(input, params);
      },
    }));
    const w = world({ rules: LAUNCH_RULES, scorers: throwing });
    expect(await w.score.run(behaviorOnly())).toEqual({ verdict: 'ALLOW', degraded: false });
    expect(w.recorder.records).toHaveLength(1);
    expect(w.recorder.records[0]!.shadow).toBeUndefined();
    expect(w.signals.seen.filter((s) => s.startsWith('shadow:'))).toEqual([]);
  });

  test('그림자판은로비입장·사전검증에서만돈다_로그인·추가검증제출은돌지않는다', async () => {
    for (const context of ['LOGIN', 'VERIFICATION'] as const) {
      const w = world({ rules: LAUNCH_RULES });
      await w.score.run(request({ context, shuffle: 'NONE', eventId: context === 'LOGIN' ? '' : 'ev-1', humanCheckToken: context === 'LOGIN' ? '' : 't' }));
      expect(w.recorder.records[0]!.shadow).toBeUndefined();
    }
    const lobby = world({ rules: LAUNCH_RULES });
    await lobby.score.run(request({ context: 'LOBBY_ENTRY', behavior: undefined }));
    expect(lobby.recorder.records[0]!.shadow).toMatchObject({ verdict: 'ALLOW', profileVersion: 8 });
  });
});
