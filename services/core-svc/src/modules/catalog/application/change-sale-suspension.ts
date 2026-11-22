// 유스케이스: 판매 승인된 공연을 내리고(판매 중지) 다시 올린다(판매 재개). ADR-0123, LCH-090, BAT-620.
// 한 트랜잭션에서 공연 행을 잠그고 sale_review를 바꾼 뒤, 같은 트랜잭션에서 검색 읽기 모델을 고친다(withSearchSync, SR-T8 ③).
// 커밋 뒤 CDN 검색 경로·공연/회차 태그를 비운다. 중지는 판매를 먼저 막은 뒤 이 경로를 부르고, 재개는 이 경로 뒤에 판매를 연다(ops-svc 집행).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, type DbTransaction, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { CDN_INVALIDATION, type CdnInvalidation } from '../domain/media-ports.js';
import { SEARCH_READ_MODEL_SYNC, type SearchReadModelSync } from '../domain/search.js';
import {
  decideSaleSuspension,
  SALE_SUSPENSION_STORE,
  SaleSuspensionConflict,
  SaleSuspensionNotFound,
  type SaleSuspensionInput,
  type SaleSuspensionStore,
} from '../domain/sale-suspension.js';
import { SEARCH_CDN_PATHS, withSearchSync } from './search-maintenance.js';

/** search_removed 줄의 이유(판매 중지, docs/features/search.md §10) */
export const SALE_SUSPENDED_SEARCH_REASON = 'SALE_SUSPENDED';

export interface ChangeSaleSuspensionInput extends SaleSuspensionInput {
  readonly eventId: string;
}

export interface ChangeSaleSuspensionResult {
  readonly status: 'APPLIED' | 'UNCHANGED';
  readonly productionId: string;
  readonly eventIds: readonly string[];
  /** 재개 때 다시 연 회차. 중지면 빈 목록 */
  readonly resumeEventIds: readonly string[];
}

@Injectable()
export class ChangeSaleSuspension {
  constructor(
    @Inject(SALE_SUSPENSION_STORE) private readonly store: SaleSuspensionStore<DbTransaction>,
    @Inject(SEARCH_READ_MODEL_SYNC) private readonly sync: SearchReadModelSync,
    @Inject(CDN_INVALIDATION) private readonly cdn: CdnInvalidation,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info' | 'warn'>,
  ) {}

  /** 집행 전에 회차 목록만 읽는다(중지는 이 목록의 판매를 먼저 막는다) */
  async scope(eventId: string): Promise<{ productionId: string; saleReview: string; eventIds: readonly string[] }> {
    const found = await this.store.scope(eventId);
    if (!found) throw new SaleSuspensionNotFound();
    return found;
  }

  /** 회차 묶음 중 판매 중지된 것. payment-svc 지급 묶음 보류가 쓴다(BAT-625). */
  async listSuspended(eventIds: readonly string[]): Promise<readonly string[]> {
    return this.store.listSuspended(eventIds);
  }

  /**
   * @throws SaleSuspensionNotFound 없는 회차(404)
   * @throws SaleSuspensionConflict 상태와 맞지 않음(409)
   */
  async run(input: ChangeSaleSuspensionInput): Promise<ChangeSaleSuspensionResult> {    const now = new Date(this.clock.now());
    const logger = this.logger ?? silent;
    const reason = input.kind === 'SUSPENDED' ? SALE_SUSPENDED_SEARCH_REASON : 'SALE_RESUMED';
    const out = await withSearchSync(
      { database: { transaction: (work) => this.store.transaction(work) }, sync: this.sync, cdn: this.cdn, logger, reason, at: now },
      async (tx) => {
        const current = await this.store.lockByEvent(tx, input.eventId);
        if (!current) throw new SaleSuspensionNotFound();
        const decision = decideSaleSuspension(current, input, now);
        if (decision.write) await this.store.write(tx, current.productionId, decision.write);
        return {
          result: {
            status: decision.write ? ('APPLIED' as const) : ('UNCHANGED' as const),
            productionId: current.productionId,
            eventIds: decision.eventIds,
            resumeEventIds: decision.resumeEventIds,
          },
          // 바뀐 것이 없으면 검색 동기화 대상도 비운다(멱등 재시도가 판을 올리지 않는다)
          productionIds: decision.write ? [current.productionId] : [],
        };
      },
    );

    if (out.status === 'APPLIED') {
      // 재개는 검색 문서를 다시 넣는다. withSearchSync는 '빠진 공연'이 있을 때만 경로를 비우므로, 캐시에 남은 '없음'을 여기서 지운다.
      if (input.kind === 'RESUMED') {
        try {
          await this.cdn.invalidatePaths([...SEARCH_CDN_PATHS]);
        } catch (e) {
          warn(logger, { event: 'cdn_invalidation_failed', paths: [...SEARCH_CDN_PATHS], err: e instanceof Error ? e.name : 'unknown' }, '판매 재개 뒤 검색 경로 CDN 무효화에 실패했다(캐시 수명이 지나면 풀린다)');
        }
      }
      // 공개 요약(SCR-002·SCR-048) 캐시 태그를 비운다(ADR-0200 결정 5와 같은 꼴)
      const tags = [...out.eventIds.map((id) => `event:${id}`), `production:${out.productionId}`];
      if (tags.length > 0) {
        try {
          await this.cdn.invalidate(tags);
        } catch (e) {
          warn(logger, { event: 'cdn_invalidate_failed', tags, err: e instanceof Error ? e.name : 'unknown' }, '판매 중지·재개 뒤 공연 태그 CDN 무효화에 실패했다(캐시 수명이 지나면 풀린다)');
        }
      }
    }

    safeInfo(logger, {
      event: input.kind === 'SUSPENDED' ? 'sale_review_suspended' : 'sale_review_resumed',
      productionId: out.productionId,
      approvalId: input.approvalId,
      ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
      status: out.status,
      events: out.eventIds.length,
      ...(input.kind === 'RESUMED' ? { reopened: out.resumeEventIds.length } : {}),
    });
    return out;
  }
}

const silent: Pick<PlatformLogger, 'info' | 'warn'> = { info: () => undefined, warn: () => undefined };

function safeInfo(logger: Pick<PlatformLogger, 'info'>, o: Record<string, unknown>): void {
  try {
    logger.info(o, '판매 중지·재개를 반영했다');
  } catch {
    // 기록 실패는 처리를 바꾸지 않는다
  }
}

function warn(logger: Pick<PlatformLogger, 'warn'>, o: Record<string, unknown>, msg: string): void {
  try {
    logger.warn(o, msg);
  } catch {
    // 기록 실패는 처리를 바꾸지 않는다
  }
}
