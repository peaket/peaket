// 유스케이스 층: 이 모듈이 내는 이름 붙은 오류(openapi x-peaket-problem-types와 같은 status·title).
import { ProblemError } from '@peaket/platform';

export const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
export const eventSuspended = () => new ProblemError({ type: 'event-suspended', status: 410, title: '판매가 중지된 공연입니다' });
export const eventScheduleInvalid = (eventIndex: number) =>
  new ProblemError({ type: 'event-schedule-invalid', status: 422, title: '회차 일정이 맞지 않습니다', extensions: { eventIndex } });
export const queueOrderInvalid = (eventIndex: number) =>
  new ProblemError({ type: 'queue-order-invalid', status: 422, title: '로비 셔플과 오픈 직후 묶음을 둘 다 끌 수는 없습니다', extensions: { eventIndex } });
export const openMaintenanceWindow = (eventIndex: number, suggestedOpenAt?: Date) =>
  new ProblemError({ type: 'open-maintenance-window', status: 409, title: '정비 시간에는 오픈할 수 없습니다', extensions: suggestion(eventIndex, suggestedOpenAt) });
export const openTooClose = (eventIndex: number, suggestedOpenAt?: Date) =>
  new ProblemError({ type: 'open-too-close', status: 409, title: '다른 공연과 오픈 시각이 5분 안입니다', extensions: suggestion(eventIndex, suggestedOpenAt) });
export const partnerAdminRequired = () => new ProblemError({ type: 'partner-admin-required', status: 403, title: '파트너 관리자만 할 수 있습니다' });
export const productionSuspended = () => new ProblemError({ type: 'production-suspended', status: 409, title: '판매 중지 중에는 바꿀 수 없습니다' });
export const wishLimit = () => new ProblemError({ type: 'wish-limit', status: 422, title: '찜 수를 넘었습니다' });

function suggestion(eventIndex: number, at?: Date): Record<string, unknown> {
  return at ? { eventIndex, suggestedOpenAt: at.toISOString() } : { eventIndex };
}
