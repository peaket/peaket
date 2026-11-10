// 받는 층: gRPC TrustEvidenceService.GetVerdictEvidence(docs/api/proto/peaket/trust/v1/trust.proto, docs/features/bot-defense.md §12, B-T15 ①)를 유스케이스에 잇는다.
// 응답에는 계약의 칸 아홉(found, 사유 범주, 확정 신호, 판정 출처, 판정 시각, 프로필 판, 그 기기의 30일 보냄·통과·실패 수)만 싣는다.
// 점수 원값·가중치·기준값·기기 가명·판정 키는 싣지 않는다(POL-006). 근거 키가 없으면 found false만 보내고 다른 칸은 비운다(기기 수도 0).
// 부르는 쪽을 ops-svc로 줄이는 것은 메시 L7 허용 목록이 한다(B-T15 ②, BUILD_ORDER HOT-400).
import * as grpc from '@grpc/grpc-js';
import { TrustError } from '../application/trust-error.js';
import type { EvidenceQuery, EvidenceView } from '../domain/evidence.js';

type Req = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
/** int32 칸: 음수·넘침이 직렬화를 깨지 않게 자른다 */
const int32 = (n: number): number => Math.max(0, Math.min(2_147_483_647, Math.trunc(n)));

/** google.protobuf.Timestamp(밀리초 → 초와 나노초) */
const timestamp = (ms: number): { seconds: number; nanos: number } => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });

const responseOf = (v: EvidenceView): object => {
  if (!v.found) return { found: false };
  return {
    found: true,
    reason: `REASON_CATEGORY_${v.reason}`,
    hard_signal: `HARD_SIGNAL_${v.hardSignal}`,
    source: `EVIDENCE_SOURCE_${v.source}`,
    decided_at: timestamp(v.decidedAtMs),
    profile_version: v.profileVersion,
    device_challenges_sent: int32(v.deviceChallenges.sent),
    device_challenges_passed: int32(v.deviceChallenges.passed),
    device_challenges_failed: int32(v.deviceChallenges.failed),
  };
};

/** TrustEvidenceService. 업무 오류는 상태 코드로, 예상 못 한 오류는 고정 문구 INTERNAL로 답한다(오류 문구에 받은 값을 싣지 않는다) */
export function trustEvidenceServiceHandlers(uc: { run(i: EvidenceQuery): Promise<EvidenceView> }, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const GetVerdictEvidence: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    const r = call.request;
    // 유스케이스가 곧바로 던져도 같은 길로 답하게 약속으로 감싼다
    Promise.resolve()
      .then(() => uc.run({ eventId: text(r.event_id), pid: text(r.pid) }))
      .then(
      (v) => cb(null, responseOf(v)),
      (err: unknown) => {
        if (err instanceof TrustError) {
          cb({ code: grpc.status[err.code], details: err.message });
          return;
        }
        onError('GetVerdictEvidence', err);
        cb({ code: grpc.status.INTERNAL, details: '처리하지 못했다' });
      },
    );
  };
  return { GetVerdictEvidence };
}
