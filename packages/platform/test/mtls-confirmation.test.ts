// 스캐너 mTLS 선택지의 cnf.x5t#S256 결속(offline-gate §6.1, RFC 8705·RFC 9449).
import { describe, expect, test } from 'vitest';
import { MTLS_CONFIRMATION_CLAIM, mtlsConfirmationOf, mtlsPocBlockers, verifyMtlsConfirmation } from '../src/index.js';

const CERT_A = new TextEncoder().encode('peaket-scanner-cert-a');
const CERT_B = new TextEncoder().encode('peaket-scanner-cert-b');

describe('mTLS cnf.x5t#S256 [GAT-220]', () => {
  test('인증서 DER의 SHA-256 base64url 43자를 만든다', () => {
    const v = mtlsConfirmationOf(CERT_A);
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mtlsConfirmationOf(CERT_A)).toBe(v);
    expect(mtlsConfirmationOf(CERT_B)).not.toBe(v);
    expect(MTLS_CONFIRMATION_CLAIM).toBe('x5t#S256');
  });

  test('mTLS가 아니면 not-mtls이고, 인증서·cnf가 없거나 다르면 거절한다', () => {
    expect(verifyMtlsConfirmation({ mtlsAuthenticated: false, certificateDer: CERT_A, tokenCnf: { [MTLS_CONFIRMATION_CLAIM]: mtlsConfirmationOf(CERT_A) } })).toBe('not-mtls');
    expect(verifyMtlsConfirmation({ mtlsAuthenticated: true, tokenCnf: { [MTLS_CONFIRMATION_CLAIM]: mtlsConfirmationOf(CERT_A) } })).toBe('missing-certificate');
    expect(verifyMtlsConfirmation({ mtlsAuthenticated: true, certificateDer: new Uint8Array(), tokenCnf: { [MTLS_CONFIRMATION_CLAIM]: mtlsConfirmationOf(CERT_A) } })).toBe('missing-certificate');
    expect(verifyMtlsConfirmation({ mtlsAuthenticated: true, certificateDer: CERT_A })).toBe('missing-claim');
    expect(verifyMtlsConfirmation({ mtlsAuthenticated: true, certificateDer: CERT_A, tokenCnf: { [MTLS_CONFIRMATION_CLAIM]: '' } })).toBe('missing-claim');
    expect(verifyMtlsConfirmation({ mtlsAuthenticated: true, certificateDer: CERT_A, tokenCnf: { [MTLS_CONFIRMATION_CLAIM]: mtlsConfirmationOf(CERT_B) } })).toBe('mismatch');
    expect(verifyMtlsConfirmation({ mtlsAuthenticated: true, certificateDer: CERT_A, tokenCnf: { [MTLS_CONFIRMATION_CLAIM]: mtlsConfirmationOf(CERT_A) } })).toBe('ok');
  });

  test('관리형 기기·사설 CA·게이트웨이 인증서 검증이 하나라도 없으면 그 막힘을 돌려준다', () => {
    expect(mtlsPocBlockers({ managedDevices: true, privateCa: true, gatewayVerifiesClientCertificate: true })).toEqual([]);
    expect(mtlsPocBlockers({ managedDevices: false, privateCa: true, gatewayVerifiesClientCertificate: true })).toEqual(['managed-device']);
    expect(mtlsPocBlockers({ managedDevices: true, privateCa: false, gatewayVerifiesClientCertificate: false })).toEqual(['private-ca', 'gateway-client-cert-verification']);
  });
});
