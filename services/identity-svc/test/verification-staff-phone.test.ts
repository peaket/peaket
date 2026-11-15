// 스태프 초대가 보는 휴대폰 본인확인 어댑터(C2-02). 본인확인 저장소의 기록만 보고, 저장소 장애는 UNAVAILABLE로 닫는다.
import { describe, expect, test } from 'vitest';
import type { VerificationStore } from '../src/modules/verification/domain/ports.js';
import { VerificationStaffPhone } from '../src/modules/verification/adapters/verification-staff-phone.js';

const adapter = (isVerified: (accountId: string) => Promise<boolean>, seen: string[] = []): VerificationStaffPhone =>
  new VerificationStaffPhone({
    isVerified: async (accountId: string) => {
      seen.push(accountId);
      return isVerified(accountId);
    },
  } as unknown as VerificationStore);

describe('VerificationStaffPhone [C2-02]', () => {
  test('본인확인 기록이 있으면 VERIFIED, 없으면 UNVERIFIED, 저장소를 쓸 수 없으면 UNAVAILABLE이다', async () => {
    const seen: string[] = [];
    await expect(adapter(async () => true, seen).statusOf('account-1')).resolves.toBe('VERIFIED');
    await expect(adapter(async () => false, seen).statusOf('account-2')).resolves.toBe('UNVERIFIED');
    await expect(
      adapter(async () => {
        throw new Error('본인확인 저장소 장애');
      }, seen).statusOf('account-3'),
    ).resolves.toBe('UNAVAILABLE');
    expect(seen).toEqual(['account-1', 'account-2', 'account-3']);
  });
});
