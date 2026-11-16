// SCR-002 회차 알림 신청 상태(listSubscriptions의 items, openapi SubscriptionState, ADR-0272 결정 2). 순수 함수다.
// 오픈 알림은 그 회차의 open이 true, 취소표 알림은 cancellationStatus가 ACTIVE일 때만 켜짐이다(끝난 신청은 cancellation이 true여도 꺼짐).

export function subscriptionFlags(items: unknown, eventId: string): { open: boolean; cancel: boolean } {
  const off = { open: false, cancel: false };
  if (!Array.isArray(items)) return off;
  const mine = items.find((s): s is Record<string, unknown> => typeof s === 'object' && s !== null && (s as { eventId?: unknown }).eventId === eventId);
  if (!mine) return off;
  return { open: mine.open === true, cancel: mine.cancellationStatus === 'ACTIVE' };
}
