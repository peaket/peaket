// 입장용 기기 공개키 등록·폐기 유스케이스(FR-012, POL-018, ADR-0025·0050 결정 2·ADR-0051 결정 10·11).
// 키는 월렛의 '이 휴대폰을 입장용으로 등록' 버튼으로만 만든다. 서버는 공개키만 받고 keyId를 계산해 등록한다.
// 입장 시작 뒤 ISSUE·REISSUE는 재인증이 필요하고, BOOTH는 부스 허용이 있어야 한다(지금은 재인증·부스 허용 저장소가 없어 403).
import type { Clock } from '@peaket/platform';
import { assertReason, deviceKeyMaterialOf, type DeviceKeyReason, type PublicKeyJwk } from '../domain/device-key.js';
import type { DeviceKeyRegistrationResult, DeviceKeyStore } from '../domain/ports.js';

export type DeviceKeyErrorCode = 'NOT_FOUND' | 'NOT_HOLDER' | 'REAUTH_REQUIRED' | 'ENTRY_STARTED' | 'REISSUE_LIMIT' | 'BOOTH_NOT_ALLOWED' | 'TRANSFER_NOT_ALLOWED' | 'INVALID_KEY';

export class DeviceKeyError extends Error {
  constructor(readonly code: DeviceKeyErrorCode) {
    super(`기기 키 처리 오류: ${code}`);
    this.name = 'DeviceKeyError';
  }
}

/** 재인증 토큰 확인(identity 재인증 서명 확인이 생기면 그 어댑터를 꽂는다). 지금은 false면 403 reauth-required */
export interface ReauthGate {
  verify(token: string | undefined, q: { accountId: string; sessionId: string }): Promise<boolean>;
}

export interface DeviceKeysDeps {
  readonly store: DeviceKeyStore;
  readonly clock: Clock;
  /** 없으면 재인증이 필요한 요청은 모두 거절한다 */
  readonly reauth?: ReauthGate;
}

export interface RegisterDeviceKeyInput {
  readonly ticketId: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly reauthToken?: string;
  readonly publicKeyJwk: PublicKeyJwk;
  readonly reason: DeviceKeyReason;
  readonly boothRequestId?: string;
}

export class DeviceKeys {
  constructor(private readonly d: DeviceKeysDeps) {}

  async register(i: RegisterDeviceKeyInput): Promise<{ keyId: string }> {
    const reason = assertReason(i.reason);
    const material = deviceKeyMaterialOf(i.publicKeyJwk);
    const now = this.d.clock.now();
    const reauth = reason === 'REISSUE' || reason === 'BOOTH' || reason === 'ISSUE' ? await this.#reauth(i) : false;
    if ((reason === 'REISSUE' || reason === 'BOOTH') && !reauth) throw new DeviceKeyError('REAUTH_REQUIRED');
    if (reason === 'BOOTH') throw new DeviceKeyError('BOOTH_NOT_ALLOWED');
    const r: DeviceKeyRegistrationResult = await this.d.store.register({
      ticketId: i.ticketId,
      accountId: i.accountId,
      keyId: material.keyId,
      publicKey: material.publicKey,
      reason,
      nowMs: now,
      reauthVerified: reauth,
    });
    switch (r.kind) {
      case 'REGISTERED':
        return { keyId: r.keyId };
      case 'NOT_FOUND':
      case 'NOT_HOLDER':
        throw new DeviceKeyError('NOT_FOUND');
      case 'ENTRY_STARTED':
        throw new DeviceKeyError('ENTRY_STARTED');
      case 'REAUTH_REQUIRED':
        throw new DeviceKeyError('REAUTH_REQUIRED');
      case 'REISSUE_LIMIT':
        throw new DeviceKeyError('REISSUE_LIMIT');
      case 'TRANSFER_NOT_ALLOWED':
        throw new DeviceKeyError('TRANSFER_NOT_ALLOWED');
    }
  }

  async #reauth(i: RegisterDeviceKeyInput): Promise<boolean> {
    if (!this.d.reauth) return false;
    try {
      return await this.d.reauth.verify(i.reauthToken, { accountId: i.accountId, sessionId: i.sessionId });
    } catch {
      return false;
    }
  }
}
