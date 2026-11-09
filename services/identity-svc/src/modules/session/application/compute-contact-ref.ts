// 주문 예매자 번호의 연락처 가명(ContactRefService.ComputeContactRef, purchase-svc만, identity §9.1 '조사용 값의 첫 구현', BUILD_ORDER BOT-045, I-T64 ②).
// 번호는 저장하거나 로그에 쓰지 않고 invRef("contact", 번호)만 돌려준다. 파드마다 초당 상한을 넘으면 거절한다(번호를 하나씩 넣어 보는 대입을 막으려는 것이다).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { isE164 } from '../domain/inv-ref.js';
import { INV_REFS, type InvRefs } from '../domain/ports.js';
import { InvRefError } from './inv-ref-error.js';

export const CONTACT_REF_RPS = Symbol('identity.ContactRefRps');
/** 파드마다 초당 상한 [가정](주문 설계 피크의 2배를 파드 수로 나눈 값보다 넉넉히, PEAKET_CONTACT_REF_RPS로 바꾼다) */
export const DEFAULT_CONTACT_REF_RPS = 2_000;

@Injectable()
export class ComputeContactRef {
  #second = -1;
  #used = 0;
  constructor(
    @Inject(INV_REFS) private readonly refs: InvRefs,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(CONTACT_REF_RPS) private readonly rps: number = DEFAULT_CONTACT_REF_RPS,
  ) {}

  /** @throws InvRefError INVALID·EXHAUSTED·UNAVAILABLE */
  run(phoneE164: string): string {
    if (typeof phoneE164 !== 'string' || !isE164(phoneE164)) throw new InvRefError('INVALID', '휴대폰 번호가 E.164 모양이 아니다');
    const second = Math.floor(this.clock.now() / 1000);
    if (second !== this.#second) {
      this.#second = second;
      this.#used = 0;
    }
    if (this.#used >= this.rps) throw new InvRefError('EXHAUSTED', '초당 상한을 넘었다');
    this.#used += 1;
    const ref = this.refs.ref('contact', phoneE164);
    if (!ref) throw new InvRefError('UNAVAILABLE', '연락처 라벨 키가 없다');
    return ref;
  }
}
