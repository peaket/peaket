// 돌아갈 주소 safeNext()(docs/frontend.md §5.14 '돌아갈 주소', FE-T12, asvs/auth.md 3.7.2).
// 512자 이하, `/`로 시작, `//`·`/\`로 시작하지 않음, 제어 문자·백슬래시·`%2f%2f`·`%5c`(대소문자 무시)가 없는 같은 출처 경로만 받는다.
// 결과는 경로와 쿼리이고 조각(#)은 버린다. 아니면 앱 첫 화면('/'). 로그인 next, 본인확인 next, 알림 착지 주소가 모두 이 함수를 쓴다.
const BASE = 'http://safe-next.invalid';

export function safeNext(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 512 || !v.startsWith('/')) return '/';
  if (v.startsWith('//') || v.startsWith('/\\') || /[\u0000-\u001f\u007f\\]/.test(v) || /%2f%2f|%5c/i.test(v)) return '/';
  // URL로 풀어 같은 출처인지 보고, 정규화한 경로가 //로 시작하면 막는다(/..//evil 같은 것)
  let u: URL;
  try {
    u = new URL(v, BASE);
  } catch {
    return '/';
  }
  return u.origin === BASE && !u.pathname.startsWith('//') ? `${u.pathname}${u.search}` : '/';
}
