// 보상 실행기의 로그(BAT-011, PRF-173). LoggerTicketIssueLog와 같은 꼴이다.
// 영구 실패는 SEV2 오류 한 줄(kind compensation, 주문 ID·단계·코드만), 발권을 막았는데 입장 기록이 있으면 SEV1 한 줄(kind compensation-entered),
// 늦거나 어긋난 답은 경고 한 줄, 저장소 장애는 오류 한 줄이다. 사유·결제 ID·계좌 같은 값은 글에 싣지 않는다
import type { PlatformLogger } from '@peaket/platform';
import type { CompensationLog } from '../domain/compensation.js';

export class LoggerCompensationLog implements CompensationLog {
  constructor(private readonly logger: PlatformLogger) {}

  failed(q: { readonly orderId: string; readonly stage: string; readonly code: string }): void {
    this.logger.error({ kind: 'compensation', severity: 'SEV2', orderId: q.orderId, stage: q.stage, code: q.code }, '보상이 영구 실패했다(사람이 확인한다)');
  }

  entered(q: { readonly orderId: string; readonly alreadyEntered: number }): void {
    this.logger.error({ kind: 'compensation-entered', severity: 'SEV1', orderId: q.orderId, alreadyEntered: q.alreadyEntered }, '보상으로 발권을 막았는데 이미 입장한 티켓이 있었다');
  }

  stale(q: { readonly orderId: string; readonly stage: string; readonly current?: string }): void {
    this.logger.warn({ kind: 'compensation-stale', orderId: q.orderId, stage: q.stage, ...(q.current === undefined ? {} : { current: q.current }) }, '보상이 늦거나 어긋난 답을 만났다');
  }

  runError(q: { readonly stage: string; readonly orderId?: string; readonly err: unknown }): void {
    const err = q.err instanceof Error ? q.err.name : 'unknown';
    this.logger.error({ kind: 'compensation', orderId: q.orderId, stage: q.stage, err }, '보상 실행기가 오류를 만났다');
  }
}
