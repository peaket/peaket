// 추가 검증 이의 건 상세의 verificationAppeal 칸(F-06-7 GAT-280, B-T28 ①, openapi CsCaseDetail.verificationAppeal, bot-defense §12 '판정에 쓰는 자료'·'CS 처리 첫 구현'의 '상세').
// 상세를 열 때마다 queue-svc GetVerificationAppeal(대기 참여 상태, 내용을 아직 옮기지 않았으면 이때 옮긴다)과 trust-svc GetVerdictEvidence(옮긴 회차·pid)를
// 호출마다 1초 [가정] 데드라인으로 읽는다. 읽지 못해도 200이고 그 칸만 비운다(entryState null, evidence UNAVAILABLE). 근거 키가 없으면 NOT_FOUND다.
// 싣는 것은 범주 값뿐이다. pid·계정 ID·기기 가명·점수 원값·가중치·기준값·프로필 판은 싣지 않는다.
import type { CsActor, CsCase, CsCaseDetailReader } from '../domain/cs-case.js';
import {
  DETAIL_CALL_DEADLINE_MS,
  hasContent,
  type AppealEntryState,
  type CsAppealPorts,
  type CsAppealStore,
  type CsCaseDispatchRow,
  type VerdictEvidenceAnswer,
  type VerificationCase,
} from '../domain/verification-appeal.js';
import type { CsCaseDispatch } from './cs-case-dispatch.js';

const REASONS: ReadonlySet<string> = new Set(['RAPID_REQUESTS', 'DEVICE_HISTORY', 'NETWORK', 'INTERACTION', 'HUMAN_CHECK', 'SHARED_PATTERN']);
const BLOCK_VIEW: ReadonlySet<string> = new Set(['NONE', 'REMOVED', 'DEVICE_NOT_FOUND']);
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** 사유 범주 값(REASON_CATEGORY_ 앞말을 떼고 여섯 가운데 하나만, 모르면 null) */
export function reasonCategoryOf(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.startsWith('REASON_CATEGORY_') ? raw.slice('REASON_CATEGORY_'.length) : raw;
  return REASONS.has(v) ? v : null;
}

type EvidenceView = {
  state: 'FOUND' | 'NOT_FOUND' | 'UNAVAILABLE';
  hardSignal: string | null;
  source: string | null;
  decidedAt: string | null;
  deviceChallenges: { sent: number; passed: number; failed: number } | null;
};

const emptyEvidence = (state: 'NOT_FOUND' | 'UNAVAILABLE'): EvidenceView => ({ state, hardSignal: null, source: null, decidedAt: null, deviceChallenges: null });

function evidenceView(e: VerdictEvidenceAnswer | undefined): EvidenceView {
  if (!e) return emptyEvidence('UNAVAILABLE');
  if (!e.found) return emptyEvidence('NOT_FOUND');
  return { state: 'FOUND', hardSignal: e.hardSignal, source: e.source, decidedAt: iso(e.decidedAtMs), deviceChallenges: { sent: e.sent, passed: e.passed, failed: e.failed } };
}

/** 보낼 호출의 요약(NONE·PENDING·APPLIED·FAILED) */
export function reflectStateOf(rows: readonly Pick<CsCaseDispatchRow, 'state'>[]): 'NONE' | 'PENDING' | 'APPLIED' | 'FAILED' {
  if (rows.length === 0) return 'NONE';
  if (rows.some((r) => r.state === 'FAILED')) return 'FAILED';
  return rows.every((r) => r.state === 'APPLIED') ? 'APPLIED' : 'PENDING';
}

export interface VerificationAppealDetailDeps {
  readonly store: CsAppealStore;
  readonly ports: CsAppealPorts;
  readonly dispatch: CsCaseDispatch;
  readonly clock: { now(): number };
}

export class VerificationAppealDetail implements CsCaseDetailReader {
  constructor(private readonly d: VerificationAppealDetailDeps) {}

  async read(c: CsCase, _actor: CsActor): Promise<Record<string, unknown>> {
    const nowMs = this.d.clock.now();
    let a = await this.d.store.appealOf(c.caseId);
    let content: 'AVAILABLE' | 'PENDING' | 'GONE' = 'PENDING';
    let entryState: AppealEntryState | null = null;
    let evidence: VerdictEvidenceAnswer | undefined;
    if (a && !hasContent(a)) {
      if (a.status === 'SKIPPED') content = 'GONE';
      else {
        // 내용을 아직 옮기지 않았으면 이때 옮긴다(배경 작업을 기다리지 않는다)
        const copied = await this.d.dispatch.copyForDetail(a, nowMs);
        if (copied === 'GONE') content = 'GONE';
        else if (copied) {
          a = (await this.d.store.appealOf(c.caseId)) ?? a;
          entryState = copied.entryState;
          content = hasContent(a) ? 'AVAILABLE' : 'PENDING';
          if (content === 'AVAILABLE') evidence = await this.#evidence(a);
        }
      }
    } else if (a) {
      content = 'AVAILABLE';
      [entryState, evidence] = await Promise.all([this.#entryState(a), this.#evidence(a)]);
    }
    const rows = a ? await this.d.store.dispatchRowsOf(c.caseId) : [];
    const available = content === 'AVAILABLE' && a !== undefined;
    return {
      verificationAppeal: {
        appealId: a?.appealId ?? c.targetRef,
        content,
        text: available ? (a!.text ?? '') : null,
        request: available ? ((a!.text ?? '') === '' ? 'EXPLANATION' : 'REVIEW') : null,
        reasonCategory: reasonCategoryOf(available ? a!.reasonCategory : c.category),
        receivedAt: available ? iso(a!.receivedAtMs) : null,
        entryState,
        evidence: evidenceView(evidence),
        decision: a ? decisionOf(a) : null,
        reflectState: reflectStateOf(rows),
        dispatch: rows.map((r) => ({ call: r.call, state: r.state, attempts: r.attempts, lastError: r.lastError, updatedAt: new Date(r.updatedAtMs).toISOString() })),
      },
    };
  }

  async #entryState(a: VerificationCase): Promise<AppealEntryState | null> {
    if (!this.d.ports.appeals) return null;
    try {
      return (await this.d.ports.appeals.get(a.appealId, { deadlineMs: DETAIL_CALL_DEADLINE_MS })).entryState;
    } catch {
      return null;
    }
  }

  async #evidence(a: VerificationCase): Promise<VerdictEvidenceAnswer | undefined> {
    if (!this.d.ports.evidence || a.eventId === null || a.pid === null) return undefined;
    try {
      return await this.d.ports.evidence.get({ eventId: a.eventId, pid: a.pid }, { deadlineMs: DETAIL_CALL_DEADLINE_MS });
    } catch {
      return undefined;
    }
  }
}

function decisionOf(a: VerificationCase): Record<string, unknown> | null {
  if (a.appealResult === null || a.decidedBy === null || a.decidedAtMs === null) return null;
  const change = a.appealResult === 'ACCEPTED' && a.blockListChange !== null && BLOCK_VIEW.has(a.blockListChange) ? a.blockListChange : null;
  return { outcome: a.appealResult, decidedBy: a.decidedBy, decidedAt: iso(a.decidedAtMs), blockListChange: change };
}
