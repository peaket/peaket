// F-04-12 조사 도메인 시험(동결 로컬, LCH-260, FX-T12·FX-T15·FX-T16·FX-T18).
// 정본: docs/features/forensic-replay.md §6.7.3~§6.7.5, docs/data.md fraud_*.
// 도메인 함수는 시계·난수를 직접 쓰지 않고 받은 nowMs만 쓴다. 단언 값은 정본의 [가정] 값이다.
import { describe, expect, test } from 'vitest';
import {
  APPEAL_MIN_LEAD_MS,
  AUTO_RETRY_LIMIT,
  CANCEL_DEADLINE_BEFORE_SHOW_MS,
  LOCK_MAX_MS,
  addMembers,
  assertAppealDue,
  assertInvestigator,
  autoRetriesLeftOf,
  cancelDeadlineAtMs,
  classifyRunFailure,
  decideAppeals,
  defaultAppealDueAt,
  lockExpiryOf,
  removeMembers,
  rerunDecision,
  verifySnapshotDecision,
  type FraudCaseRecord,
  type FraudClusterMemberRecord,
  type FraudRunRecord,
  type FraudSnapshotRecord,
} from '../src/modules/investigations/index.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-25T00:00:00.000Z');
const SHOW = Date.parse('2026-12-02T10:00:00.000Z');
const SALE_ENDS = SHOW - 24 * HOUR;
const ENTRY = SHOW;
const CANCEL = SHOW - 26 * HOUR;

const id = (n: number) => `0194b200-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const hex = (c: string) => c.repeat(64);

const problemOf = (fn: () => void): { type: string; status: number } | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e as { type: string; status: number };
  }
};

const memberOf = (n: number, o: Partial<FraudClusterMemberRecord> = {}): FraudClusterMemberRecord => ({
  accountId: id(n),
  ticketCount: 9,
  signals: ['LINK_GRAPH'],
  addedBy: 'SYSTEM',
  removedAtMs: null,
  appealResult: 'NOT_REQUESTED',
  appealDueAtMs: null,
  lockExpiresAtMs: null,
  ...o,
});

const caseOf = (o: Partial<FraudCaseRecord> = {}): FraudCaseRecord => ({
  caseId: id(0x100),
  eventId: id(0x200),
  clusterId: id(0x300),
  status: 'INVESTIGATING',
  reasonCategory: 'MACRO_BOT',
  assigneeId: id(0x400),
  cancelDeadlineAtMs: CANCEL,
  appealDueAtMs: null,
  approvalId: null,
  investigatorOpinion: null,
  outcomeLabel: null,
  version: 1,
  createdAtMs: NOW,
  closedAtMs: null,
  members: [memberOf(1), memberOf(2), memberOf(3)],
  events: [{ seq: 1, kind: 'CREATED', actorId: id(0x400), note: null, detail: null, occurredAtMs: NOW }],
  ...o,
});

const runOf = (o: Partial<FraudRunRecord> = {}): FraudRunRecord => ({
  eventId: id(0x200),
  generation: 1,
  attempt: 1,
  trigger: 'SCHEDULED',
  snapshotVersion: 1,
  ruleVersion: 'fraud-rules-v1',
  status: 'FAILED',
  failureReason: 'OTHER',
  resultFingerprint: null,
  clusterCount: null,
  startedAtMs: NOW - HOUR,
  finishedAtMs: NOW - HOUR + 1_000,
  ...o,
});

const snapshotOf = (o: Partial<FraudSnapshotRecord> = {}): FraudSnapshotRecord => ({
  eventId: id(0x200),
  version: 1,
  frozenAtMs: NOW - HOUR,
  invHash: hex('b'),
  prevHash: null,
  tableHashes: { inv_request: hex('1'), inv_step: hex('2'), inv_behavior: hex('3'), inv_link: hex('4') },
  rowCounts: { inv_request: 10, inv_step: 20, inv_behavior: 30, inv_link: 40 },
  rangeFromMs: null,
  late: false,
  verifyStatus: null,
  verifiedAtMs: null,
  ...o,
});

describe('F-04-12 조사 도메인', () => {
  test('FX-T18 ① 취소 마감은 공연 시작 26시간 전이다', () => {
    expect(CANCEL_DEADLINE_BEFORE_SHOW_MS).toBe(26 * HOUR);
    expect(cancelDeadlineAtMs(SHOW)).toBe(SHOW - 26 * HOUR);
    // 판매 종료(공연 시작 24시간 전)에서 재판매 준비 2시간을 뺀 시각과 같다
    expect(cancelDeadlineAtMs(SHOW)).toBe(SALE_ENDS - 2 * HOUR);
    expect(cancelDeadlineAtMs(SHOW + 1)).toBe(SALE_ENDS - 2 * HOUR + 1);
  });

  test('FX-T18 ② 소명 기한 기본값은 요청 + 24시간 아래로 내려가지 않고 취소 마감 − 6시간을 넘기지 않는다', () => {
    // 기본은 요청 + 3일이다
    expect(defaultAppealDueAt({ nowMs: NOW, showStartsAtMs: SHOW })).toBe(NOW + 3 * DAY);
    // 취소 마감 − 6시간이 그보다 이르면 그 값을 쓴다
    const nearShow = NOW + 56 * HOUR; // 취소 마감 = now + 30시간
    expect(defaultAppealDueAt({ nowMs: NOW, showStartsAtMs: nearShow })).toBe(NOW + APPEAL_MIN_LEAD_MS);
    // 24시간과 같으면 허용, 1ms 이르면 24시간으로 올린다
    const exactly = NOW + 56 * HOUR - 1; // 취소 마감 − 6시간 = now + 24시간 − 1ms
    expect(defaultAppealDueAt({ nowMs: NOW, showStartsAtMs: exactly })).toBe(NOW + APPEAL_MIN_LEAD_MS);
    // 음수 쪽으로도 24시간 아래로 내려가지 않는다
    expect(defaultAppealDueAt({ nowMs: NOW, showStartsAtMs: NOW + 2 * HOUR })).toBe(NOW + APPEAL_MIN_LEAD_MS);
  });

  test('FX-T12 ① 소명 기한이 24시간 미만이거나 입장 시작 뒤면 소명 요청을 거절한다', () => {
    const base = { nowMs: NOW, showStartsAtMs: SHOW, entryOpensAtMs: ENTRY };
    expect(problemOf(() => assertAppealDue({ ...base, dueAtMs: NOW + APPEAL_MIN_LEAD_MS }))).toBeNull();
    expect(problemOf(() => assertAppealDue({ ...base, dueAtMs: NOW + APPEAL_MIN_LEAD_MS - 1 }))).toMatchObject({ status: 422 });
    // 입장 시작과 같은 기한은 거절, 1ms 이르면 통과
    expect(problemOf(() => assertAppealDue({ ...base, dueAtMs: ENTRY }))).toMatchObject({ status: 422 });
    expect(problemOf(() => assertAppealDue({ ...base, dueAtMs: ENTRY - 1 }))).toBeNull();
    // 이미 입장이 시작됐으면 409
    expect(problemOf(() => assertAppealDue({ ...base, nowMs: ENTRY, dueAtMs: ENTRY + DAY }))).toMatchObject({ type: 'entry-started', status: 409 });
    // 입장 시작 칸이 없으면 공연 시작을 쓴다
    expect(problemOf(() => assertAppealDue({ nowMs: NOW, showStartsAtMs: SHOW, entryOpensAtMs: null, dueAtMs: SHOW }))).toMatchObject({ status: 422 });
  });

  test('FX-T15 ① 잠금 최대 기한은 계정의 첫 소명 요청 + 14일이고 다시 요청해도 늘지 않는다', () => {
    expect(LOCK_MAX_MS).toBe(14 * DAY);
    expect(lockExpiryOf({ existingLockExpiresAtMs: null, nowMs: NOW })).toBe(NOW + 14 * DAY);
    // 이미 잠근 계정은 기존 기한을 그대로 쓴다
    expect(lockExpiryOf({ existingLockExpiresAtMs: NOW + 10 * DAY, nowMs: NOW + 5 * DAY })).toBe(NOW + 10 * DAY);
    expect(lockExpiryOf({ existingLockExpiresAtMs: null, nowMs: NOW + 5 * DAY })).toBe(NOW + 19 * DAY);
  });

  test('FX-T12 ② 실패한 후보 계산은 세 번까지 자동으로 다시 하고 그 뒤에만 다시 돌리기를 연다', () => {
    expect(AUTO_RETRY_LIMIT).toBe(3);
    for (const [attempt, left] of [[1, 3], [2, 2], [3, 1], [4, 0]] as const) {
      expect(autoRetriesLeftOf({ status: 'FAILED', attempt }), `FAILED ${attempt}`).toBe(left);
    }
    // 실행 중·성공에는 자동 재시도를 세지 않는다
    expect(autoRetriesLeftOf({ status: 'RUNNING', attempt: 1 })).toBe(0);
    expect(autoRetriesLeftOf({ status: 'DONE', attempt: 1 })).toBe(0);
  });

  test('FX-T12 ③ 다시 돌리기는 실행 중·자동 재시도 남음·성공 상태에서 409이고 원천이 만료되면 410이다', () => {
    const sourceExpiresAtMs = SHOW + 30 * DAY;
    expect(rerunDecision({ last: null, nowMs: NOW, sourceExpiresAtMs })).toEqual({ allowed: false, status: 409, type: 'fraud-run-not-failed' });
    expect(rerunDecision({ last: runOf({ status: 'RUNNING', finishedAtMs: null }), nowMs: NOW, sourceExpiresAtMs })).toEqual({
      allowed: false,
      status: 409,
      type: 'fraud-run-in-progress',
    });
    expect(rerunDecision({ last: runOf({ status: 'DONE' }), nowMs: NOW, sourceExpiresAtMs })).toEqual({ allowed: false, status: 409, type: 'fraud-run-not-failed' });
    expect(rerunDecision({ last: runOf({ attempt: 1 }), nowMs: NOW, sourceExpiresAtMs })).toEqual({ allowed: false, status: 409, type: 'fraud-run-retrying' });
    expect(rerunDecision({ last: runOf({ attempt: 4 }), nowMs: NOW, sourceExpiresAtMs })).toEqual({ allowed: true, generation: 1, attempt: 5 });
    // 원천 보존 끝과 같으면 만료다
    expect(rerunDecision({ last: runOf({ attempt: 4 }), nowMs: sourceExpiresAtMs, sourceExpiresAtMs })).toEqual({
      allowed: false,
      status: 410,
      type: 'investigation-source-expired',
    });
  });

  test('FX-T12 ④ 계정 빼기는 조사 중·소명 대기에서만 되고 뺀 계정의 잠금을 바로 푼다', () => {
    const c = caseOf();
    const out = removeMembers({ case: c, removals: [{ accountId: id(1), reason: '가족 대리 예매로 확인' }], nowMs: NOW + HOUR });
    expect(out.next.members[0]!.removedAtMs).toBe(NOW + HOUR);
    expect(out.next.status).toBe('INVESTIGATING');
    expect(out.next.version).toBe(2);
    expect(out.lockReleases).toEqual([id(1)]);
    expect(out.events.map((e: { kind: string }) => e.kind)).toContain('MEMBER_REMOVED');

    // 다른 상태에서는 409
    expect(problemOf(() => removeMembers({ case: caseOf({ status: 'DECISION_PENDING' }), removals: [{ accountId: id(1), reason: 'x' }], nowMs: NOW }))).toEqual({
      type: 'fraud-case-state',
      status: 409,
    });
    // 활성 계정을 모두 빼면 정상 종료다
    const all = removeMembers({
      case: caseOf(),
      removals: [1, 2, 3].map((n) => ({ accountId: id(n), reason: '근거 없음' })),
      nowMs: NOW + HOUR,
    });
    expect(all.next.status).toBe('CLEARED');
    expect(all.next.outcomeLabel).toBe('HUMAN');
    expect(all.next.closedAtMs).toBe(NOW + HOUR);
    expect(all.lockReleases).toEqual([id(1), id(2), id(3)]);

    // 없는 계정은 422
    expect(problemOf(() => removeMembers({ case: c, removals: [{ accountId: id(9), reason: 'x' }], nowMs: NOW }))).toMatchObject({ status: 422 });
  });

  test('FX-T12 ⑤ 계정 더하기는 조사 중·소명 대기에서만 되고 더한 계정은 소명을 다시 받아야 한다', () => {
    const added = addMembers({ case: caseOf(), adds: [{ accountId: id(4), reason: '새로 이어진 계정' }], nowMs: NOW + HOUR });
    const m = added.next.members.find((x: { accountId: string }) => x.accountId === id(4))!;
    expect(m.addedBy).toBe('INVESTIGATOR');
    expect(m.appealResult).toBe('NOT_REQUESTED');
    expect(m.lockExpiresAtMs).toBeNull();
    expect(added.events.map((e: { kind: string }) => e.kind)).toEqual(['MEMBER_ADDED']);

    // 소명 대기에서도 된다
    expect(addMembers({ case: caseOf({ status: 'APPEAL_PENDING' }), adds: [{ accountId: id(4), reason: 'x' }], nowMs: NOW }).next.members).toHaveLength(4);
    // 그 밖의 상태는 409
    expect(problemOf(() => addMembers({ case: caseOf({ status: 'ACTIONED' }), adds: [{ accountId: id(4), reason: 'x' }], nowMs: NOW }))).toEqual({
      type: 'fraud-case-state',
      status: 409,
    });
    // 이미 활성인 계정은 422
    expect(problemOf(() => addMembers({ case: caseOf(), adds: [{ accountId: id(1), reason: 'x' }], nowMs: NOW }))).toMatchObject({ status: 422 });
  });

  test('FX-T12 ⑥ 소명 판단으로 모든 계정이 인정되면 정상 종료하고 잠금을 모두 푼다', () => {
    const c = caseOf({
      status: 'APPEAL_PENDING',
      members: [1, 2, 3].map((n) => memberOf(n, { appealResult: 'SUBMITTED', appealDueAtMs: NOW + DAY, lockExpiresAtMs: NOW + 14 * DAY })),
    });
    const out = decideAppeals({
      case: c,
      decisions: [1, 2, 3].map((n) => ({ accountId: id(n), decision: 'ACCEPTED' as const, reason: '정상 구매' })),
      nowMs: NOW + HOUR,
    });
    expect(out.next.status).toBe('CLEARED');
    expect(out.next.closedAtMs).toBe(NOW + HOUR);
    expect(out.next.outcomeLabel).toBe('HUMAN');
    expect(out.next.members.every((m: { appealResult: string }) => m.appealResult === 'ACCEPTED')).toBe(true);
    expect(out.lockReleases.sort()).toEqual([id(1), id(2), id(3)].sort());
    expect(out.events.filter((e: { kind: string }) => e.kind === 'APPEAL_DECIDED')).toHaveLength(3);
  });

  test('FX-T12 ⑦ 소명 판단이 일부만 인정되면 소명 대기로 남고 인정된 계정의 잠금만 푼다', () => {
    const c = caseOf({
      status: 'APPEAL_PENDING',
      members: [
        memberOf(1, { appealResult: 'SUBMITTED', lockExpiresAtMs: NOW + 14 * DAY }),
        memberOf(2, { appealResult: 'SUBMITTED', lockExpiresAtMs: NOW + 14 * DAY }),
        memberOf(3, { appealResult: 'PENDING' }),
      ],
    });
    const out = decideAppeals({
      case: c,
      decisions: [
        { accountId: id(1), decision: 'ACCEPTED', reason: '정상' },
        { accountId: id(2), decision: 'REJECTED', reason: '같은 기기로 27장' },
      ],
      nowMs: NOW + HOUR,
    });
    expect(out.next.status).toBe('APPEAL_PENDING');
    expect(out.next.closedAtMs).toBeNull();
    expect(out.lockReleases).toEqual([id(1)]);
    expect(out.next.members.find((m: { accountId: string }) => m.accountId === id(1))!.appealResult).toBe('ACCEPTED');
    expect(out.next.members.find((m: { accountId: string }) => m.accountId === id(2))!.appealResult).toBe('REJECTED');
    expect(out.next.members.find((m: { accountId: string }) => m.accountId === id(3))!.appealResult).toBe('PENDING');
  });

  test('FX-T12 ⑧ 제출 전 계정의 소명 판단과 중복 판단은 422다', () => {
    const c = caseOf({ status: 'APPEAL_PENDING', members: [memberOf(1), memberOf(2, { appealResult: 'SUBMITTED' }), memberOf(3)] });
    expect(problemOf(() => decideAppeals({ case: c, decisions: [{ accountId: id(1), decision: 'ACCEPTED', reason: 'x' }], nowMs: NOW }))).toMatchObject({ status: 422 });
    const c2 = caseOf({ status: 'APPEAL_PENDING', members: [memberOf(1, { appealResult: 'SUBMITTED' }), memberOf(2), memberOf(3)] });
    expect(
      problemOf(() =>
        decideAppeals({
          case: c2,
          decisions: [
            { accountId: id(1), decision: 'ACCEPTED', reason: 'x' },
            { accountId: id(1), decision: 'REJECTED', reason: 'y' },
          ],
          nowMs: NOW,
        }),
      ),
    ).toMatchObject({ status: 422 });
  });

  test('FX-T12 ⑨ 기록 검증이 어긋나면 SEV2와 내보내기 차단을 낸다', () => {
    const stored = snapshotOf();
    expect(verifySnapshotDecision({ stored, recomputed: stored })).toEqual({ ok: true, severity: null, exportBlocked: false, mismatchedTables: [] });
    const tableDiff = snapshotOf({ tableHashes: { ...stored.tableHashes, inv_step: hex('9') } });
    expect(verifySnapshotDecision({ stored, recomputed: tableDiff })).toEqual({
      ok: false,
      severity: 'SEV2',
      exportBlocked: true,
      mismatchedTables: ['inv_step'],
    });
    const hashDiff = snapshotOf({ invHash: hex('a') });
    expect(verifySnapshotDecision({ stored, recomputed: hashDiff })).toEqual({ ok: false, severity: 'SEV2', exportBlocked: true, mismatchedTables: [] });
  });

  test('FX-T12 ⑩ 후보 계산 실패는 사유 범주만 남기고 원문 오류를 싣지 않는다', () => {
    expect(classifyRunFailure(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }))).toBe('TIMEOUT');
    expect(classifyRunFailure(Object.assign(new Error('boom'), { name: 'TimeoutError' }))).toBe('TIMEOUT');
    expect(classifyRunFailure(Object.assign(new Error('boom'), { code: 'SOURCE_READ_FAILED' }))).toBe('SOURCE_READ_FAILED');
    expect(classifyRunFailure(new Error('알 수 없는 오류'))).toBe('OTHER');
    expect(classifyRunFailure('문자열 오류')).toBe('OTHER');
  });

  test('FX-T16 ① 조사관 지정이 없거나 가명정보 취급자 지정을 함께 가진 계정은 조사 경로를 쓸 수 없다', () => {
    expect(problemOf(() => assertInvestigator(['FRAUD_INVESTIGATOR']))).toBeNull();
    expect(problemOf(() => assertInvestigator([]))).toEqual({ type: 'investigator-required', status: 403 });
    expect(problemOf(() => assertInvestigator(['PSEUDONYM_HANDLER']))).toEqual({ type: 'investigator-required', status: 403 });
    expect(problemOf(() => assertInvestigator(['FRAUD_INVESTIGATOR', 'PSEUDONYM_HANDLER']))).toEqual({ type: 'investigator-required', status: 403 });
  });
});
