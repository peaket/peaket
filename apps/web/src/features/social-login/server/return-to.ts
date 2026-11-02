// 로그인·재인증 뒤 돌아갈 주소(asvs/auth.md 3.7.2): 정본 safeNext() 규칙(docs/frontend.md §5.14, FE-T12)을 그대로 쓴다.
export { safeNext as safeReturnTo } from '../../../shared/lib/safe-next.ts';
