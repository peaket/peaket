// base45 QR v1 글자를 실제 QR 모듈로 바꾼다(offline-gate §3, CMP-029).
// 오류 정정 수준은 M(15%)을 기본으로 둔다. wbs 5.1.3 PoC에서 인식 시간·실패율을 재어 바꾼다.
// base45는 QR 영숫자 모드가 쓰는 45글자만 쓰므로 qrcode가 영숫자 모드를 고른다(140자).
import QRCode from 'qrcode';
import type { QrMatrix } from '@peaket/ds/RotatingQR';

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export function qrMatrix(text: string, errorCorrectionLevel: QrErrorCorrection = 'M'): QrMatrix {
  const qr = QRCode.create(text, { errorCorrectionLevel });
  const data = qr.modules.data;
  return {
    size: qr.modules.size,
    cells: Array.from(data, (value) => value === 1),
  };
}
