// 판정 근거 조회 GetVerdictEvidence(docs/features/bot-defense.md §12 '판정에 쓰는 자료', trust.proto TrustEvidenceService, B-T15 ①).
// 차례: 입력 검사(모양이 틀리면 저장소를 읽지 않고 INVALID_ARGUMENT) → 판정 근거 키와 그 기기의 이력 읽기 → 없으면 found false.
// 읽기만 하므로 멱등 키가 없다. 저장소 장애는 UNAVAILABLE이다(found false로 답하면 이의 심사가 근거 없음으로 잘못 판단한다).
// 부르는 쪽을 ops-svc로 줄이는 것은 메시 L7 허용 목록 몫이다(B-T15 ②, BUILD_ORDER HOT-400).
import type { Clock } from '@peaket/platform';
import { type EvidenceQuery, EvidenceQueryInvalid, type EvidenceRead, type EvidenceView, validateEvidenceQuery } from '../domain/evidence.js';
import type { EvidenceStore } from '../domain/ports.js';
import { TrustError } from './trust-error.js';

export interface GetVerdictEvidenceDeps {
  store: EvidenceStore;
  clock: Clock;
}

export class GetVerdictEvidence {
  constructor(private readonly d: GetVerdictEvidenceDeps) {}

  async run(i: EvidenceQuery): Promise<EvidenceView> {
    let q: EvidenceQuery;
    try {
      q = validateEvidenceQuery(i);
    } catch (e) {
      if (e instanceof EvidenceQueryInvalid) throw new TrustError('INVALID_ARGUMENT', e.message);
      throw e;
    }
    const now = this.d.clock.now();
    let read: EvidenceRead | undefined;
    try {
      read = await this.d.store.verdictEvidence({ pid: q.pid, eventId: q.eventId, now });
    } catch {
      throw new TrustError('UNAVAILABLE', '판정 근거 저장소에 닿지 못했다');
    }
    if (!read) return { found: false };
    // 저장소가 무엇을 더 실어 오든 계약의 칸만 옮긴다(기기 가명·판정 키·점수가 응답으로 새지 않게)
    const { sent, passed, failed } = read.deviceChallenges;
    return { found: true, reason: read.reason, hardSignal: read.hardSignal, source: read.source, decidedAtMs: read.decidedAtMs, profileVersion: read.profileVersion, deviceChallenges: { sent, passed, failed } };
  }
}
