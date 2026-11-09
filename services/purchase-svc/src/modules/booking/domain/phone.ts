// 예매자 휴대폰 번호를 E.164(국가 번호를 붙이고 앞자리 0과 기호를 뺀 국제 표기)로 맞추는 규칙(docs/features/payment.md §2 '주문 생성의 첫 구현' 예매자·동의,
// BUILD_ORDER PRF-161). identity-svc의 toE164(services/identity-svc/src/modules/session/domain/inv-ref.ts)와 같은 규칙이다:
// 두 서비스가 같은 번호를 같은 글로 맞춰야 조사용 가명(invRef("contact", 번호))이 같아진다(P-T52 ①②). 서비스 사이에 코드를 나누지 않아 규칙을 여기 다시 둔다.
// 순수 함수라 프레임워크·플랫폼 형을 가져오지 않는다.

/**
 * 휴대폰 번호를 E.164로 맞춘다. 규칙(identity와 같다):
 * - 빈칸·하이픈·괄호·점은 뺀다. 그 뒤 '+'(맨 앞 하나)와 숫자 밖의 글자가 남으면 undefined.
 * - '00'으로 시작하면 국제전화 앞자리로 보고 '+'로 바꾼다(0082… → +82…).
 * - '+820'으로 시작하면 국제 표기에 국내 앞자리 0이 남은 것으로 보고 그 0을 뺀다(+82 010… → +8210…).
 * - '+'로 시작하면 그대로, '0'으로 시작하면 국내 번호로 보고 '+82' 뒤에 앞 0을 뺀 나머지를 붙인다. 그 밖(숫자 1~9로 시작)은 undefined.
 * - 결과는 '+' 뒤 숫자 8~15자리이고 첫 숫자는 0이 아니어야 한다(^\+[1-9]\d{7,14}$). '+820'으로 시작하는 값은 E.164가 아니다. 아니면 undefined.
 * 예: '010-1234-5678'·'+82 10-1234-5678'·'+82 010-1234-5678'·'0082 10 1234 5678' → '+821012345678'
 * @returns E.164 글, 맞출 수 없으면 undefined(받는 쪽이 400으로 답한다)
 */
export function toE164(raw: string): string | undefined {
  // 빈칸·하이픈·괄호·점만 뺀다(identity와 같은 글자 묶음). 그 밖의 기호·ASCII 밖 숫자가 남으면 아래 모양 검사에서 걸린다
  const stripped = (typeof raw === 'string' ? raw : '').replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(stripped)) return undefined;
  // 국제전화 앞자리 00은 +로 본다(0082… → +82…)
  const s = stripped.startsWith('00') ? `+${stripped.slice(2)}` : stripped;
  // 국제 표기에 남은 국내 앞자리 0은 하나만 뺀다(+82 010… → +8210…). 빼고도 +820…이면 아래 isE164가 거른다
  const v = s.startsWith('+820') ? `+82${s.slice(4)}` : s.startsWith('+') ? s : s.startsWith('0') ? `+82${s.slice(1)}` : undefined;
  return v !== undefined && isE164(v) ? v : undefined;
}

/** E.164 모양('+' 뒤 숫자 8~15자리, 첫 숫자는 0이 아님). '+820'으로 시작하는 값은 E.164가 아니다(같은 번호가 다른 가명이 되지 않게) */
function isE164(v: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(v) && !v.startsWith('+820');
}
