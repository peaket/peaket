// 회전 QR 프레임의 순수 계산(offline-gate §3, POL-018). 15초마다 그 순간의 보정 시각으로 다시 서명한다.
// 화면이 다시 보이는 순간(visibilitychange)에도 같은 함수로 새 프레임을 만든다. 실제 타이머·서명 호출은 ui/DeviceQr.tsx가 맡는다.
import { signQrV1 } from './device-key.ts';
import { base45Encode, encodeQrV1, type QrV1Fields } from './qr-v1.ts';

export const QR_FRAME_SECONDS = 15;

/** QR 서명에 필요한 최소 모양(저장한 키에서 개인키·keyId만 꺼내 쓴다) */
export interface QrSigner {
  privateKey: CryptoKey;
  keyId: Uint8Array;
  keyIdText: string;
}

export interface QrFrame {
  ticketId: string;
  /** keyId 8바이트의 base64url 11자 */
  keyId: string;
  timeSeconds: number;
  /** QR v1 93바이트 */
  bytes: Uint8Array;
  /** QR에 싣는 base45 140자 */
  text: string;
}

/** 유닉스 밀리초 → QR v1 시각(부호 없는 32비트 초) */
export function qrTimeSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000) >>> 0;
}

/** 15초 프레임 번호. 같은 프레임이면 같은 시각·같은 서명을 쓴다 */
export function qrFrameIndex(nowMs: number): number {
  return Math.floor(qrTimeSeconds(nowMs) / QR_FRAME_SECONDS);
}

/** 다음 15초 경계까지 남은 밀리초(1~15000) */
export function msUntilNextQrFrame(nowMs: number): number {
  const remainder = nowMs % (QR_FRAME_SECONDS * 1000);
  return remainder === 0 ? QR_FRAME_SECONDS * 1000 : QR_FRAME_SECONDS * 1000 - remainder;
}

/** 화면에 든 프레임이 15초를 지났는가(잠금·서명 실패·탭 복귀 지연) */
export function qrFrameStale(frameTimeSeconds: number, nowMs: number): boolean {
  return qrTimeSeconds(nowMs) - frameTimeSeconds >= QR_FRAME_SECONDS;
}

/** 그 시각의 QR v1 프레임을 만든다. 서명은 기기 개인키로 하고 개인키는 꺼내지 않는다 */
export async function createQrFrame(key: QrSigner, ticketId: string, timeSeconds: number, subtle?: SubtleCrypto): Promise<QrFrame> {
  const fields: QrV1Fields = { ticketId, keyId: key.keyId, timeSeconds };
  const signature = await signQrV1(key.privateKey, fields, subtle);
  const bytes = encodeQrV1({ ...fields, signature });
  return { ticketId, keyId: key.keyIdText, timeSeconds, bytes, text: base45Encode(bytes) };
}

/** 'HH:MM:SS'(기기·보정 시계). QR 아래 '지금' 글자에 쓴다 */
export function qrClockText(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
