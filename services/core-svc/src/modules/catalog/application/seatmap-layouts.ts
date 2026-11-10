// 유스케이스: 좌석맵 불러오기·저장(openapi getPartnerProductionSeatmap·putPartnerProductionSeatmap, ADR-0260 결정 3~13·15, docs/data.md §5, BUILD_ORDER HOT-240).
// 저장 차례(먼저 걸린 것으로 답한다): 소속(404, 보안 사건. 승인 이력 공연의 실무자면 실패한 인가 시도를 여기서 남긴다) → 본문 검사(잠금 밖: 개수 상한·가져오기와 같은 검사·
// 구역 ID 꼴·색인·등급, 422) → 트랜잭션 ①(공연 행 잠금: 판매 중지 409·승인 이력이면 관리자만 403 → 좌석 ID 매기기 → If-Match 428/412(잠긴 배치의 도형 변경이면 보안 사건)
// → 틀 422·보내지 않은 가격 등급으로 등급 422 → 오픈 뒤 잠금 409 → 새 판 V를 잡아 커밋) → 남은 시간(504) → 잠금 밖에서 회차마다 V 판 팬 파일 쓰기
// (승인 이력이 있으면 준비 위치, 실패하면 쓴 것을 지우고 503) → 트랜잭션 ②(다시 잠가 같은 판정, ① 뒤 더한 회차가 있으면 되돌리고 그 회차 파일을 잠금 밖에서 쓴 뒤 다시,
// 행 또는 대기 판 쓰기, 첫 배치본이면 회차 잇기, 커밋 바로 앞에 잠금 다시 보기) → 커밋 뒤 앞 판 파일 지우기(승인된 판은 남긴다, 실패는 기록만).
// ②가 거절하거나 커밋 전에 실패하면 V 파일을 지운다. 커밋 결과를 모르면 지우지 않고 기록한다. V는 다시 쓰지 않는다(버린 번호). 파일은 트랜잭션을 연 채 쓰지 않는다.
// 기록에는 판·좌석·구역 수·결과 코드·게시 여부·회차 수만 싣고 구역 이름 같은 파트너 글자는 넣지 않는다(결정 13).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, deadlineExceeded, PLATFORM_LOGGER, type PlatformLogger, requestContext, uuidv7 } from '@peaket/platform';
import { countRaw, recheckLayout, type SeatmapIssue } from '../domain/seatmap-import.js';
import {
  assignIndexes,
  assignSeatIds,
  COMMIT_RETRIES,
  fanFile,
  fanFileBytes,
  fanFileKey,
  geometryChanges,
  geometryLocked,
  type LayoutDoc,
  type LayoutInput,
  layoutView,
  priceTierIssues,
  publishBudget,
  PUBLISH_RETRY_AFTER_S,
  ROUNDS_CHANGED_RETRY_AFTER_S,
  sameTiers,
  type SeatMapLayoutView,
  sectionIdIssues,
  shapeOf,
  tierIssues,
  versionOfEtag,
} from '../domain/seatmap-layout.js';
import { type LayoutState, type LayoutTx, SEATMAP_LAYOUT_STORE, type SeatmapLayoutStore } from '../domain/seatmap-ports.js';
import { FanFilePublisher, PublishFailed } from './fan-file-publisher.js';
import type { Caller } from './import-seatmap.js';
import {
  notFound,
  partnerAdminRequired,
  preconditionFailed,
  preconditionRequired,
  productionSuspended,
  saleSettingLocked,
  seatmapGeometryLocked,
  seatmapInvalid,
  seatmapPublishUnavailable,
} from './problems.js';

/** 지금 판: 대기 판이 있으면 그 판, 없으면 행의 판, 배치본이 없으면 0 */
const currentVersion = (st: LayoutState) => st.venue?.pending?.version ?? st.venue?.layoutVersion ?? 0;
const EMPTY: LayoutDoc = { canvas: { width: 0, height: 0 }, stage: [], sections: [], priceTiers: [] };

interface Reserved {
  version: number;
  doc: LayoutDoc;
  /** 게시한 회차(트랜잭션 ①이 본 것) */
  rounds: string[];
  /** ①에서 본 승인 이력(파일 위치를 정한다) */
  approvedBefore: boolean;
}

type SaveQuery = { productionId: string; who: Caller; role: string; ifMatch: string | undefined; body: LayoutInput };

/** 트랜잭션 ②의 결과: 쓰기를 마쳤거나, ① 뒤 더한 회차가 있어 아무것도 쓰지 않고 되돌렸다 */
type Second = { kind: 'done'; previous: number; keep: number | undefined; rounds: string[]; approvedBefore: boolean; locked: boolean } | { kind: 'added'; added: string[] };

@Injectable()
export class SeatmapLayouts {
  constructor(
    @Inject(SEATMAP_LAYOUT_STORE) private readonly store: SeatmapLayoutStore,
    private readonly publisher: FanFilePublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info' | 'warn'>,
  ) {}

  /**
   * 불러오기(ADR-0260 결정 10): 지금 판(대기 판 우선). 배치본이 없으면 공개된 틀의 판 0 초안, 그것도 아니면 404.
   * geometryLocked는 저장 경로와 같은 판정 함수(오픈 시각 ≤ 지금)다(ADR-0264 결정 13). 화면 표시용이고 서버의 409가 최종이다
   */
  async load(q: { productionId: string; who: Caller; fromTemplate?: string }): Promise<SeatMapLayoutView> {
    const cur = await this.store.current(q.productionId, q.who.tenantId);
    if (cur === 'not-found') {
      this.#denied(q.productionId, q.who, 'load');
      throw notFound();
    }
    const locked = async () => {
      const f = await this.store.lockFacts(q.productionId, q.who.tenantId);
      return f !== undefined && geometryLocked({ saleApprovedAt: f.saleApprovedAt, rounds: f.rounds, now: new Date(this.clock.now()) });
    };
    if (cur) return layoutView(cur.doc, cur.version, { geometryLocked: await locked() });
    if (q.fromTemplate !== undefined) {
      const draft = await this.store.templateDraft(q.fromTemplate, q.who.tenantId);
      if (draft) return layoutView(draft, 0, { geometryLocked: await locked() });
    }
    throw notFound();
  }

  async save(q: SaveQuery): Promise<SeatMapLayoutView> {
    const at = { productionId: q.productionId, accountId: q.who.accountId };
    const owner = await this.store.ownerView(q.productionId, q.who.tenantId);
    if (!owner) {
      this.#denied(q.productionId, q.who, 'save');
      throw notFound();
    }
    // 승인 이력 공연의 실무자는 본문이 틀려 422로 끝나도 실패한 인가 시도로 남긴다(리뷰 S4, catalog-review 16.3.2). 잠금 안에서 다시 보고 403이다
    const memberDenied = owner.approvedBefore && q.role !== 'partner_admin';
    if (memberDenied) this.#denied(q.productionId, q.who, 'save', 'partner_admin_required');
    // 본문 검사는 잠금 밖에서 먼저 한다(결정 5). 개수 상한이 먼저다(가져오기와 같은 차례, ADR-0257 결정 8)
    const over = countRaw(q.body);
    if (over) throw this.#invalid(at, [{ line: 0, field: 'layout', code: over }]);
    const indexed = assignIndexes(q.body);
    const sentTiers = q.body.priceTiers;
    const issues = [...recheckLayout(q.body), ...sectionIdIssues(indexed.sections), ...indexed.issues, ...(sentTiers ? [...priceTierIssues(sentTiers), ...tierIssues(indexed.sections, sentTiers)] : [])];
    if (issues.length > 0) throw this.#invalid(at, issues);
    const draft: LayoutDoc = { canvas: { width: q.body.canvas.width, height: q.body.canvas.height }, stage: (q.body.stage ?? []).map(shapeOf), sections: indexed.sections, priceTiers: sentTiers ?? [] };
    const ifMatch = q.ifMatch === undefined ? undefined : versionOfEtag(q.ifMatch);

    // 트랜잭션 ①: 판정 → 좌석 ID → If-Match → 틀·등급 → 잠금 → 새 판을 잡아 커밋
    const reserved = await this.store.withLockedProduction(q.productionId, q.who.tenantId, async (tx): Promise<Reserved> => {
      const st = await tx.state();
      this.#gate(st, q, at, memberDenied);
      const known = await tx.rowSeatIds();
      for (const s of st.venue?.pending?.doc.sections ?? []) for (const seat of s.seats) known.add(seat.seatId);
      const withIds: LayoutDoc = { ...draft, sections: assignSeatIds(draft.sections, known, () => uuidv7(this.clock)) };
      const lock = await this.#lockProbe(tx, st, withIds);
      if (!this.#ifMatchOk(st, q, ifMatch, at)) {
        // 잠긴 배치의 도형을 옛 판으로 바꾸려 한 것도 잠긴 배치본 바꾸기 시도다(리뷰 S4, catalog-review 16.3.3)
        if (lock && lock.changes.length > 0) this.#lockedAttempt(at, st, lock.changes);
        throw this.#rejected(at, 412, 'precondition-failed', preconditionFailed());
      }
      const doc = await this.#complete(tx, st, q.body, withIds, at);
      if (lock) this.#enforceLock(at, st, lock, doc);
      const version = await tx.reserveVersion();
      return { version, doc, rounds: st.rounds.map((r) => r.eventId), approvedBefore: st.production.saleApprovedAt !== null };
    });
    if (reserved === 'not-found') {
      this.#denied(q.productionId, q.who, 'save');
      throw notFound();
    }
    const { version, doc } = reserved;
    // 승인 이력이 있으면 재승인 대기 판이라 준비 위치에 쓴다(공개 위치는 승인된 판만, 판매 승인 LCH-080이 옮긴다, 리뷰 H3·D3)
    const where = reserved.approvedBefore ? 'staging' : 'public';
    const file = fanFile(doc, version);
    const bytes = file ? fanFileBytes(file) : undefined;
    const keysOf = (rounds: readonly string[]) => rounds.map((e) => fanFileKey(e, version, where));
    const written: string[] = [];
    const leftover = (count: number) => this.#warn({ event: 'seatmap_file_leftover', ...at, version, count }, '지우지 못한 팬 좌석맵 파일이 남았다');
    const discard = async () => {
      const left = await this.publisher.remove(written);
      if (left > 0) leftover(left);
    };
    /** 잠금 밖에서 쓴다. 남은 시간이 모자라면 504, 쓰지 못하면 503(쓴 이 판 파일을 모두 지운다) */
    const publish = async (rounds: readonly string[]) => {
      if (!bytes || rounds.length === 0) return;
      const budget = publishBudget(requestContext()?.deadline.remainingMs() ?? Number.POSITIVE_INFINITY);
      if (budget === undefined) {
        await discard();
        throw this.#rejected(at, 504, 'deadline-exceeded', deadlineExceeded());
      }
      const keys = keysOf(rounds);
      written.push(...keys);
      try {
        await this.publisher.publish(keys, bytes, { onLeftover: leftover, budgetMs: budget });
      } catch (e) {
        await discard();
        throw this.#publishFailed(e, at, version, written.length);
      }
    };
    await publish(reserved.rounds);

    // 트랜잭션 ②: ① 뒤 더한 회차가 있으면 되돌리고 그 회차 파일을 잠금 밖에서 쓴 뒤 다시 한다(최대 2번 [가정])
    const covered = new Set(reserved.rounds);
    let second: Second | undefined;
    for (let attempt = 0; ; attempt++) {
      let reachedCommit = false;
      let r: Second | 'not-found';
      try {
        r = await this.store.withLockedProduction(q.productionId, q.who.tenantId, async (tx): Promise<Second> => {
          const st = await tx.state();
          this.#gate(st, q, at, memberDenied);
          if (!this.#ifMatchOk(st, q, ifMatch, at)) throw this.#rejected(at, 412, 'precondition-failed', preconditionFailed());
          const approvedBefore = st.production.saleApprovedAt !== null;
          // ①과 ② 사이에 승인 이력이 생기거나 없어지면 파일 위치(공개·준비)가 달라 이 판을 쓰지 않는다
          if (approvedBefore !== reserved.approvedBefore) throw this.#rejected(at, 412, 'precondition-failed', preconditionFailed());
          const added = st.rounds.filter((x) => !covered.has(x.eventId)).map((x) => x.eventId);
          if (bytes && added.length > 0) return { kind: 'added', added };
          if (approvedBefore) await tx.savePending(doc, version, st.production.saleReview === 'APPROVED' ? 'SUBMITTED' : st.production.saleReview, bytes !== undefined);
          else await tx.saveRows(doc, version, bytes !== undefined);
          // 회차 잇기는 첫 배치본 때만이다(그 뒤 더한 회차는 회차 더하기가 같은 배치본으로 넣는다, 리뷰 C5)
          if (currentVersion(st) === 0) await tx.linkRounds();
          // 잠금은 쓰기 뒤 커밋 바로 앞에 다시 본다(② 안에서 오픈 시각이 지날 수 있다, 리뷰 C5). 승인 이력이 있으면 행은 승인된 판 그대로다
          const last = await tx.state();
          const lock = await this.#lockProbe(tx, last, doc);
          if (lock) this.#enforceLock(at, last, lock, doc);
          reachedCommit = true;
          return { kind: 'done', previous: currentVersion(st), keep: approvedBefore ? st.venue?.layoutVersion : undefined, rounds: last.rounds.map((x) => x.eventId), approvedBefore, locked: lock !== undefined };
        });
      } catch (e) {
        if (reachedCommit) {
          // 커밋 문장을 보낸 뒤의 실패라 커밋됐는지 모른다. 커밋됐을 수 있는 판의 파일을 지우지 않는다(리뷰 C1)
          this.#warn({ event: 'seatmap_commit_unknown', ...at, version, files: written.length }, '좌석맵 저장의 커밋 결과를 모른다(팬 파일을 남겼다)');
          throw e;
        }
        await discard();
        throw e;
      }
      if (r === 'not-found') {
        await discard();
        throw notFound();
      }
      if (r.kind === 'done') {
        second = r;
        break;
      }
      if (attempt >= COMMIT_RETRIES) {
        await discard();
        this.#info({ event: 'seatmap_save_rejected', ...at, status: 503, code: 'rounds-changed', version }, '좌석맵을 저장하지 않았다');
        throw seatmapPublishUnavailable(ROUNDS_CHANGED_RETRY_AFTER_S);
      }
      await publish(r.added);
      for (const e of r.added) covered.add(e);
    }
    // 커밋 뒤: 앞 판 파일을 지운다(승인된 판의 파일은 남긴다). 실패는 기록만 하고 응답은 200이다
    const prev = second.previous;
    if (prev > 0 && prev !== version && prev !== second.keep) {
      const left = await this.publisher.remove(second.rounds.map((e) => fanFileKey(e, prev, second.approvedBefore ? 'staging' : 'public')));
      if (left > 0) this.#warn({ event: 'seatmap_file_leftover', ...at, version: prev, count: left }, '지우지 못한 앞 판 팬 좌석맵 파일이 남았다');
    }
    const seats = doc.sections.reduce((n, s) => n + s.seats.length, 0);
    this.#info({ event: 'seatmap_saved', ...at, version, seats, sections: doc.sections.length, published: bytes !== undefined, where, rounds: second.rounds.length }, '좌석맵을 저장했다');
    return layoutView(doc, version, { fanFilePublished: bytes !== undefined, geometryLocked: second.locked });
  }

  /** 판매 중지·승인 이력의 관리자 판정(트랜잭션 ①·② 모두, 결정 5). logged면 실패한 인가 시도를 다시 남기지 않는다 */
  #gate(st: LayoutState, q: SaveQuery, at: Record<string, unknown>, logged: boolean): void {
    if (st.production.saleReview === 'SUSPENDED') throw this.#rejected(at, 409, 'production-suspended', productionSuspended());
    if (st.production.saleApprovedAt !== null && q.role !== 'partner_admin') {
      // 승인 뒤 저장은 재승인 대상이라 파트너 관리자만 한다(catalog-review 16.3.2: 실패한 인가 시도로 남긴다)
      if (!logged) this.#denied(q.productionId, q.who, 'save', 'partner_admin_required');
      throw this.#rejected(at, 403, 'partner-admin-required', partnerAdminRequired());
    }
  }

  /** If-Match가 지금 판과 같은가. 없으면 428을 던진다. 본문 layoutVersion이 있으면 If-Match와 같아야 한다 */
  #ifMatchOk(st: LayoutState, q: SaveQuery, ifMatch: number | undefined, at: Record<string, unknown>): boolean {
    if (q.ifMatch === undefined) throw this.#rejected(at, 428, 'precondition-required', preconditionRequired());
    return ifMatch !== undefined && ifMatch === currentVersion(st) && (q.body.layoutVersion === undefined || q.body.layoutVersion === ifMatch);
  }

  /** 틀(templateVenueId)과 보내지 않은 가격 등급을 채우고 잠금 안에서만 볼 수 있는 검사를 한다(트랜잭션 ①, 결정 4·10) */
  async #complete(tx: LayoutTx, st: LayoutState, body: LayoutInput, draft: LayoutDoc, at: Record<string, unknown>): Promise<LayoutDoc> {
    const cur = currentVersion(st);
    const stored = st.venue?.pending?.doc.templateVenueId ?? st.venue?.templateVenueId ?? undefined;
    let templateVenueId: string | undefined;
    if (cur === 0) {
      // 판 0에서만 뜻이 있고 공개된 TEMPLATE 행이어야 한다
      if (body.templateVenueId !== undefined && !(await tx.templateOk(body.templateVenueId))) throw this.#invalid(at, [{ line: 0, field: 'templateVenueId', code: 'TEMPLATE_INVALID' }]);
      templateVenueId = body.templateVenueId;
    } else {
      // 판 1 이상에서는 보내면 저장값과 같아야 한다(조용히 버리지 않는다)
      if (body.templateVenueId !== undefined && body.templateVenueId !== stored) throw this.#invalid(at, [{ line: 0, field: 'templateVenueId', code: 'TEMPLATE_INVALID' }]);
      templateVenueId = stored;
    }
    let priceTiers = draft.priceTiers;
    if (body.priceTiers === undefined) {
      // 보내지 않으면 지금 가격 등급(대기 판이 있으면 그 판의 것)을 그대로 쓴다. 판 0이면 없다(좌석이 있으면 TIER_UNKNOWN)
      priceTiers = st.venue?.pending ? st.venue.pending.doc.priceTiers : ((await tx.rowLayout())?.priceTiers ?? []);
      const issues = tierIssues(draft.sections, priceTiers);
      if (issues.length > 0) throw this.#invalid(at, issues);
    }
    return { ...draft, priceTiers, ...(templateVenueId !== undefined ? { templateVenueId } : {}) };
  }

  /** 오픈 뒤 잠금(결정 7)이면 승인된 판(행)과 바뀐 갈래. 잠기지 않았으면 undefined */
  async #lockProbe(tx: LayoutTx, st: LayoutState, doc: LayoutDoc): Promise<{ approved: LayoutDoc; changes: string[] } | undefined> {
    if (!geometryLocked({ saleApprovedAt: st.production.saleApprovedAt, rounds: st.rounds, now: new Date(this.clock.now()) })) return undefined;
    const approved = (await tx.rowLayout()) ?? EMPTY;
    return { approved, changes: geometryChanges(approved, doc) };
  }

  /** 잠겼으면 도형·좌석이 바뀐 저장은 409 seatmap-geometry-locked(보안 사건), 가격 등급이 바뀐 저장은 409 sale-setting-locked */
  #enforceLock(at: Record<string, unknown>, st: LayoutState, lock: { approved: LayoutDoc; changes: string[] }, doc: LayoutDoc): void {
    if (lock.changes.length > 0) {
      this.#lockedAttempt(at, st, lock.changes);
      throw this.#rejected(at, 409, 'seatmap-geometry-locked', seatmapGeometryLocked());
    }
    if (!sameTiers(lock.approved.priceTiers, doc.priceTiers)) throw this.#rejected(at, 409, 'sale-setting-locked', saleSettingLocked());
  }

  #lockedAttempt(at: Record<string, unknown>, st: LayoutState, changes: string[]): void {
    this.#warn({ kind: 'security', event: 'seatmap_locked_attempt', ...at, tenantId: st.production.promoterId, changes }, '오픈 뒤 잠긴 배치본을 바꾸려 했다');
  }

  #publishFailed(e: unknown, at: Record<string, unknown>, version: number, rounds: number): Error {
    if (!(e instanceof PublishFailed)) return e as Error;
    this.#warn({ event: 'seatmap_publish_failed', ...at, version, failed: e.failed, reason: e.reason, rounds }, '팬 좌석맵 파일을 쓰지 못해 저장하지 않았다');
    this.#info({ event: 'seatmap_save_rejected', ...at, status: 503, code: 'seatmap-publish-unavailable' }, '좌석맵을 저장하지 않았다');
    return seatmapPublishUnavailable(PUBLISH_RETRY_AFTER_S);
  }

  #invalid(at: Record<string, unknown>, issues: SeatmapIssue[]): Error {
    return this.#rejected(at, 422, issues[0]?.code ?? 'seatmap-invalid', seatmapInvalid(issues), issues.length);
  }

  #rejected<E extends Error>(at: Record<string, unknown>, status: number, code: string, e: E, errorCount?: number): E {
    this.#info({ event: 'seatmap_save_rejected', ...at, status, code, ...(errorCount !== undefined ? { errorCount } : {}) }, '좌석맵을 저장하지 않았다');
    return e;
  }

  /** 소속이 아닌 공연의 불러오기·저장과 실무자의 승인 뒤 저장(실패한 인가 시도, catalog-review 16.3.2) */
  #denied(productionId: string, who: Caller, action: 'load' | 'save', reason?: string): void {
    this.#warn({ kind: 'security', event: 'partner_production_denied', route: 'seatmap', action, productionId: productionId.slice(0, 64), tenantId: who.tenantId, accountId: who.accountId, ...(reason ? { reason } : {}) }, '좌석맵 요청을 막았다');
  }

  #info(line: Record<string, unknown>, msg: string): void {
    try {
      this.logger?.info(line, msg);
    } catch {
      // 기록 실패는 응답을 바꾸지 않는다
    }
  }

  #warn(line: Record<string, unknown>, msg: string): void {
    try {
      this.logger?.warn(line, msg);
    } catch {
      // 기록 실패는 응답을 바꾸지 않는다
    }
  }
}
