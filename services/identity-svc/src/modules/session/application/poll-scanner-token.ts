// 기기 승인 폴링 → 현장 스태프 토큰(RFC 8628 §3.5, identity §6.1, GAT-220).
// 기기 코드와 기기 키 증명(jkt)이 같은 요청만 받는다. 승인 전에는 authorization_pending, 너무 잦으면 slow_down,
// 거부 access_denied, 만료 expired_token이다. 토큰의 cnf.jkt는 기기 키 지문이고 만료는 역할 유효 끝이다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { hashDeviceCode } from '../domain/device-approval.js';
import { DEVICE_AUTHORIZATIONS, type DeviceAuthorizationStore, SCANNER_DEVICE_REGISTRY, type ScannerDeviceRegistry, TOKEN_SIGNER, type TokenSigner } from '../domain/ports.js';

export type ScannerTokenErrorCode = 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'device_revoked';

export class ScannerTokenError extends Error {
  constructor(
    readonly code: ScannerTokenErrorCode,
    readonly retryAfterSec?: number,
  ) {
    super(`스캐너 토큰 오류: ${code}`);
    this.name = 'ScannerTokenError';
  }
}

export interface ScannerTokenGrant {
  access_token: string;
  token_type: 'DPoP';
  expires_in: number;
}

@Injectable()
export class PollScannerToken {
  constructor(
    @Inject(DEVICE_AUTHORIZATIONS) private readonly store: DeviceAuthorizationStore,
    @Inject(SCANNER_DEVICE_REGISTRY) private readonly registry: ScannerDeviceRegistry,
    @Inject(TOKEN_SIGNER) private readonly signer: TokenSigner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: { deviceCode: string; jkt: string }): Promise<ScannerTokenGrant> {
    const now = this.clock.now();
    const auth = await this.store.get(hashDeviceCode(i.deviceCode));
    if (!auth || auth.jkt !== i.jkt) throw new ScannerTokenError('expired_token');

    // 승인 요청과 토큰 발급 사이에 기기가 폐기될 수 있어 토큰을 줄 때 한 번 더 본다(identity §6.1).
    const device = await this.registry.byThumbprint(i.jkt);
    if (!device.found || device.status !== 'ACTIVE') throw new ScannerTokenError('device_revoked');

    const poll = await this.store.notePoll(auth.deviceCodeHash, now);
    if (poll.result === 'SLOW_DOWN') throw new ScannerTokenError('slow_down', Math.max(1, Math.ceil(poll.retryAfterMs / 1000)));
    if (poll.result === 'EXPIRED') throw new ScannerTokenError('expired_token');
    if (poll.result === 'DENIED') throw new ScannerTokenError('access_denied');
    if (poll.result === 'PENDING') throw new ScannerTokenError('authorization_pending');
    if (poll.result !== 'APPROVED') throw new ScannerTokenError('authorization_pending');

    const approved = poll.approved;
    if (approved.expiresAtMs <= now) throw new ScannerTokenError('expired_token');
    let token: { token: string; expiresAt: number };
    try {
      token = await this.signer.staff(
        { accountId: approved.accountId, scannerSessionId: approved.scannerSessionId, eventId: approved.eventId, jkt: i.jkt, expiresAtMs: approved.expiresAtMs },
        now,
      );
    } catch {
      throw new ScannerTokenError('expired_token');
    }
    return { access_token: token.token, token_type: 'DPoP', expires_in: Math.max(0, Math.floor((token.expiresAt - now) / 1000)) };
  }
}
