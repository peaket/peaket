// SCR-040 로그인 수단 연결·해제(account 담당, docs/features/identity.md §2.1 '설정의 로그인 수단 연결·해제의 첫 구현'). 계정 설정의 로그인 수단 화면이 실제 모드에서 쓴다.
export { browserLoginMethodsApi, isLiveLoginMethods, submitForm, tabStore } from './browser';
export {
  addResultText,
  dayText,
  linkForm,
  markPending,
  PROVIDERS,
  reauthForm,
  takePending,
  unlinkResultText,
  type LinkedMethod,
  type LoginMethodsApi,
  type Provider,
} from './flow';
