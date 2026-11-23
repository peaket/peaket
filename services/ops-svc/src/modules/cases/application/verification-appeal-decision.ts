// 추가 검증 이의 인정·기각(F-06-7 GAT-280, B-T28 ②③④, openapi createOpsCaseVerificationAppealDecision, bot-defense §12 'CS 처리 첫 구현'의 '결정').
// 받는 차례: (멱등 키 400·본문 400은 받는 층) → 같은 키 다시 보내기면 처음 결과(다른 본문 422) → 404 → CS 담당자(cs_agent·cs_lead)가 아니면 403 case-update-not-allowed
// → 다른 종류 409 case-action-not-applicable → If-Match 없음 428·다름 412 → 해결된 건 409 case-already-resolved → 메모 2,001자 이상 400·없음·공백 422.
// 맡은 사람이 아니어도 CS 담당자면 결정하고 배정은 그대로다. 한 트랜잭션에 건 해결(판 +1, 메모, 해결 시각)·이의 결과·처리자·처리 시각·보낼 호출(새 판)·
// 감사(CS_CASE_UPDATED + appealOutcome, 메모·이의 글·pid 없음)·멱등 기록을 쓰고, 커밋 뒤 그 건의 호출을 한 번씩 보내 본 뒤 결과와 상관없이 202다.
import { ProblemError, idempotencyKeyReused, idempotencyRequestInProgress, type IdempotencyRequest } from '@peaket/platform';
import { timingSafeEqual } from 'node:crypto';
import type { CsActor, CsCase, CsCaseStore } from '../domain/cs-case.js';
import { RESULT_NOTE_MAX } from '../domain/cs-case.js';
import { VERIFICATION_APPEAL_KIND, decisionCallsOf, type AppealOutcome, type CsAppealStore } from '../domain/verification-appeal.js';
import type { CsCaseDispatch } from './cs-case-dispatch.js';
import { caseUpdateAudit, isCsRole, parseIfMatch, type CsCases, type CsCaseView } from './cs-cases.js';

/** 멱등 작업 이름(ops 0031 idempotency_record 작업 목록) */
export const DECIDE_VERIFICATION_APPEAL = 'DECIDE_VERIFICATION_APPEAL';

export interface AppealDecisionBody {
  readonly outcome: AppealOutcome;
  readonly resultNote?: string | undefined;
}

export interface VerificationAppealDecisionDeps {
  readonly cases: CsCases;
  readonly caseStore: Pick<CsCaseStore, 'find'>;
  readonly store: CsAppealStore;
  readonly dispatch: CsCaseDispatch;
  readonly clock: { now(): number };
  readonly log?: { warn(obj: object, msg: string): void };
}

const problem = (type: string, status: number, title: string): ProblemError => new ProblemError({ type, status, title });
const codePoints = (s: string): number => [...s].length;
const sameHash = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class VerificationAppealDecision {
  constructor(private readonly d: VerificationAppealDecisionDeps) {}

  async handle(actor: CsActor, caseId: string, ifMatch: string | undefined, idem: IdempotencyRequest, body: AppealDecisionBody): Promise<{ view: CsCaseView; version: number }> {
    // 같은 키 다시 보내기: 커밋한 처음 결과를 그대로(판·해결 검사보다 먼저, guidelines §4)
    const replayed = await this.#replay(idem);
    if (replayed) return replayed;
    const c = await this.d.cases.visible(actor, caseId);
    if (!isCsRole(actor.role)) throw problem('case-update-not-allowed', 403, '이의 인정·기각은 CS 담당자가 합니다');
    if (c.kind !== VERIFICATION_APPEAL_KIND) throw problem('case-action-not-applicable', 409, '이 건 종류에는 이 처리가 없습니다');
    const version = parseIfMatch(ifMatch);
    if (version === null) throw problem('precondition-required', 428, '고칠 판(If-Match)을 보내 주세요');
    if (version !== c.version) throw problem('precondition-failed', 412, '다른 곳에서 이 건을 먼저 고쳤습니다');
    if (c.status === 'RESOLVED') throw problem('case-already-resolved', 409, '이미 해결한 건입니다');
    if (body.resultNote !== undefined && codePoints(body.resultNote) > RESULT_NOTE_MAX) throw problem('invalid-body', 400, '결과 메모는 2,000자까지입니다');
    if (body.resultNote === undefined || body.resultNote.trim() === '') throw problem('case-result-note-required', 422, '결과 메모를 적어 주세요');
    const nowMs = this.d.clock.now();
    const next: CsCase = { ...c, status: 'RESOLVED', resultNote: body.resultNote, resolvedAtMs: nowMs, version: c.version + 1, updatedAtMs: nowMs };
    const r = await this.d.store.decide({
      next,
      expectedVersion: c.version,
      audit: caseUpdateAudit(c, next, actor, nowMs, { appealOutcome: body.outcome }),
      outcome: body.outcome,
      decidedBy: actor.accountId,
      decidedAtMs: nowMs,
      calls: decisionCallsOf(body.outcome),
      idem: { accountRef: idem.accountRef, operation: idem.operation, key: idem.key, requestHash: idem.requestHash },
    });
    if (r.kind === 'stale') throw problem('precondition-failed', 412, '다른 곳에서 이 건을 먼저 고쳤습니다');
    if (r.kind === 'replay') return this.#viewOf(r.caseId);
    await this.d.cases.releaseAlerts(next, nowMs);
    // 커밋 뒤 그 건의 호출을 한 번씩 보내 본다(호출마다 2초 [가정]). 실패는 배경 작업이 같은 판으로 다시 보낸다
    try {
      await this.d.dispatch.sendCase(next.caseId, this.d.clock.now());
    } catch (err) {
      this.d.log?.warn({ event: 'cs-case-dispatch-after-decision-failed', caseId: next.caseId, err: err instanceof Error ? err.name : 'unknown' }, '결정 직후 보내기가 실패했다(배경 작업이 다시 보낸다)');
    }
    return { view: this.d.cases.view(next, this.d.clock.now()), version: next.version };
  }

  async #replay(idem: IdempotencyRequest): Promise<{ view: CsCaseView; version: number } | undefined> {
    const rec = await this.d.store.findDecisionRecord(idem);
    if (!rec) return undefined;
    if (!sameHash(rec.requestHash, idem.requestHash)) throw idempotencyKeyReused();
    if (rec.caseId === null) throw idempotencyRequestInProgress();
    return this.#viewOf(rec.caseId);
  }

  async #viewOf(caseId: string): Promise<{ view: CsCaseView; version: number }> {
    const c = await this.d.caseStore.find(caseId);
    if (!c) throw idempotencyRequestInProgress();
    return { view: this.d.cases.view(c, this.d.clock.now()), version: c.version };
  }
}
