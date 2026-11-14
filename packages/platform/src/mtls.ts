// 스캐너 mTLS 선택지의 확인 값(RFC 8705 `cnf.x5t#S256`, RFC 9449 §6, offline-gate §6.1).
// 기본안은 기기 키+DPoP다. mTLS는 관리형 기기·사설 CA·게이트웨이 클라이언트 인증서 검증이 모두 갖춰졌을 때만 켠다.
// 이 파일은 계약·시험이 함께 쓰는 순수 함수만 둔다(게이트웨이 헤더를 스스로 믿지 않는다).
import { createHash } from 'node:crypto';

/** 스태프 토큰 cnf 안의 인증서 SHA-256 지문 이름(RFC 8705 §3.1) */
export const MTLS_CONFIRMATION_CLAIM = 'x5t#S256';

/** DER 인증서의 SHA-256 base64url. 토큰 cnf.x5t#S256와 같은 값이다 */
export function mtlsConfirmationOf(certificateDer: Uint8Array): string {
  return createHash('sha256').update(certificateDer).digest('base64url');
}

export type MtlsConfirmationDecision = 'ok' | 'not-mtls' | 'missing-certificate' | 'missing-claim' | 'mismatch';

/**
 * mTLS로 인증된 요청의 토큰 cnf가 그 인증서에 묶였는지 본다.
 * mtlsAuthenticated는 게이트웨이가 TLS 계층에서 검증을 마쳤다는 뜻이며, 클라이언트가 보낸 헤더를 그대로 쓰면 안 된다.
 * - not-mtls: mTLS가 아니다(기본 DPoP 경로)
 * - missing-certificate: mTLS라는데 인증서 DER이 없다 → 거절
 * - missing-claim: 토큰에 cnf.x5t#S256가 없다 → 거절
 * - mismatch: 다른 인증서다 → 거절
 */
export function verifyMtlsConfirmation(i: { mtlsAuthenticated: boolean; certificateDer?: Uint8Array; tokenCnf?: Record<string, unknown> }): MtlsConfirmationDecision {
  if (!i.mtlsAuthenticated) return 'not-mtls';
  if (!i.certificateDer || i.certificateDer.length === 0) return 'missing-certificate';
  const claim = i.tokenCnf?.[MTLS_CONFIRMATION_CLAIM];
  if (typeof claim !== 'string' || claim === '') return 'missing-claim';
  return claim === mtlsConfirmationOf(i.certificateDer) ? 'ok' : 'mismatch';
}

/** mTLS 선택지를 켜도 되는 환경인가. 하나라도 없으면 켜지 않는다(정확한 막힘을 돌려준다) */
export const MTLS_POC_BLOCKERS = ['managed-device', 'private-ca', 'gateway-client-cert-verification'] as const;
export type MtlsPocBlocker = (typeof MTLS_POC_BLOCKERS)[number];

export function mtlsPocBlockers(env: { managedDevices: boolean; privateCa: boolean; gatewayVerifiesClientCertificate: boolean }): MtlsPocBlocker[] {
  const blockers: MtlsPocBlocker[] = [];
  if (!env.managedDevices) blockers.push('managed-device');
  if (!env.privateCa) blockers.push('private-ca');
  if (!env.gatewayVerifiesClientCertificate) blockers.push('gateway-client-cert-verification');
  return blockers;
}
