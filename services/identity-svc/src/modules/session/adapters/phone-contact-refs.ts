// 본인확인 결과 번호의 연락처 가명(본인확인 컨텍스트의 PhoneRefs 포트를 라벨 키 링으로 채운다, identity §9.1 '조사용 값의 첫 구현', BUILD_ORDER BOT-045).
// 번호를 E.164로 맞추고 invRef("contact", 번호)를 계산한다. 맞출 수 없는 번호는 계산하지 않는다(세지도 않는다).
import { toE164 } from '../domain/inv-ref.js';
import type { InvRefs } from '../domain/ports.js';

export function phoneContactRefs(refs: InvRefs): { ref(rawPhone: string): string | undefined } {
  return {
    ref(rawPhone) {
      const e164 = toE164(rawPhone);
      return e164 === null ? undefined : refs.ref('contact', e164);
    },
  };
}
