// 스태프 초대 수락이 보는 휴대폰 본인확인 상태(C2-02). 본인확인 저장소의 기록만 보고,
// 저장소를 쓸 수 없으면 UNAVAILABLE로 닫아 부르는 쪽이 503으로 답하게 한다.
import { Inject, Injectable } from '@nestjs/common';
import { type StaffPhoneVerification } from '../../session/index.js';
import { VERIFICATION_STORE, type VerificationStore } from '../domain/ports.js';

@Injectable()
export class VerificationStaffPhone implements StaffPhoneVerification {
  constructor(@Inject(VERIFICATION_STORE) private readonly store: VerificationStore) {}

  async statusOf(accountId: string): Promise<'VERIFIED' | 'UNVERIFIED' | 'UNAVAILABLE'> {
    try {
      return (await this.store.isVerified(accountId)) ? 'VERIFIED' : 'UNVERIFIED';
    } catch {
      return 'UNAVAILABLE';
    }
  }
}
