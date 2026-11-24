// GAT-030 키 증명 PoC의 QR 두 판을 만든다(docs/review/plans/F-05-1.md §9, ADR-0051 결정 7).
// - QR v1: 월렛이 지금 그리는 93바이트(형식 버전·티켓 ID·keyId·시각·기기 서명)를 base45로 140자.
// - 키 증명 판: QR v1 93바이트 뒤에 서버가 서명한 증명 110바이트 [가정]을 붙인 203바이트(305자).
//   증명 = 형식 버전(1) ‖ keyId(8) ‖ 압축 공개키(33) ‖ 유효 기한(4) ‖ 서명(64).
//   티켓 ID는 QR v1 안에 있고 증명의 서명 대상에 함께 들어간다(바이트를 두 번 싣지 않는다).
// - 서명 64바이트는 디코딩 밀도만 재기 위한 고정 대역이다. ECDSA 검증은 이 측정의 범위가 아니다.
//   같은 입력에 같은 바이트를 내도록 메시지 해시로 채운다(실제 서명은 매번 달라진다).
import { createHash } from 'node:crypto';
import {
  base45Encode,
  concatBytes,
  encodeQrV1,
  qrV1Message,
  uint32BE,
  uuidV7ToBytes,
  QR_V1_BYTES,
  QR_V1_BASE45_LENGTH,
} from '../../../apps/web/src/features/wallet-device-key/qr-v1.ts';
import { qrMatrix } from '../../../apps/web/src/features/wallet-device-key/qr-matrix.ts';

/** 예시 티켓(주석의 UUIDv7 꼴). 2026-11-24T00:00:00Z에 서명한 것으로 둔다 */
export const TICKET_ID = '0190f3a1-7c2e-7a00-8000-000000000101';
export const KEY_ID = Uint8Array.of(0x9f, 0x3c, 0x6a, 0x11, 0x05, 0x7e, 0xd2, 0x84);
export const QR_TIME_SECONDS = 1_795_478_400;
export const PROOF_VERSION = 2;
export const PROOF_VALID_UNTIL_SECONDS = QR_TIME_SECONDS + 3600;
/** 유효한 P-256 공개키의 압축 표현(0x02 + x 32바이트). 측정에는 검증을 걸지 않는다 */
export const SERVER_PUBLIC_KEY = Uint8Array.from([
  0x02, 0x4c, 0x01, 0x0a, 0x59, 0xba, 0x31, 0xde, 0x24, 0xf1, 0xf2, 0xd5, 0x4c, 0xca, 0x7b, 0x34, 0x7f,
  0xbe, 0x10, 0xe2, 0x43, 0x8a, 0x41, 0xec, 0xd1, 0x32, 0xc0, 0x81, 0x70, 0xd1, 0x0b, 0xde, 0x5d,
]);

export const PROOF_HEADER = 'PEAKET-KEY-PROOF-v1';
export const PROOF_BYTES = 110;
export const KEY_PROOF_TOTAL_BYTES = QR_V1_BYTES + PROOF_BYTES;
export const KEY_PROOF_BASE45_LENGTH = 305;

export const QR_ERROR_CORRECTION = 'M';
/** 휴대폰 390px 화면의 90% */
export const QR_CSS_WIDTH = 351;

/** 고정 대역 서명: 메시지 해시 두 개를 이어 64바이트로 만든다(같은 입력 → 같은 바이트) */
function standInSignature(domain, message) {
  const first = createHash('sha256').update(domain).update(message).digest();
  const second = createHash('sha256').update(domain).update('2').update(message).digest();
  return Uint8Array.from(Buffer.concat([first, second]));
}

export function qrV1Fields() {
  return { ticketId: TICKET_ID, keyId: KEY_ID, timeSeconds: QR_TIME_SECONDS };
}

export function qrV1Bytes() {
  const fields = qrV1Fields();
  const signature = standInSignature('PEAKET-QR-v1-test', qrV1Message(fields));
  return encodeQrV1({ ...fields, signature });
}

/** 증명의 서명 대상: "PEAKET-KEY-PROOF-v1" ‖ 티켓 ID(16) ‖ keyId(8) ‖ 공개키(33) ‖ 유효 기한(4) */
export function keyProofMessage({
  ticketId = TICKET_ID,
  keyId = KEY_ID,
  publicKey = SERVER_PUBLIC_KEY,
  validUntilSeconds = PROOF_VALID_UNTIL_SECONDS,
} = {}) {
  return concatBytes(
    new TextEncoder().encode(PROOF_HEADER),
    uuidV7ToBytes(ticketId),
    keyId,
    publicKey,
    uint32BE(validUntilSeconds),
  );
}

export function keyProofBytes() {
  const message = keyProofMessage();
  const signature = standInSignature('PEAKET-KEY-PROOF-v1-test', message);
  const out = new Uint8Array(PROOF_BYTES);
  out[0] = PROOF_VERSION;
  out.set(KEY_ID, 1);
  out.set(SERVER_PUBLIC_KEY, 9);
  out.set(uint32BE(PROOF_VALID_UNTIL_SECONDS), 42);
  out.set(signature, 46);
  return out;
}

export function decodeKeyProof(bytes) {
  if (bytes.length !== PROOF_BYTES) throw new Error(`키 증명은 ${PROOF_BYTES}바이트여야 합니다(받은 ${bytes.length})`);
  if (bytes[0] !== PROOF_VERSION) throw new Error(`지원하지 않는 증명 형식 버전 ${bytes[0]}입니다`);
  return {
    keyId: bytes.slice(1, 9),
    publicKey: bytes.slice(9, 42),
    validUntilSeconds: ((bytes[42] << 24) >>> 0) + (bytes[43] << 16) + (bytes[44] << 8) + bytes[45],
    signature: bytes.slice(46, 110),
  };
}

function panel(id, label, bytes, extras) {
  const text = base45Encode(bytes);
  const matrix = qrMatrix(text, QR_ERROR_CORRECTION);
  return {
    id,
    label,
    bytes,
    text,
    byteLength: bytes.length,
    textLength: text.length,
    matrix: { size: matrix.size, cells: matrix.cells },
    qrVersion: (matrix.size - 17) / 4,
    ...extras,
  };
}

/** 두 판. keyProof.qrBytes는 앞 93바이트(v1)이고 bytes는 증명을 붙인 전체다 */
export function buildPanels() {
  const qrBytes = qrV1Bytes();
  const proof = keyProofBytes();
  return {
    qrV1: panel('qr-v1', '지금 QR v1', qrBytes, {}),
    keyProof: panel('key-proof', '키 증명 판', concatBytes(qrBytes, proof), { qrBytes, proof }),
  };
}

export const EXPECT = {
  qrV1: { bytes: QR_V1_BYTES, text: QR_V1_BASE45_LENGTH, modules: 41, version: 6 },
  keyProof: { bytes: KEY_PROOF_TOTAL_BYTES, text: KEY_PROOF_BASE45_LENGTH, modules: 57, version: 10 },
};
