// 유스케이스: 회차 더하기(openapi POST /v1/partner/productions/{productionId}/events, ADR-0198 결정 3, BUILD_ORDER HOT-171).
// 판정 순서: 그 테넌트의 공연인가(아니면 없는 공연과 같은 404) → 판매 중지(409) → 승인 이력이 있으면 파트너 관리자만(403) →
// 일정·정렬(422) → 정비 창·오픈 간격(409). 승인 이력이 없으면 event 행으로 바로 넣고(배치본은 그 공연의 다른 회차와 같은 값),
// 있으면 변경분(pending_revision.addedEvents)에만 두고 APPROVED는 SUBMITTED로 바꾼다(planning/03 §2.14 T7). 공개본은 늘 마지막 승인 내용이다.
// 배치본이 있으면 새 회차의 팬 좌석맵 파일(공개 위치에 게시한 행 판, 준비 위치에 쓴 대기 판)을 다른 회차와 같은 바이트로 쓴다(ADR-0260 결정 8, BUILD_ORDER HOT-240).
// 파일은 트랜잭션을 연 채 쓰지 않는다(core 역할 idle_in_transaction 10초, 추천 적용 2026-11-10 리뷰 C2·D7): 회차 ID를 먼저 만들어 잠금 밖에서 쓰고,
// 트랜잭션 안에서 게시한 판이 그대로인지 다시 본 뒤 넣는다. 판이 바뀌었으면 되돌리고 다시 하며(최대 2번 [가정]), 그래도 바뀌면 503 Retry-After 1이다.
// 쓰지 못하면 회차를 더하지 않고 503 seatmap-publish-unavailable이다. 회차를 더하지 않게 되면 쓴 파일을 지운다(못 지우면 기록).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger, uuidv7 } from '@peaket/platform';
import { CATALOG_REPOSITORY, type CatalogRepository, type LayoutFile, type RequestOnce } from '../domain/ports.js';
import type { EventDraft } from '../domain/registration.js';
import { COMMIT_RETRIES, fanFile, fanFileBytes, fanFileKey, PUBLISH_RETRY_AFTER_S, ROUNDS_CHANGED_RETRY_AFTER_S } from '../domain/seatmap-layout.js';
import type { OpenWarning } from './create-production.js';
import { FanFilePublisher, PublishFailed } from './fan-file-publisher.js';
import { notFound, partnerAdminRequired, productionSuspended, seatmapPublishUnavailable } from './problems.js';
import { assertDraft, assertOpenSlot } from './schedule-checks.js';

export interface EventAdded {
  eventId: string;
  pending: boolean;
  warnings: OpenWarning[];
}

/** 미리 쓴 파일의 판(판·위치)이 트랜잭션 안에서 본 것과 다르다 */
class LayoutChanged extends Error {}

const signature = (files: readonly LayoutFile[]) => files.map((f) => `${f.where}:${f.version}`).join(',');

@Injectable()
export class AddProductionEvent {
  constructor(
    @Inject(CATALOG_REPOSITORY) private readonly repo: CatalogRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly publisher: FanFilePublisher,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'warn'>,
  ) {}

  async run(c: { tenantId: string; role: string; productionId: string; input: EventDraft; once: RequestOnce }): Promise<EventAdded> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#attempt(c);
      } catch (e) {
        if (!(e instanceof LayoutChanged)) throw e;
        if (attempt >= COMMIT_RETRIES) throw seatmapPublishUnavailable(ROUNDS_CHANGED_RETRY_AFTER_S);
      }
    }
  }

  async #attempt(c: { tenantId: string; role: string; productionId: string; input: EventDraft; once: RequestOnce }): Promise<EventAdded> {
    const eventId = uuidv7(this.clock);
    // 잠금 밖에서 먼저 읽는다. 받지 못할 요청(남의 공연·판매 중지·승인 뒤 실무자)이면 파일을 쓰지 않는다(트랜잭션이 거절한다)
    const pre = await this.repo.layoutFilesFor(c.productionId, c.tenantId);
    const writable = pre !== undefined && !pre.suspended && !(pre.approvedBefore && c.role !== 'partner_admin');
    const files = writable ? pre.files : [];
    const written = await this.#publish(c.productionId, eventId, files);
    let out: EventAdded;
    try {
      out = await this.repo.registerOnce(c.once, c.tenantId, async (tx) => {
        const p = await tx.productionForUpdate(c.productionId, c.tenantId);
        if (!p) throw notFound();
        if (p.saleReview === 'SUSPENDED') throw productionSuspended();
        const approvedBefore = p.saleApprovedAt !== null;
        if (approvedBefore && c.role !== 'partner_admin') throw partnerAdminRequired();
        const now = new Date(this.clock.now());
        assertDraft(c.input, 0, now);
        await assertOpenSlot(tx, c.input, 0, p.id);
        // 미리 쓴 파일의 판이 지금 게시한 판과 같아야 한다(그 사이 좌석맵 저장이 커밋되면 다시 한다)
        const current = p.venueId ? await tx.layoutFiles(p.venueId, c.tenantId) : [];
        if (signature(current) !== signature(files) || (pre?.venueId ?? null) !== p.venueId) throw new LayoutChanged();
        if (!approvedBefore) {
          await tx.insertEvent(p.id, p.promoterId, p.venueId, { ...c.input, id: eventId });
          return { eventId, pending: false, warnings: [] };
        }
        await tx.savePending(p.id, [...p.pendingEvents, { ...c.input, eventId, addedAt: now, venueId: p.venueId }], p.saleReview === 'APPROVED' ? 'SUBMITTED' : p.saleReview);
        return { eventId, pending: true, warnings: [] };
      });
    } catch (e) {
      await this.#discard(c.productionId, eventId, written);
      throw e;
    }
    // 같은 키로 다시 온 요청이면 처음 결과(다른 회차 ID)를 돌려준다. 이번에 쓴 파일은 쓰이지 않으니 지운다
    if (out.eventId !== eventId) await this.#discard(c.productionId, eventId, written);
    return out;
  }

  /** 새 회차의 팬 파일을 판마다 쓴다(트랜잭션 밖). 하나라도 쓰지 못하면 쓴 것을 지우고 503 */
  async #publish(productionId: string, eventId: string, files: readonly LayoutFile[]): Promise<string[]> {
    const written: string[] = [];
    for (const { version, where, doc } of files) {
      const file = fanFile(doc, version);
      if (!file) continue;
      const key = fanFileKey(eventId, version, where);
      try {
        await this.publisher.publish([key], fanFileBytes(file));
      } catch (e) {
        if (!(e instanceof PublishFailed)) throw e;
        await this.#discard(productionId, eventId, written);
        this.#warn({ event: 'seatmap_publish_failed', productionId, eventId, version, where, failed: e.failed, reason: e.reason, rounds: 1 }, '더한 회차의 팬 좌석맵 파일을 쓰지 못해 회차를 더하지 않았다');
        throw seatmapPublishUnavailable(PUBLISH_RETRY_AFTER_S);
      }
      written.push(key);
    }
    return written;
  }

  async #discard(productionId: string, eventId: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const left = await this.publisher.remove(keys);
    if (left > 0) this.#warn({ event: 'seatmap_file_leftover', productionId, eventId, count: left }, '더하지 않은 회차의 팬 좌석맵 파일이 남았다');
  }

  #warn(line: Record<string, unknown>, msg: string): void {
    try {
      this.logger?.warn(line, msg);
    } catch {
      // 기록 실패는 응답을 바꾸지 않는다
    }
  }
}
