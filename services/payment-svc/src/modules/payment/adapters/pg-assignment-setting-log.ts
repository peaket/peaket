// 설정 사건 PG_ASSIGNMENT(명령 12) 처리의 로그(ADR-0349 결정 5, BUILD_ORDER BAT-360). 회차·명령 ID·걸린 칸·하위 결제사 이름과 까닭·안전한 오류 코드만 싣는다.
// 값 원문과 오류 글(SQL 문장 값이 실릴 수 있다)은 싣지 않는다(ASVS v5.0.0-16.2.5).
import type { PlatformLogger } from '@peaket/platform';
import { isLowerUuid } from '../domain/confirm-command.js';
import type { PgAssignmentSettingLog } from '../domain/ports.js';
import { safeErrorCode } from '../../../safe-error-code.js';

/** 모양이 틀린 회차 값은 로그에 싣지 않는다 */
const safeEventId = (v: string): string => (isLowerUuid(v) ? v : '-');

export function pgAssignmentSettingLog(logger: Pick<PlatformLogger, 'info' | 'warn' | 'error'>): PgAssignmentSettingLog {
  return {
    applied: ({ eventId, commandId, written }) => logger.info({ kind: 'payment-pg-assignment-applied', eventId: safeEventId(eventId), commandId, written }, written ? '설정 사건으로 회차 결제사 지정을 썼다' : '회차 결제사 지정이 같거나 더 늦어 건너뛰었다'),
    rejected: ({ eventId, commandId, field, provider, reason }) =>
      logger.error(
        { kind: 'payment-pg-assignment-rejected', eventId: safeEventId(eventId), commandId, ...(field === undefined ? {} : { field }), ...(provider === undefined ? {} : { provider, reason }) },
        provider === undefined ? '설정 사건의 회차 결제사 지정 값이 틀려 쓰지 않았다' : '하위 결제사 규칙에 걸려 회차 결제사 지정을 쓰지 않았다(pg-fallback-same-provider)',
      ),
    storeFailed: ({ eventId, commandId, attempt, retryInMs, err }) =>
      logger.warn({ kind: 'payment-pg-assignment-store-failed', eventId: safeEventId(eventId), commandId, attempt, retryInMs, code: safeErrorCode(err) }, '회차 결제사 지정을 쓰지 못해 다시 한다'),
  };
}
