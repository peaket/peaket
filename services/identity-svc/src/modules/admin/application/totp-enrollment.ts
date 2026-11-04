// 관리 계정 TOTP 등록(identity §6 '관리 계정 TOTP와 로그인 2단계의 첫 구현', BUILD_ORDER BOT-120). 받는 경로(초대 수락 SCR-020 ④·재초대)는 BOT-150이 붙인다.
// 시작: 새 시드를 대기 칸에 암호화해 두고 otpauth 주소를 준다. 확인: 맞는 코드면 시드를 확정하고(그 시간 칸을 적어 재사용을 막는다) 복구 코드 10개를 새로 만든다(한 번만 보인다).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { ADMIN_SECOND_STEP_STORE, type AdminPasswords, type AdminSecondStepStore, RECOVERY_CODE_HASHER, TOTP_SEED_CIPHER, type TotpSeedCipher } from '../domain/ports.js';
import { matchTotp, newRecoveryCode, newTotpSeed, normalizeRecoveryCode, otpauthUri, RECOVERY_CODE_COUNT } from '../domain/totp.js';

export class TotpEnrollmentError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'NOT_STARTED' | 'CODE_INVALID') {
    super(code);
    this.name = 'TotpEnrollmentError';
  }
}

@Injectable()
export class BeginTotpEnrollment {
  constructor(
    @Inject(ADMIN_SECOND_STEP_STORE) private readonly store: AdminSecondStepStore,
    @Inject(TOTP_SEED_CIPHER) private readonly cipher: TotpSeedCipher,
  ) {}

  async run(i: { accountId: string; now?: number }): Promise<{ otpauthUri: string }> {
    const t = await this.store.getTotp(i.accountId);
    if (!t) throw new TotpEnrollmentError('NOT_FOUND');
    const seed = newTotpSeed();
    try {
      if (!(await this.store.setTotpPending(i.accountId, await this.cipher.encrypt(i.accountId, seed), i.now ?? Date.now()))) throw new TotpEnrollmentError('NOT_FOUND');
      return { otpauthUri: otpauthUri(seed, t.email) };
    } finally {
      seed.fill(0);
    }
  }
}

@Injectable()
export class ConfirmTotpEnrollment {
  constructor(
    @Inject(ADMIN_SECOND_STEP_STORE) private readonly store: AdminSecondStepStore,
    @Inject(TOTP_SEED_CIPHER) private readonly cipher: TotpSeedCipher,
    @Inject(RECOVERY_CODE_HASHER) private readonly hasher: AdminPasswords,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: { accountId: string; code: string }): Promise<{ recoveryCodes: string[] }> {
    const t = await this.store.getTotp(i.accountId);
    if (!t) throw new TotpEnrollmentError('NOT_FOUND');
    if (!t.pendingEnc) throw new TotpEnrollmentError('NOT_STARTED');
    const now = this.clock.now();
    const seed = await this.cipher.decrypt(i.accountId, t.pendingEnc);
    const step = matchTotp(seed, i.code, now, null);
    seed.fill(0);
    if (step === null) throw new TotpEnrollmentError('CODE_INVALID');
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const recoveryPhcs = await Promise.all(codes.map((c) => this.hasher.hash(i.accountId, normalizeRecoveryCode(c)!)));
    if (!(await this.store.confirmTotp(i.accountId, { seedEnc: t.pendingEnc, step, recoveryPhcs, now }))) throw new TotpEnrollmentError('NOT_FOUND');
    return { recoveryCodes: codes };
  }
}
