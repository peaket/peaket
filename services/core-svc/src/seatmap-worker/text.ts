// 가져오기 파일의 글자 처리(docs/security/asvs/seat-hold.md 1.1.1, docs/features/seat-hold.md §10, ADR-0257 결정 7).
// - 바이트는 UTF-8로 한 번만 디코딩한다(맨 앞 BOM 하나는 버리고, 잘못된 바이트는 형식 불일치).
// - 글자 칸은 제어 문자와 양방향 제어 문자를 지운 뒤 NFC로 한 번 정규화하고(지우기 전에 정규화하면 사이에 낀 제어 문자 때문에
//   합쳐지지 않은 글자가 남는다), 그 글자 수로 상한을 본다(ADR-0257 결정 7).

/** 디코딩하지 못한 파일(형식 불일치로 거절한다) */
export class NotUtf8 extends Error {}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** UTF-8 한 번 디코딩. 맨 앞 BOM 하나만 버린다(둘째 BOM은 글자로 남는다) */
export function decodeUtf8(bytes: Uint8Array): string {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new NotUtf8('UTF-8이 아니다');
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// 제어 문자(C0·DEL·C1)와 양방향 제어 문자(ALM, LRM·RLM, LRE~RLO, LRI~PDI)
const CONTROLS = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** 파트너가 준 글자: 제어 문자 지우기 → NFC 한 번 → 앞뒤 공백 지우기 */
export function cleanLabel(raw: string): string {
  return raw.replace(CONTROLS, '').normalize('NFC').trim();
}

/** 글자 수(코드 포인트) */
export const charLength = (s: string): number => [...s].length;
