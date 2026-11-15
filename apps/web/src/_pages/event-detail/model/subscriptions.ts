// SCR-002 회차 알림 신청 상태(listSubscriptions의 items, ADR-0272 결정 2). 순수 함수다.
// 시험 담당이 만든 빈 뼈대이고, 동작은 구현 담당이 채운다(ADR-0270 결정 1).

export function subscriptionFlags(items: unknown, eventId: string): { open: boolean; cancel: boolean } {
  void items;
  void eventId;
  throw new Error('아직 없음');
}
