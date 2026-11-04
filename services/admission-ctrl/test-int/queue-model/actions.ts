// 대기열·입장 제어 모델 기반 시험의 명령 이름(wbs 2.3.4, docs/verification.md §2.4, V-T40).
// 명세 specs/queue.qnt의 `step`이 고르는 동작 이름과 같아야 한다. CI(tools/spec-check/spec-check.mjs 형식 검사)가 이 목록을 명세와 견주고,
// 시험(queue-model.int.test.ts)이 이 목록과 명령 모음의 이름을 견준다. 명세에 동작을 더하거나 이름을 바꾸면 여기와 명령을 함께 고친다.
export const SPEC_ACTIONS = [
  'enterPreempt',
  'pendingExpires',
  'enterNumber',
  'enterRecord',
  'enterBatchRecord',
  'batchMissing',
  'leave',
  'windowEnds',
  'publishBatch',
  'takeBatchResult',
  'acquire',
  'plan',
  'applyWrite',
  'replicateEv',
  'replicatePerson',
  'failoverEv',
  'failoverPerson',
  'rb05',
  'rb05Confirm',
  'admit',
  'admitCheck',
  'admitClaim',
  'admitSlot',
  'admitSettle',
  'admitRelease',
] as const;

export type SpecAction = (typeof SPEC_ACTIONS)[number];
