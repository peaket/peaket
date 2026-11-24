// 회차를 아는 화면이 서버 경로에 싣는 머리(IR-17·IR-24). `/v1/orders`·양도·반환처럼 주소에 회차가 없는 경로도
// 게이트웨이 접근 로그와 조사 사본의 `eventId`를 채운다. 빈 값이면 싣지 않는다.
export function eventIdHeaders(eventId: string | null | undefined): Record<string, string> {
  return typeof eventId === 'string' && eventId !== '' ? { 'x-peaket-event-id': eventId } : {};
}
