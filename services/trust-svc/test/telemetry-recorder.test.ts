// 판정 기록·행동 신호를 계약 모양으로 내보낸다(docs/features/bot-defense.md §4.1 ⑤, asyncapi TrustVerdict·BehaviorSignal, ADR-0171·0249).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BehaviorSignal, TrustVerdict } from '@peaket/contracts/asyncapi';
import { describe, expect, test } from 'vitest';
import { JsonTelemetryRecorder } from '../src/modules/scoring/adapters/json-telemetry-recorder.js';
import type { BehaviorRecord, VerdictRecord } from '../src/modules/scoring/domain/ports.js';
import { DEVICE_REF, EVENT, JOURNEY, PID } from './support.js';

interface Offered {
  record: string;
  topic: string;
  key: string | null;
  value: Record<string, unknown>;
}

function recorder() {
  const offered: Offered[] = [];
  return {
    offered,
    rec: new JsonTelemetryRecorder({
      offer: (record, topic, m) => offered.push({ record, topic, key: m.key, value: JSON.parse(m.value.toString('utf8')) as Record<string, unknown> }),
    }),
  };
}

const AT = Date.UTC(2026, 10, 9, 1, 0, 0);
const KEY = '0190f3a1-7c2e-7a00-8000-000000000bbb';
const verdict = (o: Partial<VerdictRecord> = {}): VerdictRecord => ({
  eventKey: KEY,
  context: 'PREVERIFY',
  verdict: 'ALLOW',
  degraded: false,
  hardSignal: 'NONE',
  humanCheck: 'PASSED',
  missingScorers: [],
  profileVersion: 7,
  eventId: EVENT,
  pid: PID,
  journeyId: JOURNEY,
  deviceRef: DEVICE_REF,
  refMissing: false,
  decidedAtMs: AT,
  durationMs: 12,
  ...o,
});
const behavior = (o: Partial<BehaviorRecord> = {}): BehaviorRecord => ({
  eventKey: KEY,
  eventId: EVENT,
  pid: PID,
  journeyId: JOURNEY,
  screen: 'EVENT_DETAIL',
  deviceRef: DEVICE_REF,
  refMissing: false,
  netClass: 'OTHER',
  asn: 64512,
  features: { v: 1, windowMs: 30_000, pointerMoves: 100, pointerEntropy: 3, inputIntervalMeanMs: 200, inputIntervalStdMs: 300, scrollEvents: 3, scrollDistancePx: 900 },
  tsMs: AT,
  ...o,
});

function avroFields(name: string): string[] {
  const p = fileURLToPath(new URL(`../../../docs/api/avro/peaket/telemetry/${name}.avsc`, import.meta.url));
  return (JSON.parse(readFileSync(p, 'utf8')) as { fields: { name: string }[] }).fields.map((f) => f.name);
}

describe('판정 기록(telemetry.trust-verdicts)', () => {
  test('[B-T17] 로비입장·사전검증판정은_토큰의여정ID와기기가명을싣고_계약모양이다', () => {
    const { offered, rec } = recorder();
    rec.record(verdict());
    rec.record(verdict({ context: 'LOBBY_ENTRY', verdict: 'CHALLENGE', reason: 'NETWORK' }));
    expect(offered.map((o) => [o.record, o.topic, o.key])).toEqual([
      ['TrustVerdict', 'telemetry.trust-verdicts', null],
      ['TrustVerdict', 'telemetry.trust-verdicts', null],
    ]);
    expect(offered[0]!.value).toMatchObject({ eventId: EVENT, journeyId: JOURNEY, deviceRef: DEVICE_REF, refMissing: false, category: 'PASS', action: 'ALLOW', source: 'REALTIME', shadow: false, eventKey: KEY });
    expect(offered[1]!.value).toMatchObject({ category: 'CHALLENGED', action: 'CHALLENGE', journeyId: JOURNEY });
    for (const o of offered) expect(TrustVerdict.safeParse(o.value).success, JSON.stringify(o.value)).toBe(true);
    // 받는 쪽 대기 기록과 잇는 pid는 REASSESS에만 싣는다(x-present-when)
    expect(offered[0]!.value.pid).toBeUndefined();
  });

  test('[B-T3] [B-T17] 계약(Avro)에있는칸만_나가고_점수·기준값·확정신호종류는없다', () => {
    const { offered, rec } = recorder();
    rec.record(verdict({ hardSignal: 'HONEYPOT', verdict: 'CHALLENGE', reason: 'INTERACTION' }));
    const fields = new Set(avroFields('TrustVerdict'));
    for (const k of Object.keys(offered[0]!.value)) expect(fields.has(k), k).toBe(true);
    const text = JSON.stringify(offered[0]!.value);
    for (const banned of ['score', 'weight', 'threshold', 'hardSignal', 'HONEYPOT', 'humanCheck', 'profileVersion', 'reason']) expect(text.includes(banned), banned).toBe(false);
  });

  test('[B-T17] 기기가명을계산하지못했으면_비우고_refMissing을참으로낸다', () => {
    const { offered, rec } = recorder();
    const { deviceRef: _gone, ...noRef } = verdict({ refMissing: true });
    rec.record(noRef);
    expect(offered[0]!.value.deviceRef).toBeUndefined();
    expect(offered[0]!.value.refMissing).toBe(true);
  });

  test('[B-T17] 추가검증제출은_여정ID없이도_통과·실패로낸다', () => {
    const { offered, rec } = recorder();
    rec.record(verdict({ context: 'VERIFICATION', journeyId: '', verdict: 'ALLOW' }));
    rec.record(verdict({ context: 'VERIFICATION', journeyId: '', verdict: 'CHALLENGE', reason: 'HUMAN_CHECK', humanCheck: 'FAILED' }));
    expect(offered.map((o) => o.value.category)).toEqual(['CHALLENGE_PASSED', 'CHALLENGE_FAILED']);
    expect(offered.map((o) => o.value.action)).toEqual(['ALLOW', 'CHALLENGE']);
    for (const o of offered) {
      expect(o.value.journeyId).toBeUndefined();
      expect(TrustVerdict.safeParse(o.value).success).toBe(true);
    }
  });

  test('사람확인이보류된추가검증제출과_로그인판정은_판정기록으로내지않는다', () => {
    const { offered, rec } = recorder();
    rec.record(verdict({ context: 'VERIFICATION', journeyId: '', verdict: 'CHALLENGE', reason: 'HUMAN_CHECK', humanCheck: 'PENDING', degraded: true }));
    rec.record(verdict({ context: 'LOGIN', eventId: '', journeyId: '' }));
    expect(offered).toEqual([]);
  });

  test('로비·사전검증인데_여정ID가틀리면_계약을어기므로내지않고_버린수를센다', () => {
    const drops: string[] = [];
    const offered: Offered[] = [];
    const rec = new JsonTelemetryRecorder({ offer: (record, topic, m) => offered.push({ record, topic, key: m.key, value: {} }), dropped: (record) => drops.push(record) });
    rec.record(verdict({ journeyId: '' }));
    rec.record(verdict({ journeyId: 'not-a-uuid' }));
    expect(offered).toEqual([]);
    expect(drops).toEqual(['TrustVerdict', 'TrustVerdict']);
  });

  test('[Q-T40] 허니팟적중은_source·category가HONEYPOT이고_사람식별값·여정ID가없다', () => {
    const { offered, rec } = recorder();
    rec.honeypot({ eventKey: KEY, eventId: EVENT, occurredAtMs: AT });
    expect(offered[0]).toMatchObject({ record: 'TrustVerdict', topic: 'telemetry.trust-verdicts', key: null });
    expect(offered[0]!.value).toMatchObject({ eventId: EVENT, category: 'HONEYPOT', action: 'NONE', source: 'HONEYPOT', shadow: false });
    expect(offered[0]!.value.pid).toBeUndefined();
    expect(offered[0]!.value.journeyId).toBeUndefined();
    expect(TrustVerdict.safeParse(offered[0]!.value).success).toBe(true);
  });
});

describe('행동 신호(telemetry.behavior)', () => {
  test('[B-T17] 사전검증은_screen이EVENT_DETAIL이고_키가pid이며_요약값만싣는다', () => {
    const { offered, rec } = recorder();
    rec.behavior(behavior());
    expect(offered[0]).toMatchObject({ record: 'BehaviorSignal', topic: 'telemetry.behavior', key: PID });
    expect(offered[0]!.value).toMatchObject({ pid: PID, eventId: EVENT, journeyId: JOURNEY, screen: 'EVENT_DETAIL', netClass: 'OTHER', deviceRef: DEVICE_REF });
    expect(BehaviorSignal.safeParse(offered[0]!.value).success, JSON.stringify(offered[0]!.value)).toBe(true);
    const fields = new Set(avroFields('BehaviorSignal'));
    for (const k of Object.keys(offered[0]!.value)) expect(fields.has(k), k).toBe(true);
  });

  test('[B-T17] [B-T13] 로비입장은_screen이LOBBY이고_요약이없다', () => {
    const { offered, rec } = recorder();
    const { features: _gone, ...noFeatures } = behavior({ screen: 'LOBBY' });
    rec.behavior(noFeatures);
    expect(offered[0]!.value.screen).toBe('LOBBY');
    expect(offered[0]!.value.features).toBeUndefined();
    expect(BehaviorSignal.safeParse(offered[0]!.value).success).toBe(true);
  });

  test('asn은_HOSTING·PROXY일때만싣는다', () => {
    const { offered, rec } = recorder();
    rec.behavior(behavior({ netClass: 'HOSTING' }));
    rec.behavior(behavior({ netClass: 'OTHER' }));
    expect(offered[0]!.value.asn).toBe(64512);
    expect(offered[1]!.value.asn).toBeUndefined();
  });

  test('[B-T3] 요약에_정해지지않은칸이끼어도_나가지않는다', () => {
    const { offered, rec } = recorder();
    rec.behavior(behavior({ features: { v: 1, windowMs: 1000, pointerPath: [1, 2] } as never }));
    expect(offered[0]!.value.features).toEqual({ v: 1, windowMs: 1000 });
  });

  test('[B-T17] 최댓값[가정]을넘는요약칸은_내보내지않는다(계약은깨지지않게받되저장하지않는다)', () => {
    const { offered, rec } = recorder();
    rec.behavior(behavior({ features: { v: 1, windowMs: 1000, pointerMoves: 1_000_001, pointerEntropy: 3.001, inputIntervalMeanMs: 3_600_001, inputIntervalStdMs: 3_600_001, scrollEvents: 1_000_001, scrollDistancePx: 1_000_000_001 } }));
    expect(offered[0]!.value.features).toEqual({ v: 1, windowMs: 1000 });
    const ok = recorder();
    const edge = { v: 1, windowMs: 1000, pointerMoves: 1_000_000, pointerEntropy: 3, inputIntervalMeanMs: 3_600_000, inputIntervalStdMs: 3_600_000, scrollEvents: 1_000_000, scrollDistancePx: 1_000_000_000 };
    ok.rec.behavior(behavior({ features: edge }));
    expect(ok.offered[0]!.value.features).toEqual(edge);
  });

  test('여정ID가틀리면_내지않는다', () => {
    const { offered, rec } = recorder();
    rec.behavior(behavior({ journeyId: 'x' }));
    expect(offered).toEqual([]);
  });
});
