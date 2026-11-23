// 추가 검증 이의의 보낼 호출(F-06-7 GAT-280, B-T28 ⑤⑥, B-T10 ⑥, bot-defense §12 'CS 처리 첫 구현'의 '다시 보내기'·'시계와 시도 수'·'기다림과 이어 보내기'·'지표').
// - run(nowMs): 배경 작업 한 바퀴. 보낼 때가 된 호출을 50개 [가정]씩 30초 [가정] 동안 잡고(겹쳐 보내지 않게) 같은 판으로 보낸다.
// - sendCase(caseId, nowMs): 결정 직후 보내기. 그 건의 반영되지 않았고 다시 보내지 않는 실패도 아닌 호출을 다음 시각과 상관없이 잡아 보낸다.
// - 한 건의 호출은 APPEAL_COPY → ACCOUNT_HOLD_OPEN → QUEUE_RESOLVE → TRUST_LABEL → ACCOUNT_HOLD_CLOSE 차례로 하나씩 보낸다(건끼리는 함께).
//   내용(APPEAL_COPY)이 아직 없으면 병합 막기·라벨은 보내지 않고 시도 0·다음 시각 그대로 기다리고, 내용을 옮긴 그 바퀴에 이어 보낸다.
//   보관이 끝나 내용이 없으면(NOT_FOUND, 이의 행 SKIPPED) 그 호출들은 APPEAL_CONTENT_MISSING 반영 실패다.
// - 실패: 다시 보내지 않는 상태 다섯은 바로 반영 실패. 그 밖(주소 없음 NOT_CONFIGURED 포함)은 n번째 실패 시각 + min(10초 × 2^(n−1), 10분) 뒤에 다시 보내고,
//   8번째 실패에서 반영 실패가 된다(그 뒤에도 10분마다 다시 보낸다). 반영 실패가 되면 SEV3 CS_CASE_DISPATCH_FAILED를 건·호출마다 한 번 열고, 반영되면 푼다.
// - 시계는 부르는 쪽 시각(앱 시계)이고 DB now()를 쓰지 않는다. pid·계정 ID·이의 글은 로그·경보에 싣지 않는다.
import type { CsCaseAlertSink } from './cs-case-deadline-tick.js';
import {
  APPEAL_CONTENT_MISSING,
  CS_CASE_DISPATCH_FAILED_ALERT,
  CsDispatchCallError,
  DETAIL_CALL_DEADLINE_MS,
  DISPATCH_BATCH,
  DISPATCH_CALLS,
  DISPATCH_CALL_DEADLINE_MS,
  DISPATCH_CLAIM_MS,
  DISPATCH_FAIL_AFTER,
  NEEDS_CONTENT,
  NOT_CONFIGURED,
  NO_RETRY_CODES,
  VERIFICATION_APPEAL_KIND,
  appealStatusOf,
  hasContent,
  retryWaitMs,
  type AppealContent,
  type CsAppealPorts,
  type CsAppealStore,
  type CsCaseDispatchRow,
  type VerificationCase,
} from '../domain/verification-appeal.js';

export interface CsCaseDispatchDeps {
  readonly store: CsAppealStore;
  readonly ports: CsAppealPorts;
  /** ops 경보 원장(RecordOpsAlert) */
  readonly alerts: CsCaseAlertSink;
  readonly log?: { warn(obj: object, msg: string): void };
}

export interface DispatchTally {
  applied: number;
  retried: number;
  failed: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const order = (r: CsCaseDispatchRow): number => DISPATCH_CALLS.indexOf(r.call);
/** 반영 실패 경보 키(건·호출마다 한 번) */
export const csCaseDispatchAlertKey = (caseId: string, call: string): string => `cs-case-dispatch:${caseId}:${call}`;

type Outcome = { readonly ok: true; readonly result: string } | { readonly ok: false; readonly code: string; readonly counted: boolean };

export class CsCaseDispatch {
  constructor(private readonly d: CsCaseDispatchDeps) {}

  /** 배경 작업 한 바퀴 */
  async run(nowMs: number): Promise<DispatchTally> {
    const claimed = await this.d.store.claimDue(nowMs, DISPATCH_BATCH, DISPATCH_CLAIM_MS);
    const byCase = new Map<string, CsCaseDispatchRow[]>();
    for (const r of claimed) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
    const tally: DispatchTally = { applied: 0, retried: 0, failed: 0 };
    await Promise.all([...byCase].map(([caseId, rows]) => this.#sendCase(caseId, rows, nowMs, tally)));
    return tally;
  }

  /** 결정 직후 보내기(그 건의 반영되지 않은 호출을 모두, 다른 쪽이 잡은 것은 건너뛴다) */
  async sendCase(caseId: string, nowMs: number): Promise<DispatchTally> {
    const tally: DispatchTally = { applied: 0, retried: 0, failed: 0 };
    const rows = await this.d.store.claimCase(caseId, nowMs, DISPATCH_CLAIM_MS);
    if (rows.length > 0) await this.#sendCase(caseId, rows, nowMs, tally);
    return tally;
  }

  /**
   * 상세를 열 때 아직 옮기지 않은 내용을 옮긴다(1초 [가정] 데드라인). 옮겼으면 그 내용, 보관이 끝났으면 'GONE', 읽지 못했으면 undefined.
   * 옮긴 내용 옮기기 호출은 반영됨으로 적는다(배경 작업이 다시 읽지 않게)
   */
  async copyForDetail(a: VerificationCase, nowMs: number): Promise<AppealContent | 'GONE' | undefined> {
    const port = this.d.ports.appeals;
    if (!port) return undefined;
    let content: AppealContent;
    try {
      content = await port.get(a.appealId, { deadlineMs: DETAIL_CALL_DEADLINE_MS });
    } catch (err) {
      return err instanceof CsDispatchCallError && err.code === 'NOT_FOUND' ? 'GONE' : undefined;
    }
    await this.d.store.copyAppealContent(a.caseId, content, nowMs);
    const row = (await this.d.store.dispatchRowsOf(a.caseId)).find((r) => r.call === 'APPEAL_COPY');
    if (row && row.state !== 'APPLIED') await this.#applied(row, 'COPIED', nowMs, { applied: 0, retried: 0, failed: 0 });
    return content;
  }

  async #sendCase(caseId: string, claimed: readonly CsCaseDispatchRow[], nowMs: number, tally: DispatchTally): Promise<void> {
    const rows = [...claimed].sort((a, b) => order(a) - order(b));
    let appeal = await this.d.store.appealOf(caseId);
    for (const row of rows) {
      try {
        if (!appeal) {
          // 이의 행이 없는 건(대상이 UUID가 아님 등)은 보낼 것이 없다. 잡음만 푼다
          await this.d.store.saveDispatch(row);
          continue;
        }
        if (NEEDS_CONTENT.has(row.call) && !hasContent(appeal)) {
          if (appeal.status === 'SKIPPED') await this.#failed(row, APPEAL_CONTENT_MISSING, false, nowMs, tally);
          // 내용을 기다린다: 시도 수·다음 시각은 그대로 두고 잡음만 푼다
          else await this.d.store.saveDispatch(row);
          continue;
        }
        const out = await this.#send(row, appeal, nowMs);
        if (out.ok) {
          if (row.call === 'APPEAL_COPY') appeal = (await this.d.store.appealOf(caseId)) ?? appeal;
          await this.#applied(row, out.result, nowMs, tally);
        } else {
          if (row.call === 'APPEAL_COPY' && out.code === 'NOT_FOUND') {
            // 옮기기 전에 queue-svc 보관이 끝났다(화면 '내용 없음')
            await this.d.store.updateAppeal(caseId, { status: 'SKIPPED' }, nowMs);
            appeal = { ...appeal, status: 'SKIPPED' };
          }
          await this.#failed(row, out.code, out.counted, nowMs, tally);
        }
      } catch (err) {
        // 저장소 오류 등: 잡음은 30초 뒤 풀리고 다음 바퀴가 다시 한다
        this.d.log?.warn({ event: 'cs-case-dispatch-failed', caseId, call: row.call, err: err instanceof Error ? err.name : 'unknown' }, '보낼 호출 하나를 처리하지 못했다(다음 바퀴에 다시)');
      }
    }
    await this.#refreshStatus(caseId, nowMs);
  }

  /** 한 호출을 보낸다. 받는 쪽 실패는 gRPC 상태 이름으로 돌려준다 */
  async #send(row: CsCaseDispatchRow, a: VerificationCase, nowMs: number): Promise<Outcome> {
    const p = this.d.ports;
    const o = { deadlineMs: DISPATCH_CALL_DEADLINE_MS };
    try {
      switch (row.call) {
        case 'APPEAL_COPY': {
          if (!p.appeals) throw new CsDispatchCallError(NOT_CONFIGURED);
          const content = await p.appeals.get(a.appealId, o);
          await this.d.store.copyAppealContent(a.caseId, content, nowMs);
          return { ok: true, result: 'COPIED' };
        }
        case 'ACCOUNT_HOLD_OPEN':
        case 'ACCOUNT_HOLD_CLOSE': {
          if (!p.holds) throw new CsDispatchCallError(NOT_CONFIGURED);
          const r = await p.holds.set({ accountId: a.accountId ?? '', caseId: a.caseId, state: row.call === 'ACCOUNT_HOLD_OPEN' ? 'OPEN' : 'CLOSED', version: row.sourceVersion }, o);
          return { ok: true, result: r.changed ? 'CHANGED' : 'UNCHANGED' };
        }
        case 'QUEUE_RESOLVE': {
          if (!p.appeals) throw new CsDispatchCallError(NOT_CONFIGURED);
          if (a.appealResult === null) return { ok: false, code: 'FAILED_PRECONDITION', counted: false };
          const r = await p.appeals.resolve({ appealId: a.appealId, caseId: a.caseId, caseVersion: row.sourceVersion, outcome: a.appealResult }, o);
          return { ok: true, result: r };
        }
        case 'TRUST_LABEL': {
          if (!p.labels) throw new CsDispatchCallError(NOT_CONFIGURED);
          if (a.decidedBy === null || a.eventId === null || a.pid === null) return { ok: false, code: 'FAILED_PRECONDITION', counted: false };
          const r = await p.labels.apply({ caseId: a.caseId, version: row.sourceVersion, eventId: a.eventId, pid: a.pid, actedBy: a.decidedBy }, o);
          await this.d.store.updateAppeal(a.caseId, { blockListChange: r.blockList }, nowMs);
          return { ok: true, result: r.changed ? 'CHANGED' : 'UNCHANGED' };
        }
      }
    } catch (err) {
      return { ok: false, code: err instanceof CsDispatchCallError ? err.code : 'INTERNAL', counted: true };
    }
  }

  async #applied(row: CsCaseDispatchRow, result: string, nowMs: number, tally: DispatchTally): Promise<void> {
    await this.d.store.saveDispatch({ ...row, state: 'APPLIED', attempts: row.attempts + 1, nextAttemptAtMs: null, lastError: null, result, failedAlertedAtMs: null, updatedAtMs: nowMs });
    this.d.ports.signals?.dispatch(row.call, 'applied');
    tally.applied++;
    if (row.failedAlertedAtMs !== null) {
      try {
        await this.d.alerts.resolve({ eventKey: csCaseDispatchAlertKey(row.caseId, row.call), kind: CS_CASE_DISPATCH_FAILED_ALERT, reason: '보낼 호출이 반영됐습니다', resolvedAt: iso(nowMs) });
      } catch (err) {
        this.d.log?.warn({ event: 'cs-case-dispatch-alert-release-failed', caseId: row.caseId, call: row.call, err: err instanceof Error ? err.name : 'unknown' }, '반영 실패 경보를 풀지 못했다');
      }
    }
  }

  async #failed(row: CsCaseDispatchRow, code: string, counted: boolean, nowMs: number, tally: DispatchTally): Promise<void> {
    const attempts = row.attempts + (counted ? 1 : 0);
    const final = NO_RETRY_CODES.has(code) || code === APPEAL_CONTENT_MISSING || !counted;
    const state = final || attempts >= DISPATCH_FAIL_AFTER || row.state === 'FAILED' ? 'FAILED' : 'PENDING';
    const nextAttemptAtMs = final ? null : nowMs + retryWaitMs(attempts);
    const became = state === 'FAILED' && row.state !== 'FAILED';
    const alerting = state === 'FAILED' && row.failedAlertedAtMs === null;
    await this.d.store.saveDispatch({ ...row, state, attempts, nextAttemptAtMs, lastError: code, failedAlertedAtMs: alerting ? nowMs : row.failedAlertedAtMs, updatedAtMs: nowMs });
    this.d.ports.signals?.dispatch(row.call, became ? 'failed' : 'retry');
    if (became) tally.failed++;
    else tally.retried++;
    if (alerting) {
      try {
        await this.d.alerts.handle({
          eventKey: csCaseDispatchAlertKey(row.caseId, row.call),
          kind: CS_CASE_DISPATCH_FAILED_ALERT,
          severity: 'SEV3',
          source: 'ops-svc',
          reason: 'CS 처리함 건의 결과 반영 호출이 반영되지 않았습니다',
          // 건 ID·건 종류·호출·gRPC 상태 이름만 싣는다(pid·계정 ID 없음)
          detail: { caseId: row.caseId, caseKind: VERIFICATION_APPEAL_KIND, call: row.call, grpcStatus: code },
          createdAt: iso(nowMs),
        });
      } catch (err) {
        this.d.log?.warn({ event: 'cs-case-dispatch-alert-failed', caseId: row.caseId, call: row.call, err: err instanceof Error ? err.name : 'unknown' }, '반영 실패 경보를 열지 못했다');
      }
    }
  }

  /** 이의 행 상태를 보낼 호출로 다시 센다(결정 뒤 RUNNING·PASSED·FAILED) */
  async #refreshStatus(caseId: string, nowMs: number): Promise<void> {
    const a = await this.d.store.appealOf(caseId);
    if (!a) return;
    const status = appealStatusOf(a, await this.d.store.dispatchRowsOf(caseId));
    if (status !== a.status) await this.d.store.updateAppeal(caseId, { status }, nowMs);
  }
}
