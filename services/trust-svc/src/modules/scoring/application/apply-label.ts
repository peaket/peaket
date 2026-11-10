// 라벨 반영 ApplyLabel(docs/features/bot-defense.md §9 '첫 구현', §12 결과 반영, §13 라벨의 쓰임, trust.proto TrustLabelService, ADR-0258).
// 차례: 입력 검사 → 멱등 기록 tr:lbl의 판을 견주고 '시작함'으로 잡기(같은 건 ID에 다른 출처·다른 사람·회차는 거절, 부정 예매 출처 둘은 짝의 판과도 견준다)
//   → 기기 가명 찾기(같은 라벨의 앞 판이 찾은 기기 → 판정 근거 키(표본 검토는 사건 키가 같을 때만) → 요청 device_ref(부정 예매 출처만), 키 판이 지금 판·이음 중인 옛 판일 때만, 이어 달기를 따라)
//   → 차단 키를 바꾸는 Lua(같은 슬롯의 판 가드·이어 달기. 그사이 회전으로 옮겨졌으면 새 판 값으로 다시) → '끝남'·결과·찾은 기기 적기 → 라벨 판정 기록(부정 예매 출처 둘은 내지 않는다).
// '시작함'과 '끝남' 사이에 끊겨도 같은 판을 다시 보내면 이어서 한 번만 반영한다(판 가드가 처음 결과를 준다). 끊긴 뒤 이어 반영한 같은 판도 보안 로그 줄을 남긴다.
// 저장소가 실패하면 UNAVAILABLE과 경고 줄이고 ops-svc 작업 워커가 다시 보낸다. 오류 문구에는 받은 값을 싣지 않는다. 처리자는 보안 로그 줄의 로그 가명으로만 남긴다.
import type { Clock } from '@peaket/platform';
import {
  type BlockListChange,
  blockOp,
  deviceRefVersion,
  fraudCaseField,
  fraudPairField,
  isFraudSource,
  type LabelEvidence,
  LabelInvalid,
  labelField,
  type LabelRequest,
  type LabelResult,
  labelEventKey,
  labelWho,
  type ValidLabel,
  validateLabel,
} from '../domain/labels.js';
import type { BlockListChangeLog, DeviceRefs, FraudGuard, LabelRecorder, LabelStep, LabelStore, TrustSignals } from '../domain/ports.js';
import { TrustError } from './trust-error.js';

export interface ApplyLabelDeps {
  store: LabelStore;
  recorder: LabelRecorder;
  log: BlockListChangeLog;
  signals: Pick<TrustSignals, 'blockListChange'>;
  /** 판정이 읽는 기기 가명의 키 판(지금 판과 이음 중인 옛 판) */
  devices: Pick<DeviceRefs, 'versions'>;
  clock: Clock;
}

/** 부정 예매 출처 둘은 같은 건 ID에 함께 온다(멱등 키 (건 ID, pid, 출처)). 나머지는 건 ID 하나에 출처 하나다 */
const FRAUD_FAMILY = 'FRAUD';
/** 회전으로 옮겨졌다는 답을 따라 다시 하는 상한 */
const MOVED_RETRIES = 3;

export class ApplyLabel {
  constructor(private readonly d: ApplyLabelDeps) {}

  async run(req: LabelRequest): Promise<LabelResult> {
    let l: ValidLabel;
    try {
      l = validateLabel(req);
    } catch (e) {
      if (e instanceof LabelInvalid) throw new TrustError('INVALID_ARGUMENT', e.message);
      throw e;
    }
    const { store } = this.d;
    const fraud = isFraudSource(l.source);
    const entry = labelField(l);
    const partnerSource = l.source === 'FRAUD_ACTIONED' ? 'FRAUD_APPEAL_ACCEPTED' : 'FRAUD_ACTIONED';
    const kind: 'A' | 'R' = l.source === 'FRAUD_ACTIONED' ? 'A' : 'R';
    const pair = fraud ? { pair: fraudPairField(l), partner: labelField({ ...l, source: partnerSource }), kind } : undefined;

    const claim = await this.#step(l, 'claim', () => store.claim({ sourceRef: l.sourceRef, family: fraud ? FRAUD_FAMILY : l.source, who: labelWho(l), entry, version: l.sourceVersion, label: l.label, ...(pair ? { fraud: pair } : {}) }));
    if (claim.kind === 'CONFLICT') throw new TrustError('ALREADY_EXISTS', '같은 건 ID에 다른 출처나 다른 사람·회차의 라벨이 있다');
    // 저장한 판보다 작다: 아무것도 바꾸지 않고 그때의 결과를 준다(라벨도 내지 않는다)
    if (claim.kind === 'STALE') return { changed: false, blockList: claim.result };
    const now = this.d.clock.now();
    // 같은 판이 이미 끝났다: 차단 키를 바꾸지 않고 그때의 결과를 준다. 라벨은 같은 사건 키로 다시 낸다(앞서 낸 것을 잃었어도 받는 쪽이 하나로 친다)
    if (claim.kind === 'DONE') {
      if (!fraud) this.#record(l, now);
      return { changed: false, blockList: claim.result };
    }

    // 기기 가명 찾기
    const allowed = new Set(this.d.devices.versions?.() ?? []);
    const usable = (ref: string | undefined): string | undefined => {
      const v = ref === undefined ? undefined : deviceRefVersion(ref);
      return v !== undefined && allowed.has(v) ? ref : undefined;
    };
    let evidence: LabelEvidence | undefined;
    let found = usable(claim.device);
    if (found === undefined) {
      evidence = await this.#step(l, 'evidence', () => store.evidence(l.pid, l.eventId));
      // 표본 검토는 뽑힌 판정의 사건 키가 판정 근거와 같을 때만 그 기기를 쓴다(같은 사람의 다른 판정·다른 기기를 바꾸지 않게)
      const matches = l.source !== 'SAMPLE_REVIEW' || (evidence?.eventKey !== undefined && evidence.eventKey === l.verdictEventKey);
      found = (matches ? usable(evidence?.deviceRef) : undefined) ?? (fraud ? usable(l.deviceRef || undefined) : undefined);
    } else if (l.source === 'APPEAL_ACCEPTED' || l.source === 'FRAUD_APPEAL_ACCEPTED') {
      // 이의 인정은 판정 근거의 확정 신호를 본다(기기는 앞 판의 것을 쓴다)
      evidence = await this.#step(l, 'evidence', () => store.evidence(l.pid, l.eventId));
    }

    let result: BlockListChange = 'DEVICE_NOT_FOUND';
    let applied: string | undefined;
    if (found !== undefined) {
      const start = found;
      let deviceRef = await this.#step(l, 'follow', () => store.follow(start));
      // 값: 등재 사유(출처 이름)·확정 출처·건 ID·등재 시각. 이미 있으면 Lua가 처음 등재의 값과 수명을 그대로 둔다
      const value = JSON.stringify({ reason: l.source, source: l.source, caseId: l.sourceRef, listedAtMs: now });
      const guard: FraudGuard | undefined = pair ? { pair: pair.pair, caseField: fraudCaseField(l), kind: pair.kind } : undefined;
      const op = blockOp(l, evidence);
      for (let n = 0; ; n++) {
        const target = deviceRef;
        const out = await this.#step(l, 'block', () => store.applyBlock({ deviceRef: target, entry, version: l.sourceVersion, op, evidenceBlock: evidence?.hardSignal === 'BLOCK_LIST', value, caseId: l.sourceRef, ...(guard ? { fraud: guard } : {}) }));
        if (out.kind === 'MOVED') {
          // 그사이 키 회전이 그 기기를 새 판으로 옮겼다: 새 판 값으로 다시 한다
          if (n >= MOVED_RETRIES) throw this.#unavailable(l, 'block');
          deviceRef = await this.#step(l, 'follow', () => store.follow(out.next));
          continue;
        }
        // 더 큰 판이 이미 반영됐다: 이 호출은 바꾸지 않았다(늦게 온 옛 판이 새 판의 결과를 덮지 않는다)
        if (out.kind === 'SUPERSEDED') return { changed: false, blockList: out.result };
        result = out.result;
        applied = deviceRef;
        // 이번에 바꿨거나, 끊긴 뒤 이어 반영한 같은 판이면 보안 로그 줄과 지표를 남긴다(빠지는 것보다 두 번 남는 쪽, §9 '기록')
        if ((out.kind === 'APPLIED' || (out.kind === 'REPLAY' && claim.resume)) && (result === 'ADDED' || result === 'REMOVED')) {
          this.d.log.change({ caseId: l.sourceRef, source: l.source, actedBy: l.actedBy, atMs: now, change: result });
          this.d.signals.blockListChange(result === 'ADDED' ? 'added' : 'removed', l.source);
        }
        break;
      }
    }
    const finalResult = result;
    const finished = await this.#step(l, 'finish', () => store.finish({ sourceRef: l.sourceRef, entry, version: l.sourceVersion, result: finalResult, device: applied }));
    // 그사이 더 큰 판이 멱등 기록을 잡았다: 이 판의 결과는 그 판이 덮는다
    if (!finished) return { changed: false, blockList: result };
    if (!fraud) this.#record(l, now);
    return { changed: true, blockList: result };
  }

  /** 라벨 판정 기록(§13). 표본 검토는 SAMPLE_REVIEW(묶음 표시·적용 판 판정), 부정구매 확인·이의 인정은 POST_LABEL이다 */
  #record(l: ValidLabel, now: number): void {
    this.d.recorder.label({
      eventKey: labelEventKey(l),
      eventId: l.eventId,
      ...(l.queueEntryId !== '' ? { queueEntryId: l.queueEntryId } : {}),
      category: l.label === 'BOT' ? 'LABELED_BOT' : 'LABELED_HUMAN',
      source: l.source === 'SAMPLE_REVIEW' ? 'SAMPLE_REVIEW' : 'POST_LABEL',
      ...(l.reviewBatch ? { reviewBatch: l.reviewBatch } : {}),
      ...(l.appliedVerdict ? { appliedVerdict: l.appliedVerdict } : {}),
      occurredAtMs: now,
    });
  }

  /** 저장소 실패는 UNAVAILABLE이고 경고 줄(건 ID, 출처, 실패한 단계)을 남긴다(문구에 값이 없다). 같은 건 ID·판으로 다시 보내면 이어서 반영한다 */
  async #step<T>(l: ValidLabel, step: LabelStep, f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch {
      throw this.#unavailable(l, step);
    }
  }

  #unavailable(l: ValidLabel, step: LabelStep): TrustError {
    this.d.log.failed({ caseId: l.sourceRef, source: l.source, step });
    return new TrustError('UNAVAILABLE', '라벨 반영 저장소에 닿지 못했다');
  }
}
