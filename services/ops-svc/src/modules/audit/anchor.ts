// 감사 체크포인트의 공개 앵커·서명(BAT-465 R-584, docs/features/control-tower.md §7, ADR-0075).
// 체크포인트 루트를 Ed25519로 서명해 앵커로 남긴다. 공개키만 있으면 누구나 그 루트가 PEAKET이 만든 것임을 확인할 수 있다(검증 경로 GET /v1/ops/audit-anchors/{checkpointId}).
// 앵커를 외부 불변 저장소(S3 Object Lock)에 싣는 일은 포트(AuditAnchorPublisher)로 두고, 이번 몫은 로컬 참조(local:<id>)와 서명·검증까지다.
// 키는 환경 값에서 온다: PEAKET_AUDIT_ANCHOR_PRIVATE_KEY(PKCS8 PEM, \n은 문자 그대로)와 PEAKET_AUDIT_ANCHOR_KEY_ID.
// 값이 없으면 local·ci만 시작 때 만든 임시 키를 쓴다(재시작하면 검증이 실패하므로 운영에서는 금지).
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from 'node:crypto';

/** 서명 대상 바이트의 판. 서명 규칙을 바꾸면 이 값을 올린다 */
export const AUDIT_ANCHOR_MESSAGE_VERSION = 'audit-checkpoint-v1';

export interface AuditAnchorTarget {
  readonly checkpointId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly rootHash: string;
  readonly prevCheckpointHash: string;
  readonly createdAtMs: number;
}

/** 서명 대상: 판, 체크포인트 ID, 구간, 루트, 직전 루트, 만든 시각(ISO). 줄바꿈으로 잇는다 */
export function auditAnchorMessage(t: AuditAnchorTarget): Buffer {
  return Buffer.from(
    [AUDIT_ANCHOR_MESSAGE_VERSION, t.checkpointId, String(t.fromSeq), String(t.toSeq), t.rootHash, t.prevCheckpointHash, new Date(t.createdAtMs).toISOString()].join('\n'),
    'utf8',
  );
}

export interface AuditAnchorSignature {
  /** base64 서명 */
  readonly signature: string;
  readonly keyId: string;
}

export interface AuditAnchorSigner {
  readonly keyId: string;
  /** 공개키(SPKI PEM). 공개 앵커 응답에 실어 검증하는 쪽이 쓴다 */
  readonly publicKeyPem: string;
  sign(t: AuditAnchorTarget): AuditAnchorSignature;
  verify(t: AuditAnchorTarget, signature: string): boolean;
}

/** 공개키만으로 서명을 확인하는 쪽(감사자·검증 경로). 키는 SPKI PEM이다 */
export class Ed25519AuditAnchorVerifier {
  readonly #public: KeyObject;
  readonly publicKeyPem: string;

  constructor(
    publicKeyPem: string,
    readonly keyId: string,
  ) {
    this.#public = createPublicKey({ key: publicKeyPem, format: 'pem' });
    this.publicKeyPem = this.#public.export({ type: 'spki', format: 'pem' }).toString();
  }

  verify(t: AuditAnchorTarget, signature: string): boolean {
    try {
      return verify(null, auditAnchorMessage(t), this.#public, Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  }
}

/** Ed25519 서명기. 키는 PKCS8 PEM이고 공개키는 그 키에서 만든다 */
export class Ed25519AuditAnchorSigner extends Ed25519AuditAnchorVerifier implements AuditAnchorSigner {
  readonly #private: KeyObject;

  constructor(privateKeyPem: string, keyId: string) {
    const privateKey = createPrivateKey({ key: privateKeyPem, format: 'pem' });
    super(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString(), keyId);
    this.#private = privateKey;
  }

  sign(t: AuditAnchorTarget): AuditAnchorSignature {
    return { signature: sign(null, auditAnchorMessage(t), this.#private).toString('base64'), keyId: this.keyId };
  }
}

/** 시작 때 만든 임시 키(시험·로컬 전용). 같은 프로세스 안에서만 검증이 된다 */
export function ephemeralAuditAnchorSigner(keyId = 'ephemeral'): Ed25519AuditAnchorSigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new Ed25519AuditAnchorSigner(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), keyId);
}

export interface AuditAnchorSignerFromEnv {
  readonly signer: AuditAnchorSigner;
  /** 환경 값이 없어 임시 키를 쓴 경우의 경고 한 줄 */
  readonly warning?: string;
}

/**
 * 환경 값에서 서명기를 만든다. 개인키가 있으면 그 키를, 없으면 local·ci만 임시 키를 쓴다.
 * @throws Error 개인키가 PEM이 아님, 또는 local·ci가 아닌데 개인키가 없음(시작 실패)
 */
export function auditAnchorSignerFromEnv(env: Record<string, string | undefined>): AuditAnchorSignerFromEnv {
  const pem = env.PEAKET_AUDIT_ANCHOR_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  const keyId = env.PEAKET_AUDIT_ANCHOR_KEY_ID?.trim() || 'audit-anchor-v1';
  if (pem) {
    try {
      return { signer: new Ed25519AuditAnchorSigner(pem, keyId) };
    } catch (err) {
      throw new Error(`PEAKET_AUDIT_ANCHOR_PRIVATE_KEY가 Ed25519 PKCS8 PEM이 아니다: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }
  const peaketEnv = env.PEAKET_ENV || 'prod';
  if (!['local', 'ci', 'demo'].includes(peaketEnv)) {
    throw new Error('PEAKET_AUDIT_ANCHOR_PRIVATE_KEY가 없다(감사 체크포인트 서명 키. local·ci·demo만 임시 키를 쓴다)');
  }
  return { signer: ephemeralAuditAnchorSigner(keyId), warning: 'PEAKET_AUDIT_ANCHOR_PRIVATE_KEY가 없어 임시 Ed25519 키로 감사 체크포인트를 서명한다(재시작하면 검증이 실패한다)' };
}
