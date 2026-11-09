// WebAuthn 의식의 옵션 만들기와 확인(@simplewebauthn/server 14.0.3, 소유자 결정 ADR-0205 결정 2, BUILD_ORDER BOT-122, ADR-0206).
// 확인은 라이브러리에 맡긴다: 챌린지·출처·RP ID·유형(webauthn.create·get)·사용자 있음(UP)·사용자 확인(UV)·서명 방식·서명.
// 증명(attestation)은 받지 않는다(none). 서명 횟수 퇴행은 여기서 보지 않는다(저장한 값을 0으로 넘겨 라이브러리 판정을 끄고, 부르는 쪽이 서명이 맞은 뒤 판정한다).
// 라이브러리 오류 문구에는 받은 값(출처·챌린지)이 들어 있어 밖으로 내지 않는다: 맞지 않으면 null이다.
// 라이브러리가 보지 않는 셋은 여기서 더 본다: 다른 사이트 안의 의식(crossOrigin), 자격 ID 1~1023바이트, 본문 rawId와 인증기 데이터의 자격 ID가 같은지.
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { WEBAUTHN_ALGORITHMS } from '../domain/passkey.js';
import type { VerifiedNewPasskey, WebAuthnCeremonies } from '../domain/ports.js';

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
type Transport = 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';
const descriptor = (c: { id: Buffer; transports: string[] }) => ({ id: b64u(c.id), transports: c.transports as Transport[] });
/** 자격 ID 상한(WebAuthn §5.1 credential ID는 1023바이트 이하, docs/data.md admin_passkey) */
const CREDENTIAL_ID_MAX_BYTES = 1023;

/**
 * 다른 사이트 안(iframe)에서 부른 의식인가: clientDataJSON의 crossOrigin이 참이거나 topOrigin이 있으면 참.
 * 14.0.3은 topOrigin이 없으면 crossOrigin을 그냥 받는다. 콘솔은 다른 사이트에 넣지 않으므로 직접 거절한다(새 맥락 리뷰 2026-11-05). 읽지 못하면 참(거절 쪽)
 */
function crossOriginCeremony(response: unknown): boolean {
  try {
    const raw = (response as { response?: { clientDataJSON?: unknown } }).response?.clientDataJSON;
    if (typeof raw !== 'string') return true;
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { crossOrigin?: unknown; topOrigin?: unknown };
    // 라이브러리는 참으로 읽히는 값이면 다른 사이트 분기로 들어가므로, 없거나 false가 아니면 모두 거절한다(재검토 2026-11-05)
    return (c.crossOrigin !== undefined && c.crossOrigin !== false) || c.topOrigin !== undefined;
  } catch {
    return true;
  }
}

export class SimpleWebAuthnCeremonies implements WebAuthnCeremonies {
  async creationOptions(i: Parameters<WebAuthnCeremonies['creationOptions']>[0]): Promise<Record<string, unknown>> {
    return (await generateRegistrationOptions({
      rpName: i.rp.rpName,
      rpID: i.rp.rpId,
      userID: new Uint8Array(i.userId),
      userName: i.userName,
      userDisplayName: i.userDisplayName,
      challenge: new Uint8Array(i.challenge),
      timeout: i.timeoutMs,
      attestationType: 'none',
      excludeCredentials: i.exclude.map(descriptor),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      supportedAlgorithmIDs: [...WEBAUTHN_ALGORITHMS],
    })) as unknown as Record<string, unknown>;
  }

  async verifyCreation(i: Parameters<WebAuthnCeremonies['verifyCreation']>[0]): Promise<VerifiedNewPasskey | null> {
    if (crossOriginCeremony(i.response)) return null;
    try {
      const r = await verifyRegistrationResponse({
        response: i.response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
        expectedChallenge: i.challenge,
        expectedOrigin: i.rp.origin,
        expectedRPID: i.rp.rpId,
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: [...WEBAUTHN_ALGORITHMS],
      });
      if (!r.verified || !r.registrationInfo.userVerified) return null;
      const info = r.registrationInfo;
      // 라이브러리는 인증기 데이터 안의 자격 ID 길이와 본문 rawId가 같은지를 보지 않는다(새 맥락 리뷰 2026-11-05)
      const credentialId = Buffer.from(info.credential.id, 'base64url');
      const rawId = (i.response as { rawId?: unknown }).rawId;
      if (credentialId.length < 1 || credentialId.length > CREDENTIAL_ID_MAX_BYTES) return null;
      if (typeof rawId !== 'string' || !Buffer.from(rawId, 'base64url').equals(credentialId)) return null;
      return {
        credentialId,
        publicKey: Buffer.from(info.credential.publicKey),
        signCount: info.credential.counter,
        transports: [...(info.credential.transports ?? [])],
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        aaguid: info.aaguid,
      };
    } catch {
      return null;
    }
  }

  async requestOptions(i: Parameters<WebAuthnCeremonies['requestOptions']>[0]): Promise<Record<string, unknown>> {
    return (await generateAuthenticationOptions({
      rpID: i.rp.rpId,
      challenge: new Uint8Array(i.challenge),
      timeout: i.timeoutMs,
      userVerification: 'required',
      allowCredentials: i.allow.map(descriptor),
    })) as unknown as Record<string, unknown>;
  }

  async verifyRequest(i: Parameters<WebAuthnCeremonies['verifyRequest']>[0]): Promise<{ signCount: number; backedUp: boolean } | null> {
    if (crossOriginCeremony(i.response)) return null;
    try {
      const r = await verifyAuthenticationResponse({
        response: i.response as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
        expectedChallenge: i.challenge,
        expectedOrigin: i.rp.origin,
        expectedRPID: i.rp.rpId,
        requireUserVerification: true,
        // 저장한 서명 횟수 대신 0을 넘겨 라이브러리의 횟수 판정을 끈다(퇴행은 서명이 맞은 뒤 부르는 쪽이 본다)
        credential: { id: b64u(i.credential.id), publicKey: new Uint8Array(i.credential.publicKey), counter: 0, transports: i.credential.transports as Transport[] },
      });
      if (!r.verified || !r.authenticationInfo.userVerified) return null;
      return { signCount: r.authenticationInfo.newCounter, backedUp: r.authenticationInfo.credentialBackedUp };
    } catch {
      return null;
    }
  }
}
