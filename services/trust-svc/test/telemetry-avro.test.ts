// 판정 기록(telemetry.trust-verdicts TrustVerdict)과 행동 신호(telemetry.behavior BehaviorSignal)의 Avro 바이트 시험(F-04-2 계획 §6 A-T26 ③·⑤, ADR-0357 결정 3·8·9).
// 운영 기록기(AvroTelemetryRecorder)가 공용 인코더로 만든 바이트를 버퍼 대역이 받고, 시험 도구(test/avro-telemetry.ts → packages/platform/test/produced-avro.ts)가
// 계약 판 .avsc로 푼다. 단언 값은 정본에서 적는다: 공통 판정 넷(A-T26), 실시간 PASS·CHALLENGED의 journeyId·기기 식별값이 있었던 판정의 deviceRef(A-T26 ③),
// 그림자 판정의 pairedEventKey(x-present-when shadow true), 표본 검토의 reviewBatch·appliedVerdict(x-present-when source SAMPLE_REVIEW),
// 점수 원값·확정 신호 종류·사유 범주·pid는 싣지 않음(docs/features/bot-defense.md §4.1 ⑤, asyncapi pid는 REASSESS에만), 만들지 못하면 버리고 셈(결정 8).
import { describe, expect, test } from 'vitest';
import { countUtf8 } from '../../../packages/platform/test/produced-avro.js';
import { AvroTelemetryRecorder } from '../src/modules/scoring/adapters/avro-telemetry-recorder.js';
import type { BehaviorRecord, VerdictRecord } from '../src/modules/scoring/domain/ports.js';
import { decodedTelemetry, telemetryEncoder } from './avro-telemetry.js';
import { DEVICE_REF, EVENT, JOURNEY, PID } from './support.js';

const AT = Date.UTC(2026, 10, 23, 1, 2, 3, 456);
const KEY = '0190f3a1-7c2e-7a00-8000-000000000b01';
const SHADOW_KEY = '0190f3a1-7c2e-7a00-8000-000000000b02';

interface Offered {
  record: string;
  topic: string;
  key: string | null;
  bytes: Buffer;
}

function harness() {
  const offered: Offered[] = [];
  const dropped: string[] = [];
  const warns: object[] = [];
  const rec = new AvroTelemetryRecorder(
    { offer: (record, topic, m) => void offered.push({ record, topic, key: m.key, bytes: m.value }), dropped: (r) => void dropped.push(r) },
    telemetryEncoder(),
    { warn: (o) => void warns.push(o) },
  );
  return { offered, dropped, warns, rec };
}

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
  netClass: 'HOSTING',
  asn: 64512,
  features: { v: 1, windowMs: 30_000, pointerMoves: 100, pointerEntropy: 2.5 },
  tsMs: AT,
  ...o,
});

describe('A-T26 ③ 판정 기록과 행동 신호(trust-svc)', () => {
  test('A-T26 ③ 판정 기록과 행동 신호가 공통 판정을 만족한다', () => {
    const h = harness();
    // 실시간 PASS(기기 식별값 없음, 가명을 만들지 못함), 기기 식별값이 있는 CHALLENGED, 그 판정의 그림자 판정
    h.rec.record(verdict({ refMissing: true }));
    h.rec.record(verdict({ context: 'LOBBY_ENTRY', verdict: 'CHALLENGE', reason: 'NETWORK', hardSignal: 'HONEYPOT', missingScorers: ['DeviceTrust'], deviceRef: DEVICE_REF, shadow: { eventKey: SHADOW_KEY, verdict: 'ALLOW', profileVersion: 8 } }));
    // 표본 검토·사후 라벨
    h.rec.label({ eventKey: KEY, eventId: EVENT, queueEntryId: 'qe-77', category: 'LABELED_BOT', source: 'SAMPLE_REVIEW', reviewBatch: 'SHADOW_CHALLENGED', appliedVerdict: 'ALLOW', occurredAtMs: AT });
    h.rec.label({ eventKey: KEY, eventId: EVENT, category: 'LABELED_HUMAN', source: 'POST_LABEL', occurredAtMs: AT });
    // 행동 신호: 사전 검증(요약 있음)·로비 입장(요약 없음)
    h.rec.behavior(behavior());
    const { features: _f, ...lobby } = behavior({ screen: 'LOBBY', netClass: 'OTHER', deviceRef: undefined, refMissing: true });
    h.rec.behavior(lobby);

    expect(h.dropped).toEqual([]);
    expect(h.warns).toEqual([]);
    expect(h.offered.map((o) => [o.record, o.topic, o.key])).toEqual([
      ['TrustVerdict', 'telemetry.trust-verdicts', null],
      ['TrustVerdict', 'telemetry.trust-verdicts', null],
      ['TrustVerdict', 'telemetry.trust-verdicts', null],
      ['TrustVerdict', 'telemetry.trust-verdicts', 'qe-77'],
      ['TrustVerdict', 'telemetry.trust-verdicts', null],
      ['BehaviorSignal', 'telemetry.behavior', PID],
      ['BehaviorSignal', 'telemetry.behavior', PID],
    ]);
    // 머리(매직 바이트 0·설정 ID)·필수 칸·x-present-when·UNRECOGNIZED는 decodedTelemetry가 본다
    const v = h.offered.map((o) => decodedTelemetry(o.record, o.bytes));
    expect(v[0]).toMatchObject({ eventId: EVENT, category: 'PASS', action: 'ALLOW', source: 'REALTIME', shadow: false, journeyId: JOURNEY, deviceRef: null, refMissing: true, pid: null, pairedEventKey: null, occurredAt: AT, eventKey: KEY });
    expect(v[1]).toMatchObject({ category: 'CHALLENGED', action: 'CHALLENGE', source: 'REALTIME', shadow: false, journeyId: JOURNEY, deviceRef: DEVICE_REF, refMissing: false, pairedEventKey: null, eventKey: KEY });
    expect(v[2]).toMatchObject({ category: 'PASS', action: 'NONE', source: 'REALTIME', shadow: true, journeyId: JOURNEY, deviceRef: DEVICE_REF, pairedEventKey: KEY, eventKey: SHADOW_KEY });
    expect(v[3]).toMatchObject({ category: 'LABELED_BOT', action: 'NONE', source: 'SAMPLE_REVIEW', queueEntryId: 'qe-77', reviewBatch: 'SHADOW_CHALLENGED', appliedVerdict: 'ALLOW', journeyId: null, pid: null, deviceRef: null });
    expect(v[4]).toMatchObject({ category: 'LABELED_HUMAN', source: 'POST_LABEL', reviewBatch: null, appliedVerdict: null, queueEntryId: null });
    expect(v[5]).toMatchObject({ pid: PID, eventId: EVENT, journeyId: JOURNEY, screen: 'EVENT_DETAIL', deviceRef: DEVICE_REF, netClass: 'HOSTING', asn: 64512, ts: AT, eventKey: KEY });
    expect(v[5]!.features).toEqual({ v: 1, windowMs: 30_000, pointerMoves: 100, pointerEntropy: 2.5, inputIntervalMeanMs: null, inputIntervalStdMs: null, scrollEvents: null, scrollDistancePx: null });
    // asn은 HOSTING·PROXY일 때만(x-present-when), 로비는 요약이 없다
    expect(v[6]).toMatchObject({ screen: 'LOBBY', netClass: 'OTHER', asn: null, deviceRef: null, refMissing: true, features: null });
    // 판정 기록의 바이트에 pid·사유 범주·확정 신호 종류·빠진 채점기 이름이 없다(점수 원값·근거는 싣지 않는다)
    for (const o of h.offered.slice(0, 5)) {
      for (const banned of [PID, 'NETWORK', 'HONEYPOT', 'DeviceTrust']) expect(countUtf8(o.bytes, banned), banned).toBe(0);
    }
  });
});

describe('A-T26 ⑤ 만들지 못한 판정 기록(ADR-0357 결정 8)', () => {
  test('A-T26 ⑤ 표본 검토 라벨에 묶음·적용 판정이 없으면 버리고 세며 경고에 값이 없다', () => {
    const h = harness();
    h.rec.label({ eventKey: KEY, eventId: 'ev-secret-9', queueEntryId: 'qe-secret-9', category: 'LABELED_BOT', source: 'SAMPLE_REVIEW', occurredAtMs: AT });
    expect(h.offered).toEqual([]);
    expect(h.dropped).toEqual(['TrustVerdict']);
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toMatchObject({ kind: 'telemetry-encode-failed', record: 'TrustVerdict' });
    expect([...((h.warns[0] as { fields: string[] }).fields)].sort()).toEqual(['appliedVerdict', 'reviewBatch']);
    const text = JSON.stringify(h.warns);
    for (const banned of ['ev-secret-9', 'qe-secret-9', KEY]) expect(text.includes(banned), banned).toBe(false);
    // 정상 라벨 하나는 낸다(빈 결과가 통과로 새지 않게)
    h.rec.label({ eventKey: KEY, eventId: EVENT, category: 'LABELED_HUMAN', source: 'POST_LABEL', occurredAtMs: AT });
    expect(h.offered).toHaveLength(1);
  });

  test('A-T26 ⑤ 인코더가 없으면(텔레메트리가 꺼짐) 내지 않고 버린 수만 센다', () => {
    const offered: unknown[] = [];
    const dropped: string[] = [];
    const rec = new AvroTelemetryRecorder({ offer: (...a) => void offered.push(a), dropped: (r) => void dropped.push(r) });
    rec.record(verdict());
    rec.behavior(behavior());
    expect(offered).toEqual([]);
    expect(dropped).toEqual(['TrustVerdict', 'BehaviorSignal']);
  });
});
