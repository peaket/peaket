// 결제 모델 기반 시험의 명령 이름(wbs 2.7.6, docs/verification.md §2.4, V-T40, BUILD_ORDER PRF-210).
// 명세 specs/payment.qnt의 `step`이 고르는 동작 이름과 같아야 한다(이름순, 31개. `issueFailed`·`keepOrderSide`는 step이 고르지 않아 없다). CI(tools/spec-check/spec-check.mjs
// 형식 검사)가 이 목록을 명세와 견주고, 시험(payment-model.int.test.ts)이 명령 모음(commands.ts의 `Record<SpecAction, …>`)의 열쇠를 이 목록과 견준다.
// 명세에 동작을 더하거나 이름을 바꾸면 여기와 명령을 함께 고치고 재생 기록을 다시 만든다(node tools/spec-check/run-local.mjs traces --spec payment)
export const SPEC_ACTIONS = [
  'accept',
  'applyResult',
  'auth',
  'command',
  'compCancel',
  'compFence',
  'compStart',
  'csConfirm',
  'deadlinePasses',
  'eventCancel',
  'eventRefund',
  'expireAttempt',
  'expireCommand',
  'expireOrder',
  'issue',
  'issueAck',
  'newAttempt',
  'overdue',
  'pgCancel',
  'pgExpire',
  'pgProcess',
  'query',
  'reserve',
  'respond',
  'restart',
  'send',
  'ticketBreaks',
  'ticketSvc',
  'timeout',
  'toggleSwitch',
  'webhook',
] as const;

export type SpecAction = (typeof SPEC_ACTIONS)[number];
