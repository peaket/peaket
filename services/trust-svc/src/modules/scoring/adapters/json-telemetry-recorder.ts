// 판정 기록·행동 신호를 asyncapi 모양으로 텔레메트리 토픽에 낸다(docs/features/bot-defense.md §4.1 ⑤, ADR-0171 결정 4, ADR-0249 결정 4·5).
// Avro 인코더(BUILD_ORDER BAS-030) 전까지 값은 UTF-8 JSON 바이트다. 받는 쪽(ops-rt 등)은 그때 켠다.
// 싣는 칸은 계약의 칸뿐이다. 점수 원값·가중치·기준값·확정 신호 종류·사유 범주는 싣지 않는다(POL-006, B-T3).
// 그림자 판(§10.4)의 판정은 shadow true·action NONE으로 따로 내고, 라벨(§9·§13)은 source SAMPLE_REVIEW·POST_LABEL로 낸다(처리자·pid·기기 가명은 싣지 않는다).
import type { BehaviorRecord, BehaviorRecorder, HoneypotRecord, HoneypotRecorder, LabelRecord, LabelRecorder, VerdictRecord, VerdictRecorder } from '../domain/ports.js';
import type { BehaviorSummary } from '../domain/types.js';

export const TRUST_VERDICTS_TOPIC = 'telemetry.trust-verdicts';
export const BEHAVIOR_TOPIC = 'telemetry.behavior';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validJourney = (id: string): boolean => UUID.test(id);

export interface TelemetryOut {
  offer(record: string, topic: string, message: { key: string | null; value: Buffer }): void;
  /** 계약을 채우지 못해 내지 않은 기록을 센다 */
  dropped?(record: string): void;
}

const json = (message: object): Buffer => Buffer.from(JSON.stringify(message), 'utf8');

/** 요약 칸의 최댓값 [가정](ADR-0249 결정 7). 계약에 넣으면 깨지는 변경이라 받기는 하고 내보낼 때 뺀다 */
const FEATURE_MAX = { pointerMoves: 1_000_000, pointerEntropy: 3, inputIntervalMeanMs: 3_600_000, inputIntervalStdMs: 3_600_000, scrollEvents: 1_000_000, scrollDistancePx: 1_000_000_000 } as const;

/** 계약의 칸만 옮긴다(브라우저 값을 그대로 다시 내보내지 않는다). 최댓값을 넘는 칸은 뺀다 */
function featuresOf(b: BehaviorSummary): BehaviorSummary {
  const out: BehaviorSummary = { v: b.v, windowMs: b.windowMs };
  for (const k of Object.keys(FEATURE_MAX) as (keyof typeof FEATURE_MAX)[]) {
    const v = b[k];
    if (v !== undefined && v <= FEATURE_MAX[k]) out[k] = v;
  }
  return out;
}

export class JsonTelemetryRecorder implements VerdictRecorder, BehaviorRecorder, HoneypotRecorder, LabelRecorder {
  constructor(private readonly out: TelemetryOut) {}

  record(r: VerdictRecord): void {
    // 회차가 없는 로그인 판정은 계약의 eventId·journeyId 조건을 채우지 못한다. 정규 로그 줄에만 남는다(ADR-0249 결정 5)
    if (r.context === 'LOGIN') return;
    if (r.context === 'VERIFICATION') {
      // 보류는 실패가 아니다. 실패로 세면 봇 쪽 하한이 부푼다(§13)
      if (r.humanCheck === 'PENDING') return;
      this.#verdict(r, r.verdict === 'ALLOW' ? 'CHALLENGE_PASSED' : 'CHALLENGE_FAILED', r.verdict === 'ALLOW' ? 'ALLOW' : 'CHALLENGE', undefined);
      return;
    }
    // 로비·사전 검증의 여정 ID는 계약상 늘 있어야 한다
    if (!validJourney(r.journeyId)) {
      this.out.dropped?.('TrustVerdict');
      if (r.shadow) this.out.dropped?.('TrustVerdict');
      return;
    }
    this.#verdict(r, r.verdict === 'ALLOW' ? 'PASS' : 'CHALLENGED', r.verdict === 'ALLOW' ? 'ALLOW' : 'CHALLENGE', r.journeyId);
    // 그림자 판정은 집행하지 않으므로 action이 NONE이다. 분석의 봇 지표는 shadow false만 센다(ADR-0071).
    // 같은 요청의 적용 판정 기록 사건 키를 pairedEventKey로 싣는다(분석·표본 검토가 두 판정을 세션마다 잇는다, §10.4)
    if (r.shadow) this.#verdict({ ...r, eventKey: r.shadow.eventKey }, r.shadow.verdict === 'ALLOW' ? 'PASS' : 'CHALLENGED', 'NONE', r.journeyId, r.eventKey);
  }

  #verdict(r: VerdictRecord, category: string, action: string, journeyId: string | undefined, pairedEventKey?: string): void {
    const value = {
      eventId: r.eventId,
      ...(journeyId ? { journeyId } : {}),
      ...(r.deviceRef ? { deviceRef: r.deviceRef } : {}),
      refMissing: r.refMissing,
      category,
      action,
      source: 'REALTIME',
      shadow: pairedEventKey !== undefined,
      ...(pairedEventKey !== undefined ? { pairedEventKey } : {}),
      occurredAt: new Date(r.decidedAtMs).toISOString(),
      eventKey: r.eventKey,
    };
    this.out.offer('TrustVerdict', TRUST_VERDICTS_TOPIC, { key: null, value: json(value) });
  }

  /** 라벨(LABELED_BOT·LABELED_HUMAN). 키는 대기 기록 ID(없으면 키 없음, asyncapi telemetry.trust-verdicts) */
  label(r: LabelRecord): void {
    const value = {
      eventId: r.eventId,
      ...(r.queueEntryId ? { queueEntryId: r.queueEntryId } : {}),
      refMissing: false,
      category: r.category,
      action: 'NONE',
      source: r.source,
      shadow: false,
      ...(r.reviewBatch ? { reviewBatch: r.reviewBatch } : {}),
      ...(r.appliedVerdict ? { appliedVerdict: r.appliedVerdict } : {}),
      occurredAt: new Date(r.occurredAtMs).toISOString(),
      eventKey: r.eventKey,
    };
    this.out.offer('TrustVerdict', TRUST_VERDICTS_TOPIC, { key: r.queueEntryId ?? null, value: json(value) });
  }

  honeypot(r: HoneypotRecord): void {
    const value = { eventId: r.eventId, refMissing: false, category: 'HONEYPOT', action: 'NONE', source: 'HONEYPOT', shadow: false, occurredAt: new Date(r.occurredAtMs).toISOString(), eventKey: r.eventKey };
    this.out.offer('TrustVerdict', TRUST_VERDICTS_TOPIC, { key: null, value: json(value) });
  }

  behavior(r: BehaviorRecord): void {
    if (!validJourney(r.journeyId) || r.pid === '') {
      this.out.dropped?.('BehaviorSignal');
      return;
    }
    const value = {
      pid: r.pid,
      ...(r.deviceRef ? { deviceRef: r.deviceRef } : {}),
      refMissing: r.refMissing,
      eventId: r.eventId,
      journeyId: r.journeyId,
      screen: r.screen,
      netClass: r.netClass,
      ...(r.netClass === 'HOSTING' || r.netClass === 'PROXY' ? { asn: r.asn } : {}),
      ...(r.features ? { features: featuresOf(r.features) } : {}),
      ts: new Date(r.tsMs).toISOString(),
      eventKey: r.eventKey,
    };
    this.out.offer('BehaviorSignal', BEHAVIOR_TOPIC, { key: r.pid, value: json(value) });
  }
}
