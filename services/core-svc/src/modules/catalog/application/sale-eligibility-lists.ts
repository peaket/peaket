// 유스케이스: 판매 자격 명단 목록·올리기·지우기(openapi listPartnerSaleEligibilityLists·createPartnerSaleEligibilityList·deletePartnerSaleEligibilityList,
// ADR-0062 결정 35·37, ADR-0261 결정 6~9·13, docs/data.md §5 경합 줄, BUILD_ORDER HOT-250).
// 올리기 차례(먼저 걸린 것으로 답한다): 소속(404, 받는 층이 먼저 부른다) → X-Requested-With(400, 받는 층) → 실무자(403, 실패한 인가 시도) → 판매 중지(409)
// → 파일 8MiB(413) → 칸(400: key 모양·name 1~40자, 제어·양방향 제어 문자·줄바꿈 없음) → 압축·50만 줄(바이트로 셈)·UTF-8(422) → 잠금 앞 확인(409, 잠금 밖) → 공연당 10개(409)
// → 공연마다 시간당 20번 [가정](429 sale-eligibility-upload-limited) → 회원 코드 변환(잠금 밖, 취소 신호를 넘기고 실패하면 503이며 아무것도 저장하지 않는다)
// → 남은 시간(트랜잭션 앞 20초 [가정] 미만이면 504) → 트랜잭션(공연 행 잠금: 판매 중지·잠금 시각·명단 수를 다시 본다. 명단 행 판 +1·새 사본 판, 구성원을 바꿔 넣는다)
// → 커밋 뒤 사본 넘기기(남은 시간이 5초 [가정] 미만이면 넘기지 않고 정비 일에 맡긴다. 실패해도 200, 넘긴 판만 적는다).
// 지우기는 지운 기록(새 사본 판)을 같은 트랜잭션에 남기고 커밋 뒤 사본 지우기를 넘긴다. 실패하면 정비 일이 성공할 때까지 다시 지운다(리뷰 S1).
// 올린 파일은 메모리에서만 읽고 어디에도 두지 않는다. 결과·로그에는 회원 코드·구성원 계정 ID를 싣지 않는다(건수·행 번호·SHA-256만, Q-T36 ⑥).
import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, deadlineExceeded, PLATFORM_LOGGER, type PlatformLogger, ProblemError, requestContext, RequestValidationError, uuidv7 } from '@peaket/platform';
import { SaleEligibilityMetrics, type UploadResult } from './sale-eligibility-metrics.js';
import { LOG_PSEUDONYM, type LogPseudonym, MEMBER_CODE_DIRECTORY, MemberCodeLookupFailed, type MemberCodeDirectory, SALE_ELIGIBILITY_COPY, SALE_ELIGIBILITY_METRICS, type SaleEligibilityCopy } from '../domain/eligibility-ports.js';
import {
  COPY_MIN_REMAINING_MS,
  destroyTime,
  isLocked,
  LIST_KEY,
  listEventIds,
  listNameOk,
  lockTime,
  LOOKUP_RETRY_AFTER_S,
  MAX_LISTS_PER_PRODUCTION,
  MAX_REPORTED_LINES,
  readMemberLines,
  UPLOAD_MAX_BYTES,
  UPLOAD_TX_MIN_REMAINING_MS,
  UPLOAD_WINDOW_MS,
  UPLOADS_PER_WINDOW,
} from '../domain/sale-eligibility.js';
import { SALE_STORE, type SaleState, type SaleStore, type StoredList } from '../domain/sale-ports.js';
import type { Caller } from './import-seatmap.js';
import {
  memberCodeLookupUnavailable,
  notFound,
  partnerAdminRequired,
  productionSuspended,
  saleEligibilityListLimit,
  saleEligibilityListLocked,
  saleEligibilityUploadLimited,
  saleEligibilityUploadRejected,
  saleEligibilityUploadTooLarge,
} from './problems.js';
import { strictFields, type UploadForm } from './upload-form.js';

export interface SaleEligibilityListView {
  key: string;
  name: string;
  memberCount: number;
  lockedAt: string | null;
  destroyDueAt: string;
  uploadedAt: string;
  version: number;
}

export interface SaleEligibilityUploadResult {
  listKey: string;
  version: number;
  applied: number;
  invalidLineCount: number;
  invalidLines: number[];
  unknownLineCount: number;
  unknownLines: number[];
  fileSha256: string;
}

const UPLOAD_REJECT_DETAIL = { COMPRESSED: '압축 파일은 받지 않는다', NOT_UTF8: 'UTF-8 글자가 아니다', TOO_MANY_LINES: '50만 줄을 넘었다' } as const;


const view = (l: StoredList): SaleEligibilityListView => ({
  key: l.key,
  name: l.name,
  memberCount: l.memberCount,
  lockedAt: l.lockedAt ? l.lockedAt.toISOString() : null,
  destroyDueAt: l.destroyDueAt.toISOString(),
  uploadedAt: l.uploadedAt.toISOString(),
  version: l.version,
});

const roundTimes = (st: SaleState) => st.events.map((e) => ({ eventId: e.eventId, startsAt: e.startsAt, openAt: e.openAt, status: e.status }));
/** 이 요청의 남은 시간(요청 밖이면 끝 없음) */
const remainingMs = () => requestContext()?.deadline.remainingMs() ?? Number.POSITIVE_INFINITY;

/** 올리기 결과 지표의 값(소속·권한 거절은 세지 않는다) */
function uploadResult(e: unknown): UploadResult | undefined {
  if (!(e instanceof ProblemError) && !(e instanceof RequestValidationError)) return 'rejected';
  if (e instanceof ProblemError && (e.status === 403 || e.status === 404)) return undefined;
  if (e instanceof ProblemError && e.slug === 'sale-eligibility-list-locked') return 'locked';
  if (e instanceof ProblemError && e.slug === 'member-code-lookup-unavailable') return 'lookup_unavailable';
  return 'rejected';
}

@Injectable()
export class SaleEligibilityLists {
  constructor(
    @Inject(SALE_STORE) private readonly store: SaleStore,
    @Inject(MEMBER_CODE_DIRECTORY) private readonly directory: MemberCodeDirectory,
    @Inject(SALE_ELIGIBILITY_COPY) private readonly copy: SaleEligibilityCopy,
    @Inject(LOG_PSEUDONYM) private readonly pseudonym: LogPseudonym,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info' | 'warn'>,
    @Optional() @Inject(SALE_ELIGIBILITY_METRICS) private readonly metrics: SaleEligibilityMetrics = new SaleEligibilityMetrics(),
  ) {}

  /** 목록(명단 정보만, 키 차례) */
  async list(q: { productionId: string; who: Caller }): Promise<{ items: SaleEligibilityListView[] }> {
    const st = await this.store.read(q.productionId, q.who.tenantId);
    if (!st) {
      this.#denied(q.productionId, q.who, 'list');
      throw notFound();
    }
    return { items: [...st.lists].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map(view) };
  }

  /** 소속 확인(본문을 보기 전). 남의 공연과 없는 공연은 같은 404이고 실패한 인가 시도로 남긴다 */
  async authorize(productionId: string, who: Caller, action: 'upload' | 'delete'): Promise<void> {
    if (await this.store.owner(productionId, who.tenantId)) return;
    this.#denied(productionId, who, action);
    throw notFound();
  }

  async upload(q: { productionId: string; who: Caller; role: string; form: UploadForm }): Promise<SaleEligibilityUploadResult> {
    try {
      const out = await this.#upload(q);
      this.metrics.upload('ok');
      return out;
    } catch (e) {
      const result = uploadResult(e);
      if (result) this.metrics.upload(result);
      throw e;
    }
  }

  async #upload(q: { productionId: string; who: Caller; role: string; form: UploadForm }): Promise<SaleEligibilityUploadResult> {
    const at = { productionId: q.productionId, accountId: q.who.accountId };
    this.#adminOnly(q.productionId, q.who, q.role, 'upload');
    const owner = await this.store.owner(q.productionId, q.who.tenantId);
    if (!owner) throw notFound();
    if (owner.suspended) throw this.#rejected(at, 409, 'production-suspended', productionSuspended());
    if (q.form.files.some((f) => f.size > UPLOAD_MAX_BYTES)) throw this.#rejected(at, 413, 'too-large', saleEligibilityUploadTooLarge());
    const { file, values } = strictFields(q.form, ['key', 'name'], []);
    const key = values.get('key')!;
    const name = values.get('name')!;
    if (!LIST_KEY.test(key)) throw new RequestValidationError('key 모양');
    if (!listNameOk(name)) throw new RequestValidationError('name 1~40자, 제어 문자·양방향 제어 문자·줄바꿈 없음');
    const bytes = await file.bytes();
    const sha = createHash('sha256').update(bytes).digest();
    const lines = readMemberLines(bytes);
    if (typeof lines === 'string') throw this.#rejected({ ...at, listKey: key, bytes: bytes.length }, 422, lines, saleEligibilityUploadRejected(UPLOAD_REJECT_DETAIL[lines]));

    // 잠금 앞 확인(잠금 밖): 잠긴 명단이면 회원 코드를 바꾸지 않고 거절한다. 트랜잭션 안에서 다시 본다
    const pre = await this.store.read(q.productionId, q.who.tenantId);
    if (!pre) throw notFound();
    this.#gate(pre, key, at);
    // 회원 코드 대량 떠보기를 막는 횟수 한도(공연마다 시간당 20번 [가정], 리뷰 S5). 변환까지 간 시도만 센다
    const slot = await this.store.takeUploadSlot(q.productionId, q.who.tenantId, new Date(this.clock.now()), UPLOADS_PER_WINDOW, UPLOAD_WINDOW_MS);
    if (slot === 'not-found') throw notFound();
    if (!slot.ok) throw this.#rejected(at, 429, 'sale-eligibility-upload-limited', saleEligibilityUploadLimited(Math.max(1, Math.ceil(slot.retryAfterMs / 1000))));

    // 회원 코드 변환(잠금 밖). 요청의 남은 시간이 다하면 끊는다. 하나라도 실패하면 아무것도 저장하지 않는다
    let resolved: Map<string, string>;
    const ctl = new AbortController();
    const left = remainingMs();
    const timer = Number.isFinite(left) ? setTimeout(() => ctl.abort(), left) : undefined;
    timer?.unref?.();
    try {
      resolved = await this.directory.resolve([...lines.codes.keys()], { signal: ctl.signal });
    } catch (e) {
      if (!(e instanceof MemberCodeLookupFailed)) throw e;
      if (ctl.signal.aborted) throw this.#rejected(at, 504, 'deadline-exceeded', deadlineExceeded());
      this.#warn({ event: 'member_code_lookup_failed', ...at, listKey: key, reason: e.reason, codes: lines.codes.size }, '회원 코드를 바꾸지 못해 명단을 반영하지 않았다');
      throw this.#rejected(at, 503, 'member-code-lookup-unavailable', memberCodeLookupUnavailable(LOOKUP_RETRY_AFTER_S));
    } finally {
      if (timer) clearTimeout(timer);
    }
    // 구성원 넣기를 시작하기 전에 남은 시간을 본다(모자라면 아무것도 저장하지 않고 504, 리뷰 C6)
    if (remainingMs() < UPLOAD_TX_MIN_REMAINING_MS) throw this.#rejected(at, 504, 'deadline-exceeded', deadlineExceeded());
    const accountIds = [...new Set(resolved.values())];
    const unknown = [...lines.codes].filter(([code]) => !resolved.has(code)).flatMap(([, ns]) => ns).sort((a, b) => a - b);

    const out = await this.store.withLockedProduction(q.productionId, q.who.tenantId, async (tx) => {
      const st = await tx.state();
      if (st.production.saleReview === 'SUSPENDED') throw this.#rejected(at, 409, 'production-suspended', productionSuspended());
      // 변환하는 사이에 잠금 시각이 지났을 수 있다(data.md §5: 잠금 시각을 트랜잭션 안에서 다시 본다)
      const { existing, lockedAt, now } = this.#gate(st, key, at);
      const version = (existing?.version ?? 0) + 1;
      const id = existing?.id ?? uuidv7(this.clock);
      const destroyDueAt = destroyTime(roundTimes(st));
      const copySeq = await tx.putList({ id, key, name, memberCount: accountIds.length, fileSha256: sha, version, uploadedAt: now, uploadedBy: q.who.accountId, lockedAt, destroyDueAt }, accountIds);
      // 사본의 회차·수명은 커밋하는 지금의 규칙·회차로 정한다(리뷰 H1)
      return { id, version, copySeq, destroyDueAt, eventIds: listEventIds(st.production.rules, key, roundTimes(st)), uploadedAt: now };
    });
    if (out === 'not-found') throw notFound();

    const result: SaleEligibilityUploadResult = {
      listKey: key,
      version: out.version,
      applied: accountIds.length,
      invalidLineCount: lines.invalidLines.length,
      invalidLines: lines.invalidLines.slice(0, MAX_REPORTED_LINES),
      unknownLineCount: unknown.length,
      unknownLines: unknown.slice(0, MAX_REPORTED_LINES),
      fileSha256: sha.toString('hex'),
    };
    // 감사 기록: 올린 계정·공연·명단 키·시각·건수·파일 SHA-256만(회원 코드·구성원 계정 ID는 넣지 않는다, catalog-review 16.2.5).
    // 올린 계정은 원문 대신 로그 가명 accountRef다(정규 로그 줄과 같은 키, ADR-0053 결정 1. 원문은 명단 행 uploaded_by에 있다)
    this.#info(
      { kind: 'security', event: 'sale_eligibility.uploaded', accountRef: this.pseudonym.ref(q.who.accountId), productionId: q.productionId, listKey: key, at: out.uploadedAt.toISOString(), version: out.version, applied: result.applied, invalidLineCount: result.invalidLineCount, unknownLineCount: result.unknownLineCount, fileSha256: result.fileSha256 },
      '판매 자격 명단을 올렸다',
    );
    // 커밋 뒤 사본 넘기기. 실패해도 올리기는 200이고 정비 일 sale-eligibility-copy가 다시 넘긴다(ADR-0261 결정 9). 남은 시간이 모자라면 넘기지 않는다(리뷰 C6)
    if (remainingMs() < COPY_MIN_REMAINING_MS) {
      this.#warn({ event: 'sale_eligibility_copy_deferred', productionId: q.productionId, listKey: key, copySeq: out.copySeq }, '남은 시간이 모자라 판매 자격 명단 사본을 정비 일에 맡겼다');
      return result;
    }
    try {
      await this.copy.put({ productionId: q.productionId, eventIds: out.eventIds, listKey: key, version: out.copySeq, accountIds, expiresAt: out.destroyDueAt });
      await this.store.markCopied(out.id, q.who.tenantId, out.copySeq);
      this.metrics.copy('ok');
    } catch (e) {
      this.metrics.copy('failed');
      this.#warn({ event: 'sale_eligibility_copy_failed', productionId: q.productionId, listKey: key, copySeq: out.copySeq, err: (e as Error).name }, '판매 자격 명단 사본을 넘기지 못했다(정비 일이 다시 넘긴다)');
    }
    return result;
  }

  async remove(q: { productionId: string; listKey: string; who: Caller; role: string }): Promise<void> {
    const at = { productionId: q.productionId, accountId: q.who.accountId };
    this.#adminOnly(q.productionId, q.who, q.role, 'delete');
    const pre = await this.store.read(q.productionId, q.who.tenantId);
    if (!pre) throw notFound();
    if (pre.production.saleReview === 'SUSPENDED') throw this.#rejected(at, 409, 'production-suspended', productionSuspended());
    if (!pre.lists.some((l) => l.key === q.listKey)) throw notFound();
    this.#lockGate(pre, q.listKey, at);
    const out = await this.store.withLockedProduction(q.productionId, q.who.tenantId, async (tx) => {
      const st = await tx.state();
      if (st.production.saleReview === 'SUSPENDED') throw this.#rejected(at, 409, 'production-suspended', productionSuspended());
      // 그 사이 없어진 명단은 공연당 명단 수와 상관없이 404다(리뷰 C6)
      if (!st.lists.some((l) => l.key === q.listKey)) throw notFound();
      const { existing, now } = this.#lockGate(st, q.listKey, at);
      const copySeq = await tx.deleteList(existing!.id, q.listKey, now);
      // 사본 지우기는 그 공연의 회차 모두에 넘긴다(사본은 회차마다 키다)
      return { eventIds: st.events.map((e) => e.eventId), now, copySeq };
    });
    if (out === 'not-found') throw notFound();
    this.#info({ kind: 'security', event: 'sale_eligibility.deleted', accountRef: this.pseudonym.ref(q.who.accountId), productionId: q.productionId, listKey: q.listKey, at: out.now.toISOString() }, '판매 자격 명단을 지웠다');
    try {
      await this.copy.drop({ eventIds: out.eventIds, listKey: q.listKey, version: out.copySeq });
      await this.store.dropDone(q.productionId, q.who.tenantId, q.listKey, out.copySeq);
      this.metrics.copy('ok');
    } catch (e) {
      // 지운 기록이 남아 정비 일 sale-eligibility-copy가 성공할 때까지 다시 지운다(리뷰 S1)
      this.metrics.copy('failed');
      this.#warn({ event: 'sale_eligibility_copy_failed', productionId: q.productionId, listKey: q.listKey, op: 'drop', err: (e as Error).name }, '판매 자격 명단 사본 지우기를 넘기지 못했다(정비 일이 다시 지운다)');
    }
  }

  /** 잠금(지금 ≥ 잠금 시각, 경계 포함)과 공연당 명단 수(올리기) */
  #gate(st: SaleState, key: string, at: Record<string, unknown>): { existing: StoredList | undefined; lockedAt: Date | null; now: Date } {
    const out = this.#lockGate(st, key, at);
    if (!out.existing && st.lists.length >= MAX_LISTS_PER_PRODUCTION) throw this.#rejected(at, 409, 'sale-eligibility-list-limit', saleEligibilityListLimit());
    return out;
  }

  /** 잠금(지금 ≥ 잠금 시각, 경계 포함). 잠긴 명단을 바꾸려 한 것은 보안 사건이다(catalog-review 16.3.3) */
  #lockGate(st: SaleState, key: string, at: Record<string, unknown>): { existing: StoredList | undefined; lockedAt: Date | null; now: Date } {
    const now = new Date(this.clock.now());
    const existing = st.lists.find((l) => l.key === key);
    const rounds = st.events.map((e) => ({ eventId: e.eventId, openAt: e.openAt, status: e.status }));
    const lockedAt = lockTime(st.production.rules, key, existing?.lockedAt ?? null, now, rounds);
    if (isLocked(lockedAt, now)) {
      this.#warn({ kind: 'security', event: 'sale_eligibility_locked_attempt', ...at, tenantId: st.production.promoterId, listKey: key }, '잠긴 판매 자격 명단을 바꾸려 했다');
      throw this.#rejected(at, 409, 'sale-eligibility-list-locked', saleEligibilityListLocked());
    }
    return { existing, lockedAt, now };
  }

  /** 명단 올리기·지우기는 파트너 관리자만(ADR-0062 결정 35, 실무자 403, 실패한 인가 시도로 남긴다) */
  #adminOnly(productionId: string, who: Caller, role: string, action: 'upload' | 'delete'): void {
    if (role === 'partner_admin') return;
    this.#denied(productionId, who, action, 'partner_admin_required');
    throw partnerAdminRequired();
  }

  #rejected<E extends Error>(at: Record<string, unknown>, status: number, code: string, e: E): E {
    this.#info({ event: 'sale_eligibility_rejected', ...at, status, code }, '판매 자격 명단을 바꾸지 않았다');
    return e;
  }

  #denied(productionId: string, who: Caller, action: string, reason?: string): void {
    this.#warn({ kind: 'security', event: 'partner_production_denied', route: 'sale_eligibility', action, productionId: productionId.slice(0, 64), tenantId: who.tenantId, accountId: who.accountId, ...(reason ? { reason } : {}) }, '판매 자격 명단 요청을 막았다');
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
