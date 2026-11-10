// 통합 시험 B-T4: 그림자 판(docs/features/bot-defense.md §10.1·§10.4)을 끄고 켜며 같은 합성 트래픽 1만 세션을 실제 Valkey에 두 번 넣는다(사이에 Valkey를 비우고 같은 시계).
// 적용 판정이 두 번 모두 같고, 그림자 판의 shadow true 기록 수가 판정 수와 같으며, 사람 확인 호출 수와 Redis 명령 수(INFO commandstats)가 늘지 않는지 본다.
import { createHotRedis, fakeClock, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { JsonTelemetryRecorder } from '../src/modules/scoring/adapters/json-telemetry-recorder.js';
import { keys, RedisFeatureStore } from '../src/modules/scoring/adapters/redis-feature-store.js';
import { ScoreRisk } from '../src/modules/scoring/application/score-risk.js';
import type { HumanCheckPort } from '../src/modules/scoring/domain/ports.js';
import { parseRuleSet, type RuleSet } from '../src/modules/scoring/domain/rules.js';
import type { HumanCheckResult, ScoreRequest } from '../src/modules/scoring/domain/types.js';
import type { TrustSignals } from '../src/modules/scoring/domain/ports.js';
import { launchRulesJson } from '../test/support.js';
import { dev, devicesV1 } from './label-world.js';
import { startValkey } from './valkey.js';

const valkey = startValkey();
let redis: HotRedis;
const slow = { deadlineMs: 10_000 };

beforeAll(async () => {
  redis = await createHotRedis({ url: valkey.url });
});
afterAll(async () => {
  await redis?.close();
  valkey.stop();
});

const SESSIONS = 10_000;
/** 한 번에 겹쳐 보내는 세션 수. 크면 이벤트 루프가 오래 막혀 핫패스 마감(100ms)이 시험 환경 때문에 지나간다 */
const BATCH = 25;
const DEVICES = 2_000;
const T = Date.UTC(2026, 10, 10, 1, 0, 0);
const HOSTING_ASN = 16509;
const JOURNEY = '0190f3a1-7c2e-7a00-8000-0000000000aa';

/** 사람 확인 결과를 토큰에 실어 정한다(세션마다 같은 결과) */
function tokenHuman(): HumanCheckPort & { calls: number } {
  const h = {
    calls: 0,
    verify: async (req: { token: string }): Promise<HumanCheckResult> => {
      h.calls += 1;
      return req.token.slice(4) as HumanCheckResult;
    },
  };
  return h;
}

/** 합성 세션 i(사람 대부분, 일부는 행동 요약·사람 확인·망·차단 목록·허니팟으로 걸린다) */
function session(i: number): ScoreRequest {
  const preverify = i % 3 !== 0;
  const human: HumanCheckResult = i % 17 === 0 ? 'FAILED' : i % 29 === 0 ? 'PENDING' : 'PASSED';
  const botLike = i % 5 === 0;
  return {
    context: preverify ? 'PREVERIFY' : 'LOBBY_ENTRY',
    eventId: 'ev-b4',
    pid: `pid-${i}`,
    accountId: '',
    humanCheckToken: `tok-${human}`,
    deviceId: dev(`s${String(i % DEVICES).padStart(5, '0')}`),
    ...(preverify ? { behavior: { v: 1, windowMs: 30_000, pointerMoves: 100, pointerEntropy: botLike ? 0.05 : 2.5, inputIntervalMeanMs: 200, inputIntervalStdMs: botLike ? 5 : 300 } } : {}),
    client: { ip: '198.51.100.7', userAgent: 'UA', clientHints: {}, asn: i % 11 === 0 ? HOSTING_ASN : 64512 },
    shuffle: i % 2 === 0 ? 'ON' : 'OFF',
    journeyId: JOURNEY,
    deadlineAtMs: T + 800,
  };
}

async function commandStats(): Promise<Record<string, number>> {
  const text = String(await redis.command(['INFO', 'commandstats'], slow));
  const out: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^cmdstat_([^:]+):calls=(\d+)/.exec(line);
    if (m && !['info', 'config|resetstat', 'flushall'].includes(m[1]!)) out[m[1]!] = Number(m[2]);
  }
  return out;
}

/** 마감만 늘린 같은 연결 */
const patientOf = (r: HotRedis): HotRedis => ({ ...r, command: (a, o) => r.command(a, { ...o, deadlineMs: 10_000 }), evalScript: (s, k, a, o) => r.evalScript(s, k, a, { ...o, deadlineMs: 10_000 }) });
let patient: HotRedis;

async function run(rules: RuleSet, sessions: number) {
  patient ??= patientOf(redis);
  await redis.command(['FLUSHALL'], slow);
  // 차단 목록 기기 20개와 허니팟 적중 10명을 같은 값으로 둔다
  for (let d = 0; d < 20; d++) {
    const k = keys.block(devicesV1.ref(dev(`s${String(d * 7).padStart(5, '0')}`))!);
    await redis.command(['SET', k, '{"reason":"SAMPLE_REVIEW","source":"SAMPLE_REVIEW","caseId":"seed","listedAtMs":0}', 'PX', '600000'], { key: k, ...slow });
  }
  for (let p = 0; p < 10; p++) await redis.command(['SET', keys.honeypot(`pid-${p * 31}`), 'x', 'PX', '600000'], { key: keys.honeypot(`pid-${p * 31}`), ...slow });
  await redis.command(['CONFIG', 'RESETSTAT'], slow);
  const human = tokenHuman();
  // 세는 것만 둔다(기록을 쌓아 두면 GC가 길어져 마감이 시험 환경 때문에 지나간다)
  const count = { featureFailed: 0, afterFailed: 0, shadowOnly: 0, activeOnly: 0, records: 0, shadowRecords: 0, unpaired: 0 };
  // 적용 판정 사건 키와 그림자 판정의 짝 사건 키(같은 요청이면 같아야 한다)
  const activeKeys = new Set<string>();
  const pairedKeys = new Set<string>();
  const noop = () => undefined;
  const signals: TrustSignals = {
    verdict: noop,
    humanCheck: noop,
    scorerMissing: noop,
    hardSignal: noop,
    featureFailed: () => void (count.featureFailed += 1),
    afterFailed: () => void (count.afterFailed += 1),
    honeypotHit: noop,
    invRefMissing: noop,
    shadowDisagreement: (d) => void (d === 'shadow_only' ? (count.shadowOnly += 1) : (count.activeOnly += 1)),
    invRefMigration: noop,
    blockListChange: noop,
  };
  const telemetry = new JsonTelemetryRecorder({
    offer: (_r, _t, m) => {
      count.records += 1;
      const v = JSON.parse(m.value.toString('utf8')) as { shadow: boolean; eventKey: string; pairedEventKey?: string };
      if (v.shadow) {
        count.shadowRecords += 1;
        if (v.pairedEventKey) pairedKeys.add(v.pairedEventKey);
        else count.unpaired += 1;
      } else activeKeys.add(v.eventKey);
    },
  });
  const pending: Promise<unknown>[] = [];
  const score = new ScoreRisk({
    rules: { current: () => rules, intensity: () => 'BASE' },
    human,
    // 이 시험은 명령 수와 판정의 같음을 본다. 시험 PC의 이벤트 루프가 잠깐 막혀 핫패스 마감(100ms)이 지나가는 일로 두 실행이 갈리지 않게 마감만 늘린다
    features: new RedisFeatureStore(patient),
    devices: devicesV1,
    asn: { classify: (asn) => (asn === HOSTING_ASN ? 'HOSTING' : 'OTHER') },
    recorder: telemetry,
    behaviors: { behavior: () => undefined },
    signals,
    clock: fakeClock({ now: T }),
    after: (w) => void pending.push(w()),
  });
  const verdicts: string[] = [];
  for (let start = 0; start < sessions; start += BATCH) {
    const out = await Promise.all(Array.from({ length: Math.min(BATCH, sessions - start) }, (_, j) => score.run(session(start + j))));
    for (const r of out) verdicts.push(`${r.verdict}:${r.reason ?? '-'}:${r.degraded}`);
    while (pending.length) await Promise.all(pending.splice(0));
  }
  return { verdicts, humanCalls: human.calls, stats: await commandStats(), ...count, activeKeys, pairedKeys };
}

test('B-T4_그림자판을끄고켜며같은합성트래픽1만세션을두번넣으면_적용판정이같고_그림자기록수는판정수와같으며_짝사건키가있고_사람확인·Redis명령수가늘지않는다', async () => {
  const on = parseRuleSet(launchRulesJson());
  const off = parseRuleSet(
    launchRulesJson((r) => {
      delete r.shadow;
      delete r.stage;
    }),
  );
  expect(off.shadow).toBeUndefined();
  // 스크립트를 미리 싣는다(첫 EVALSHA의 NOSCRIPT가 두 실행의 명령 수를 흔들지 않게). FLUSHALL은 스크립트를 지우지 않는다
  await run(off, 300);

  const a = await run(off, SESSIONS);
  const b = await run(on, SESSIONS);

  expect(a.verdicts).toHaveLength(SESSIONS);
  expect(b.verdicts).toEqual(a.verdicts);
  // 판정이 한쪽으로 쏠리지 않은 합성 트래픽이다
  const challenged = a.verdicts.filter((v) => v.startsWith('CHALLENGE')).length;
  expect(challenged).toBeGreaterThan(SESSIONS * 0.05);
  expect(challenged).toBeLessThan(SESSIONS * 0.9);
  expect(a.shadowRecords).toBe(0);
  expect(a.records).toBe(SESSIONS);
  expect(b.shadowRecords).toBe(SESSIONS);
  // 그림자 기록마다 짝 적용 기록의 사건 키가 있고, 짝은 적용 기록과 하나씩 맞는다
  expect(b.unpaired).toBe(0);
  expect(b.pairedKeys.size).toBe(SESSIONS);
  expect([...b.pairedKeys].every((k) => b.activeKeys.has(k))).toBe(true);
  expect(b.records).toBe(2 * SESSIONS);
  // 두 실행 모두 피처 Redis 실패 없이 돌았다(같은 입력을 넣었다는 전제)
  expect([a.featureFailed, b.featureFailed, a.afterFailed, b.afterFailed]).toEqual([0, 0, 0, 0]);
  // 그림자 판(BehaviorScore 가중치)은 행동 요약이 봇 같은 세션에서 갈린다
  expect(b.shadowOnly).toBeGreaterThan(0);
  expect(b.activeOnly).toBe(0);
  expect([a.shadowOnly, a.activeOnly]).toEqual([0, 0]);
  // 사람 확인 호출과 Redis 명령은 그대로다(그림자 판은 같은 입력으로 점수만 다시 계산한다)
  expect(a.humanCalls).toBe(SESSIONS);
  expect(b.humanCalls).toBe(a.humanCalls);
  expect(Object.keys(a.stats).length).toBeGreaterThan(0);
  expect(b.stats).toEqual(a.stats);
}, 300_000);
