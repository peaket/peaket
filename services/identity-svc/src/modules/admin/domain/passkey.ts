// 관리 계정 패스키와 재인증의 순수 규칙(docs/features/identity.md §6 '관리 계정 패스키의 첫 구현', BUILD_ORDER BOT-122, ADR-0206).
// 패스키(WebAuthn)는 로그인에 쓰지 않고 위험 작업 직전의 재인증에만 쓴다. RP ID는 콘솔 출처의 호스트이고, 사용자 확인(UV)은 필수다.
import type { AdminAud, AdminRole } from './ports.js';

/** 작업 묶음 act(docs/security/authz-matrix.md §6 '작업 묶음 act의 값'). ACCOUNT_SECURITY는 내 패스키 등록·지우기(identity가 직접 받는다) */
export type ReauthAct = 'OPS_COMMAND' | 'APPROVAL' | 'PERMISSION_CHANGE' | 'PAYOUT_ACCOUNT' | 'BOOKER_EXPORT' | 'AUTHORITY_DATA' | 'ACCOUNT_SECURITY';
/** 콘솔마다 받는 작업 묶음 */
export const REAUTH_ACTS_OF_AUD: Readonly<Record<AdminAud, readonly ReauthAct[]>> = Object.freeze({
  partner: ['PAYOUT_ACCOUNT', 'BOOKER_EXPORT', 'ACCOUNT_SECURITY'],
  ops: ['OPS_COMMAND', 'APPROVAL', 'PERMISSION_CHANGE', 'AUTHORITY_DATA', 'ACCOUNT_SECURITY'],
});
/** 재인증 토큰 factors에 싣는 요소(확인한 것만, 이 차례로) */
export type ReauthFactor = 'password' | 'totp' | 'passkey';

/** 재인증 토큰 수명 5분(identity §13) */
export const ADMIN_REAUTH_TTL_MS = 5 * 60_000;
/** 챌린지(등록 ID·재인증 단계) 수명 5분 [가정]: WebAuthn 권고(사용자 확인을 요구하면 5~10분)의 아래 끝, 로그인 단계 수명과 같다 */
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60_000;
/** 챌린지 바이트 수(ASVS 6.7.2의 64비트보다 길게) */
export const WEBAUTHN_CHALLENGE_BYTES = 32;
/** 한 계정의 패스키 상한 [가정] */
export const PASSKEY_LIMIT = 10;
/** 패스키가 하나 이상 있어야 하는 역할: 마지막 하나는 지우지 못한다(identity §6 'MFA' 행의 등록 의무) */
export const PASSKEY_REQUIRED_ROLES: readonly AdminRole[] = ['partner_admin', 'operator', 'commander'];
/** 받는 서명 방식(COSE): ES256, EdDSA, RS256 */
export const WEBAUTHN_ALGORITHMS: readonly number[] = [-7, -8, -257];
/** 이름표가 없을 때 */
export const DEFAULT_PASSKEY_NAME = '패스키';
const NAME_MAX = 30;
/** 제어 문자(C0·C1)와 양방향 제어 문자 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩؜]/gu;

/**
 * 서명 횟수 판정: 저장한 값과 받은 값이 모두 0이면 받는다(동기화 패스키). 받은 값이 더 크면 받는다.
 * 그 밖(같거나 작음, 세던 인증기가 0을 보냄)은 복제한 인증기의 신호로 보고 거절한다(WebAuthn §6.1.1, ADR-0206 결정 7)
 */
export function signCountAccepted(stored: number, received: number): boolean {
  if (stored === 0 && received === 0) return true;
  return received > stored;
}

/** 이름표: NFC, 제어 문자를 지우고 앞뒤 빈칸을 지운 1~30자(코드포인트, openapi maxLength와 같은 단위) [가정]. 비면 기본 이름, 길면 null */
export function normalizePasskeyName(raw: string | undefined): string | null {
  const s = (raw ?? '').normalize('NFC').replace(CONTROL, '').trim();
  if (s.length === 0) return DEFAULT_PASSKEY_NAME;
  return [...s].length > NAME_MAX ? null : s;
}

/** 계정 보안 설정(ACCOUNT_SECURITY) 재인증 토큰이 충분한가: password·totp가 있고, 패스키가 이미 있으면 passkey도 있다 */
export function accountSecurityAllows(factors: readonly string[], hasPasskey: boolean): boolean {
  return factors.includes('password') && factors.includes('totp') && (!hasPasskey || factors.includes('passkey'));
}

/** 신뢰 당사자(RP) 하나: RP ID는 콘솔 출처의 호스트, 출처는 그 콘솔 출처 하나 */
export interface RelyingParty {
  rpId: string;
  origin: string;
  rpName: string;
}
export type RelyingParties = Readonly<Record<AdminAud, RelyingParty>>;

const SETTING: Record<AdminAud, string> = { partner: 'PEAKET_PARTNER_CONSOLE_ORIGIN', ops: 'PEAKET_OPS_CONSOLE_ORIGIN' };
const RP_NAME: Record<AdminAud, string> = { partner: 'PEAKET 파트너', ops: 'PEAKET 관제' };

/**
 * 콘솔 출처 설정에서 RP를 만든다(시작 검사). 경로·쿼리·조각이 없는 출처여야 하고, local·ci 밖에서는 https만 받는다(local·ci는 http://localhost도).
 * RP ID는 따로 설정하지 않고 출처의 호스트로 정한다(설정끼리 어긋날 길을 없앤다). 두 콘솔의 RP ID가 같으면 패스키가 섞이므로 시작하지 않는다
 */
export function relyingPartiesOf(origins: Readonly<Record<AdminAud, string>>, o: { env: string }): RelyingParties {
  const local = o.env === 'local' || o.env === 'ci';
  const one = (aud: AdminAud): RelyingParty => {
    const raw = origins[aud];
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`${SETTING[aud]}가 출처 주소가 아니다`);
    }
    if (u.origin !== raw.replace(/\/$/, '') || u.username || u.password) throw new Error(`${SETTING[aud]}는 경로·쿼리 없는 출처여야 한다(패스키 출처, ADR-0206)`);
    const https = u.protocol === 'https:';
    if (!https && !(local && u.protocol === 'http:' && u.hostname === 'localhost')) throw new Error(`${SETTING[aud]}는 https 출처여야 한다(local·ci만 http://localhost를 받는다)`);
    return { rpId: u.hostname, origin: u.origin, rpName: RP_NAME[aud] };
  };
  const rps = { partner: one('partner'), ops: one('ops') };
  if (rps.partner.rpId === rps.ops.rpId && !local) throw new Error('파트너·관제 콘솔의 RP ID(출처 호스트)가 같다: 두 콘솔의 패스키가 섞인다(ADR-0206 결정 2)');
  return Object.freeze(rps);
}
