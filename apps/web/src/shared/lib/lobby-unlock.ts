// 로비 참가 퍼뜨리기(docs/features/queue-admission.md §2, 소유자 결정 2026-10-30, open-items 66번, ADR-0161 결정 1. 식은 추천 적용 2026-10-30).
// 공연 상세의 [로비 입장]은 기기마다 로비 개방 뒤 0~60초 [가정] 사이의 한 시각에 연다:
//   로비 개방 + u32be(SHA-256("PEAKET-lobby-open-v1" ‖ 회차 ID ‖ deviceId)[0..4]) mod (lobbySpreadSec × 1000) 밀리초.
// 값은 기기·회차마다 고정이라 새로고침해도 빨라지지 않는다. 로비 화면(SCR-007, HOT-340)과 queue-svc가 같은 식·같은 설정값을 쓴다.

/** lobbySpreadSec [가정](queue-svc와 같은 설정값) */
export const LOBBY_SPREAD_SEC = 60;

let pageFallback: string | undefined;

/**
 * 로비 개방 뒤 이 기기의 [로비 입장]이 열리기까지의 밀리초. 기기 ID가 없으면(저장소를 못 씀) 이 페이지에서만 쓰는 무작위 값으로 정한다.
 * 보안 맥락이 아니라 `crypto.subtle`이 없거나(https·localhost가 아닌 http 주소, 2026-11-05 컨테이너 검사에서 찾음) 계산이 실패하면
 * 퍼뜨림 끝(가장 늦은 시각)에 연다. 서버보다 일찍 열지 않고, 버튼이 뼈대로 남지도 않는다
 */
export async function lobbyUnlockDelayMs(
  eventId: string,
  deviceId: string | undefined,
  spreadSec: number = LOBBY_SPREAD_SEC,
  subtle: Pick<SubtleCrypto, 'digest'> | null | undefined = globalThis.crypto?.subtle,
): Promise<number> {
  const last = spreadSec * 1000 - 1;
  if (!subtle) return last;
  try {
    const device = deviceId ?? (pageFallback ??= crypto.randomUUID());
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(`PEAKET-lobby-open-v1${eventId}${device}`));
    return new DataView(digest).getUint32(0, false) % (spreadSec * 1000);
  } catch {
    return last;
  }
}
