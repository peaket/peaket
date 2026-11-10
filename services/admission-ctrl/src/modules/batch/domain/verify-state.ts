// 게시 때 그 번호를 빠진 번호로 돌리는 q:{event:E}:verify 값(docs/features/queue-admission.md §7 '격리 기록과 복귀', docs/data.md §3 verify, ADR-0231 결정 3·ADR-0233·ADR-0259).
// 추가 검증 중(VERIFYING)·이의 기각(BLOCKED)·주인 없는 자리(ORPHAN)는 돌리고, 셔플 전에 통과한 사람(PASSED)은 돌리지 않는다(원래 순번 위치로 돌아간다, Q-T34 ①).
// Valkey 어댑터와 시험용 메모리 저장소가 같은 규칙을 쓴다.
const REMOVED_AT_PUBLISH = /^(VERIFYING|ORPHAN|BLOCKED):/;

export const removedAtPublish = (value: string | null | undefined): boolean => REMOVED_AT_PUBLISH.test(value ?? '');
