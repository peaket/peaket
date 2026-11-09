// 새 결제 진입 정지의 로그(BUILD_ORDER PRF-202). 결제사·단계·행위자·안전한 오류 코드만 싣는다. 해제 사유 글과 확인 호출의 응답 본문은 싣지 않는다(ASVS v5.0.0-16.2.5).
import type { PlatformLogger } from '@peaket/platform';
import type { EntryPauseJudgeLog } from '../domain/ports.js';
import { safeErrorCode } from '../../../safe-error-code.js';

export function entryPauseLog(logger: Pick<PlatformLogger, 'info' | 'warn' | 'error'>): EntryPauseJudgeLog {
  return {
    transition: ({ pg, from, to, reason, actor }) => logger.info({ kind: 'payment-entry-pause-transition', pg, from, to, reason, actor }, '새 결제 진입 정지 단계가 바뀌었다'),
    probeFound: ({ pg }) => logger.error({ kind: 'payment-entry-pause-probe-found', pg }, '확인 호출의 고정 번호에 결제가 있다고 답했다'),
    judgeError: ({ what, pg, err }) => logger.warn({ kind: 'payment-entry-pause-judge-error', what, pg, code: safeErrorCode(err) }, '정지 판정 틱이 실패했다'),
    released: ({ pg, actor }) => logger.info({ kind: 'payment-entry-pause-released', pg, actor }, 'commander가 새 결제 진입 정지를 풀었다'),
  };
}
