// 유스케이스: 회차 취소·연기 확정을 core 회차 상태에 반영한다(POST /internal/v1/events/{eventId}/cancellation-status,
// docs/features/transfer-refund.md §5 'core 회차 상태 반영', BUILD_ORDER GAT-110, R-T41, SR-T8 ③, ADR-0280 결정 6).
// 한 트랜잭션에서 회차 행을 잠가 상태를 정해 쓰고, 같은 트랜잭션에서 검색 동기화(withSearchSync, docs/features/search.md §2.3 '구현 자리')를 부른다.
// 회차가 모두 취소돼 공연이 검색에서 빠지면 커밋 뒤 `/v1/search*` 무효화 한 번과 `search_removed`(이유 EVENT_CANCELLED)가 남는다.
// 이미 같은 상태면 아무것도 쓰지 않고(동기화 대상도 비운다) UNCHANGED다. 트랜잭션이 되돌려지면 검색도 그대로다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, type DbTransaction, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { EVENT_STATUS_STORE, type EventCancellationKind, EventNotFound, type EventStatusStore, decideEventStatus } from '../domain/event-cancellation-status.js';
import { CDN_INVALIDATION, type CdnInvalidation } from '../domain/media-ports.js';
import { SEARCH_READ_MODEL_SYNC, type SearchReadModelSync } from '../domain/search.js';
import { withSearchSync } from './search-maintenance.js';

/** search_removed 줄의 이유(transfer-refund §5) */
export const EVENT_CANCELLED_SEARCH_REASON = 'EVENT_CANCELLED';

export interface ApplyEventCancellationStatusInput {
  readonly eventId: string;
  readonly requestId: string;
  readonly kind: EventCancellationKind;
  readonly postponedTo?: Date;
}

@Injectable()
export class ApplyEventCancellationStatus {
  constructor(
    @Inject(EVENT_STATUS_STORE) private readonly store: EventStatusStore<DbTransaction>,
    @Inject(SEARCH_READ_MODEL_SYNC) private readonly sync: SearchReadModelSync,
    @Inject(CDN_INVALIDATION) private readonly cdn: CdnInvalidation,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info' | 'warn'>,
  ) {}

  /**
   * @throws EventNotFound 없는 회차(404)
   * @throws EventStatusConflict CANCELLED 회차의 연기·지금보다 이른 연기 시작(409)
   */
  async execute(i: ApplyEventCancellationStatusInput): Promise<'APPLIED' | 'UNCHANGED'> {
    const now = new Date(this.clock.now());
    const logger = this.logger ?? silent;
    const outcome = await withSearchSync(
      { database: { transaction: (work) => this.store.transaction(work) }, sync: this.sync, cdn: this.cdn, logger, reason: EVENT_CANCELLED_SEARCH_REASON, at: now },
      async (tx) => {
        const current = await this.store.lock(tx, i.eventId);
        if (!current) throw new EventNotFound();
        const next = decideEventStatus(current, { kind: i.kind, ...(i.postponedTo !== undefined ? { postponedTo: i.postponedTo } : {}) }, now);
        if (!next) return { result: 'UNCHANGED' as const, productionIds: [] };
        await this.store.write(tx, i.eventId, next);
        return { result: 'APPLIED' as const, productionIds: [current.productionId] };
      },
    );
    safeInfo(logger, { event: 'event-cancellation-status-applied', eventId: i.eventId, requestId: i.requestId, kind: i.kind, changed: outcome === 'APPLIED' });
    return outcome;
  }
}

const silent: Pick<PlatformLogger, 'info' | 'warn'> = { info: () => undefined, warn: () => undefined };

function safeInfo(logger: Pick<PlatformLogger, 'info'>, o: Record<string, unknown>): void {
  try {
    logger.info(o, 'core 회차 상태 반영을 받았다');
  } catch {
    // 기록 실패는 처리를 바꾸지 않는다
  }
}
