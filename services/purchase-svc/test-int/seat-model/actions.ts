// 좌석 홀드·판매 확정 모델 기반 시험의 명령 이름(wbs 2.5.5, docs/verification.md §2.4, V-T40, BUILD_ORDER PRF-150 ①).
// 명세 specs/seat.qnt의 `step`이 고르는 동작 이름과 같아야 한다(이름순). CI(tools/spec-check/spec-check.mjs 형식 검사)가 이 목록을 명세와 견주고,
// 시험(seat-model.int.test.ts)이 명령 모음의 이름을 이 목록과 견준다(명령 모음 `Record<SpecAction, …>`는 PRF-151). 명세에 동작을 더하거나
// 이름을 바꾸면 여기와 명령을 함께 고치고 재생 기록을 다시 만든다(node tools/spec-check/run-local.mjs traces --spec seat)
export const SPEC_ACTIONS = [
  'accept',
  'approve',
  'decline',
  'expire',
  'hold',
  'loseAll',
  'pin',
  'promote',
  'rebuild',
  'relay',
  'releaseFailed',
  'replicate',
  'saleStep',
  'ttlPasses',
] as const;

export type SpecAction = (typeof SPEC_ACTIONS)[number];
