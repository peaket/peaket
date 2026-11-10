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

// 공연 이미지·좌석맵 가져오기(ADR-0257). 제목은 계약 목록과 같다
export const imageTooLarge = () => new ProblemError({ type: 'image-too-large', status: 413, title: '한 장에 10MB까지 올릴 수 있습니다' });
export const imageTypeUnsupported = () => new ProblemError({ type: 'image-type-unsupported', status: 415, title: 'JPEG, PNG, WebP 이미지만 올릴 수 있습니다' });
export const imageLimitExceeded = () => new ProblemError({ type: 'image-limit-exceeded', status: 409, title: '포스터 1장과 상세 이미지 10장까지 올릴 수 있습니다' });
export const imageSpecInvalid = (reason: 'PIXEL_LIMIT' | 'POSTER_SPEC' | 'DETAIL_SPEC' | 'MALWARE' | 'ALT_INVALID') =>
  new ProblemError({ type: 'image-spec-invalid', status: 422, title: '이미지 기준에 맞지 않습니다', extensions: { reason } });
export const imageProcessingUnavailable = (retryAfterSeconds: number) => new ProblemError({ type: 'image-processing-unavailable', status: 503, title: '이미지를 잠시 확인할 수 없습니다', retryAfterSeconds });
export const posterNotDeletable = () => new ProblemError({ type: 'poster-not-deletable', status: 409, title: '포스터는 지우지 않고 바꿉니다' });
export const preconditionFailed = () => new ProblemError({ type: 'precondition-failed', status: 412, title: '다른 사람이 먼저 고쳤습니다' });
export const preconditionRequired = () => new ProblemError({ type: 'precondition-required', status: 428, title: '고칠 판(If-Match)을 보내 주세요' });
export const seatmapImportTooLarge = () => new ProblemError({ type: 'seatmap-import-too-large', status: 413, title: '좌석맵 파일은 10MB까지 올릴 수 있습니다' });
export const seatmapImportRejected = (code: string) => new ProblemError({ type: 'seatmap-import-rejected', status: 422, title: '좌석맵 파일을 읽지 않았습니다', detail: code });
export const seatmapWorkerUnavailable = () => new ProblemError({ type: 'seatmap-worker-unavailable', status: 503, title: '좌석맵 파일을 잠시 확인할 수 없습니다', retryAfterSeconds: 10 });

// 공연용 배치본 저장(ADR-0260). 제목은 계약 목록과 같다
export const seatmapInvalid = (errors: { line: number; field: string; code: string }[]) =>
  new ProblemError({ type: 'seatmap-invalid', status: 422, title: '좌석맵에 고칠 곳이 있습니다', extensions: { result: { ok: false, errors, warnings: [] } } });
export const seatmapGeometryLocked = () => new ProblemError({ type: 'seatmap-geometry-locked', status: 409, title: '판매가 시작되어 좌석 배치는 바꿀 수 없습니다' });
export const saleSettingLocked = () => new ProblemError({ type: 'sale-setting-locked', status: 409, title: '지금은 바꿀 수 없는 항목입니다' });
export const seatmapPublishUnavailable = (retryAfterSeconds: number) => new ProblemError({ type: 'seatmap-publish-unavailable', status: 503, title: '좌석맵 파일을 잠시 게시할 수 없습니다', retryAfterSeconds });
