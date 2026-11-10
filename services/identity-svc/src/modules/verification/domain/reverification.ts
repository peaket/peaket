// 본인확인 재통과 확인의 규칙(identity.proto ReverificationCheckService, docs/features/bot-defense.md §5.2 3단계,
// docs/features/identity.md I-T56, BUILD_ORDER BOT-090, ADR-0259). 추가 검증 제출에서 queue-svc가 묻는다.
// - 센 것: 그 계정의 목적 REVERIFY 건 가운데 확정 시각(completed_at)이 추가 검증을 시작한 시각(not_before) 이후인 것.
//   이름 그대로 '그 앞이 아님'이라 같은 시각은 센다. 창을 연 시각이 아니라 확정 시각으로 센다(정본 '그 뒤에 VERIFIED로 확정된 건')
// - 같은 사람으로 VERIFIED 확정된 건이 하나라도 있으면 재통과다(①). 결과 경로가 계정의 ci_hmac과 같은 사람일 때만 VERIFIED로 확정한다
// - 그것이 없고 결과가 이 계정의 본인과 다른 사람이었던 건이 있으면 PERSON_MISMATCH(③), 그 밖(시작 전에만 있음, 진행 중, 취소, 실패, 기관 장애)은 NOT_FOUND(②)

export type ReverificationResult = { result: 'PASSED'; verifiedAt: number } | { result: 'NOT_FOUND' } | { result: 'PERSON_MISMATCH' };

/** 그 계정의 목적 REVERIFY 건 가운데 not_before 이후에 확정된 것의 요약(저장소가 준다) */
export interface ReverificationSummary {
  /** 같은 사람으로 VERIFIED 확정된 건의 가장 늦은 확정 시각(epoch 밀리초). 없으면 null */
  lastVerifiedAt: number | null;
  /** 결과가 이 계정의 본인과 다른 사람이었던 건이 있는가 */
  personMismatch: boolean;
}

export function judgeReverification(s: ReverificationSummary): ReverificationResult {
  if (s.lastVerifiedAt !== null) return { result: 'PASSED', verifiedAt: s.lastVerifiedAt };
  return s.personMismatch ? { result: 'PERSON_MISMATCH' } : { result: 'NOT_FOUND' };
}
