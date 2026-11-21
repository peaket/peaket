// 검증 묶음(ADR-0348 결정 8, ADR-0075 결정 8). 기록 하나가 공개 체크포인트에 들어 있음을 피켓 없이 확인하게 하는 파일이다.
// 꼴(판 1, JSON):
// {
//   "version": 1,
//   "checkpoint": { "no", "checkpointId", "json"(체크포인트 JSON 글 그대로), "checkpointHash"(SHA-256(json) 16진), "signature"(DER base64), "keyId",
//                   "signatureAlg": "ECDSA_P256_SHA256", "publicKeyPem"(SPKI PEM), "otsProof"(.ots base64, 아직 없으면 null) },
//   "record": { "seq", "recordJson"(정규화 기록 글), "prevHash"(직전 기록 해시 16진, 첫 기록은 빈 글), "recordSha256"(16진), "leafSalt"(16진 64자) },
//   "inclusionProof": { "leafIndex"(0부터, = seq − firstSeq), "treeSize"(= leafCount), "path": [형제 해시 16진, 잎 쪽부터] }
// }
// 확인 차례(tools/audit-verify): recordSha256 = SHA-256(UTF-8(prevHash 16진 글) ‖ UTF-8(recordJson)) → 잎 = SHA-256(0x00 ‖ 'PEAKET-audit-leaf-v1' ‖ seq u64 BE ‖ recordSha256 ‖ leafSalt)
//   → 포함 증명(RFC 9162 §2.1.3.2) → 루트 = JSON의 merkleRoot → 서명(publicKeyPem, ECDSA P-256 / SHA-256(json)) → 증명 파일의 대상 해시 = checkpointHash.
// 잎 솔트가 실리는 외부 제공 자료라 commander만 내보내고, 내보내기는 감사 기록 AUDIT_BUNDLE_EXPORTED로 남는다.
import type { AuditCheckpoint } from './checkpoint.js';

export const AUDIT_BUNDLE_VERSION = 1;

export interface AuditVerificationBundle {
  readonly version: typeof AUDIT_BUNDLE_VERSION;
  readonly checkpoint: {
    readonly no: number;
    readonly checkpointId: string;
    readonly json: string;
    readonly checkpointHash: string;
    readonly signature: string;
    readonly keyId: string;
    readonly signatureAlg: string;
    readonly publicKeyPem: string;
    readonly otsProof: string | null;
  };
  readonly record: {
    readonly seq: number;
    readonly recordJson: string;
    readonly prevHash: string;
    readonly recordSha256: string;
    readonly leafSalt: string;
  };
  readonly inclusionProof: {
    readonly leafIndex: number;
    readonly treeSize: number;
    readonly path: readonly string[];
  };
}

export interface BundleParts {
  readonly checkpoint: AuditCheckpoint;
  readonly publicKeyPem: string;
  readonly alg: string;
  readonly seq: number;
  readonly recordJson: string;
  readonly prevHash: string;
  readonly recordSha256: string;
  readonly leafSalt: string;
  readonly leafIndex: number;
  readonly treeSize: number;
  readonly path: readonly string[];
}

/** 묶음 값을 만든다(부르는 쪽이 루트·기록 해시를 이미 확인했다) */
export function verificationBundleOf(p: BundleParts): AuditVerificationBundle {
  const c = p.checkpoint;
  if (c.no === undefined || c.checkpointJson === undefined || c.checkpointHash === undefined || c.signature === undefined || c.keyId === undefined) {
    throw new Error('서명한 공개 체크포인트만 묶음으로 낸다');
  }
  return {
    version: AUDIT_BUNDLE_VERSION,
    checkpoint: {
      no: c.no,
      checkpointId: c.checkpointId,
      json: c.checkpointJson,
      checkpointHash: c.checkpointHash,
      signature: c.signature,
      keyId: c.keyId,
      signatureAlg: p.alg,
      publicKeyPem: p.publicKeyPem,
      otsProof: c.otsProof ? c.otsProof.toString('base64') : null,
    },
    record: { seq: p.seq, recordJson: p.recordJson, prevHash: p.prevHash, recordSha256: p.recordSha256, leafSalt: p.leafSalt },
    inclusionProof: { leafIndex: p.leafIndex, treeSize: p.treeSize, path: [...p.path] },
  };
}
