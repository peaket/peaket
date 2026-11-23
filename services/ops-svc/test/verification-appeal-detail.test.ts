// 추가 검증 이의 건 상세(F-06-7 GAT-280, B-T28 ①). 시험 담당 lane3-f067-test.
// 실제 ops-svc 조립(메모리)의 GET /v1/ops/cases/{caseId}가 queue-svc GetVerificationAppeal·trust-svc GetVerdictEvidence를 실제 gRPC 클라이언트로 읽어
// verificationAppeal 칸을 채우는지 본다. 받는 쪽은 정본 설명자로 띄운 gRPC 서버 대역이다(cs-appeal-support.ts).
// 정본: docs/features/bot-defense.md §12 '판정에 쓰는 자료'·'CS 처리 첫 구현'의 '상세'(호출마다 1초 [가정] 데드라인, 읽지 못해도 200이고 그 칸만 비운다),
// openapi CsCaseDetail.verificationAppeal(칸 목록과 가린 칸: pid·계정 ID·기기 가명·점수 원값·가중치·기준값·프로필 판), d5 §7.6 '추가 검증 이의 상세'.
import * as grpc from '@grpc/grpc-js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EVIDENCE, appealFixture, appealHarness, evidenceAnswer, type AppealHarness } from './cs-appeal-support.js';
import { caseRequest } from './cs-support.js';

let h: AppealHarness;
beforeEach(async () => {
  h = await appealHarness();
});
afterEach(async () => {
  await h.close();
});

/** openapi CsCaseDetail.verificationAppeal의 칸(이 밖의 칸이 응답에 없다) */
const APPEAL_FIELDS = ['appealId', 'content', 'decision', 'dispatch', 'entryState', 'evidence', 'reasonCategory', 'receivedAt', 'reflectState', 'request', 'text'];
const EVIDENCE_FIELDS = ['decidedAt', 'deviceChallenges', 'hardSignal', 'source', 'state'];
const CS_CASE_FIELDS = new Set(['caseId', 'kind', 'targetRef', 'progressDueAt', 'resultDueAt', 'status', 'category', 'assignee', 'version', 'dueState', 'createdAt', 'resolvedAt', 'resultNote', 'verificationAppeal']);
const FOUND = {
  state: 'FOUND',
  hardSignal: 'BLOCK_LIST',
  source: 'REALTIME',
  decidedAt: EVIDENCE.decidedAtIso,
  deviceChallenges: { sent: EVIDENCE.sent, passed: EVIDENCE.passed, failed: EVIDENCE.failed },
};
const EMPTY_EVIDENCE = (state: string) => ({ state, hardSignal: null, source: null, decidedAt: null, deviceChallenges: null });

describe('B-T28 ① 이의 건 상세의 보이는 칸', () => {
  test('B-T28 ① cs_agent·cs_lead 상세에 이의 글·요청 종류·사유 범주·확정 신호·판정 출처·판정 시각·30일 보냄·통과·실패·대기 참여 상태가 대역 답 그대로다', async () => {
    const { caseId, fx } = await h.openAppeal();
    await h.runDispatch();
    for (const role of ['cs_agent', 'cs_lead'] as const) {
      const va = await h.appealOf(caseId, role);
      expect(Object.keys(va).sort(), role).toEqual(APPEAL_FIELDS);
      expect(va, role).toMatchObject({
        appealId: fx.appealId,
        content: 'AVAILABLE',
        text: fx.text,
        request: 'REVIEW',
        reasonCategory: 'DEVICE_HISTORY',
        receivedAt: fx.receivedAtIso,
        entryState: 'VERIFYING',
        evidence: FOUND,
        decision: null,
      });
      expect(Object.keys(va.evidence as object).sort(), role).toEqual(EVIDENCE_FIELDS);
    }
    // 판정 근거는 옮긴 회차·pid로 읽는다
    expect(h.stubs.trust.of('GetVerdictEvidence').at(-1)).toMatchObject({ event_id: fx.eventId, pid: fx.pid });
    // 연 뒤 한 바퀴: 내용 옮기기와 병합 막기가 반영되어 요약이 APPLIED다
    const va = await h.appealOf(caseId);
    expect((va.dispatch as Array<Record<string, unknown>>).map((d) => [d.call, d.state, d.attempts, d.lastError])).toEqual([
      ['APPEAL_COPY', 'APPLIED', 1, null],
      ['ACCOUNT_HOLD_OPEN', 'APPLIED', 1, null],
    ]);
    expect(va.reflectState).toBe('APPLIED');
  });

  test('B-T28 ① 다른 종류의 건(분쟁) 상세에는 verificationAppeal 칸이 없고 queue·trust를 부르지 않는다', async () => {
    const r = await h.intake(caseRequest('DISPUTE', { category: 'INQUIRY_DISPUTE' }));
    const d = await h.get(h.as('cs_agent'), r.body.caseId!);
    expect(d.status).toBe(200);
    expect('verificationAppeal' in d.body).toBe(false);
    expect([h.stubs.queue.calls.length, h.stubs.trust.calls.length]).toEqual([0, 0]);
  });
});

describe('B-T28 ① 가린 칸', () => {
  test('B-T28 ① 응답 전체에 대역이 준 pid·계정 ID·프로필 판·기기 가명 꼴·점수 칸이 0건이고 건 칸은 CsCase와 verificationAppeal뿐이다', async () => {
    const { caseId, fx } = await h.openAppeal();
    await h.runDispatch();
    for (const role of ['cs_agent', 'cs_lead', 'operator', 'commander'] as const) {
      const d = await h.get(h.as(role), caseId);
      const raw = JSON.stringify(d.body);
      expect(raw, role).not.toContain(fx.pid);
      expect(raw, role).not.toContain(fx.accountId);
      expect(raw, role).not.toContain(String(EVIDENCE.profileVersion));
      expect(raw, role).not.toMatch(/"(pid|accountId|profileVersion|deviceRef|score|weight|threshold)"/i);
      // 기기 가명 꼴(k + 판 번호 + . + 43자, bot-defense §9)
      expect(raw, role).not.toMatch(/k\d+\.[A-Za-z0-9_-]{43}/);
      expect(Object.keys(d.body).filter((k) => !CS_CASE_FIELDS.has(k)), role).toEqual([]);
    }
  });
});

describe('B-T28 ① 근거가 없거나 읽지 못할 때', () => {
  test('B-T28 ① 판정 근거 키가 없으면(found false) evidence는 NOT_FOUND이고 나머지는 null, 사유 범주는 보인다', async () => {
    const fx = appealFixture({ reasonCategory: 'REASON_CATEGORY_NETWORK' });
    h.stubs.evidence.set(fx.pid, { found: false });
    const { caseId } = await h.openAppeal(fx);
    await h.runDispatch();
    const va = await h.appealOf(caseId);
    expect(va.evidence).toEqual(EMPTY_EVIDENCE('NOT_FOUND'));
    expect([va.reasonCategory, va.content, va.text]).toEqual(['NETWORK', 'AVAILABLE', fx.text]);
  });

  test('B-T28 ① trust-svc가 UNAVAILABLE이면 상세는 200이고 evidence만 UNAVAILABLE이다', async () => {
    const { caseId, fx } = await h.openAppeal();
    await h.runDispatch();
    h.stubs.trust.fail(grpc.status.UNAVAILABLE, 'GetVerdictEvidence');
    const va = await h.appealOf(caseId);
    expect(va.evidence).toEqual(EMPTY_EVIDENCE('UNAVAILABLE'));
    expect([va.content, va.text, va.entryState]).toEqual(['AVAILABLE', fx.text, 'VERIFYING']);
  });

  // 시험 리뷰 1 TR-10 반영: 경계를 0.8초·1.3초로 좁히고 queue 쪽 1초도 본다
  test('B-T28 ① 상세 읽기 데드라인(정본 호출마다 1초 [가정]): trust·queue 모두 0.8초 늦은 답은 받고 1.3초 늦은 답은 끊어 200·그 칸만 비운다', async () => {
    const { caseId, fx } = await h.openAppeal();
    await h.runDispatch();
    // real-time: gRPC 데드라인은 실제 시계로 잰다(가짜 시계로 옮길 수 없다). 경계 양쪽에 0.2·0.3초 여유를 둔다 F-06-7
    const late = <T,>(ms: number, v: T) => () => new Promise<T>((r) => setTimeout(() => r(v), ms));
    h.stubs.trust.set('GetVerdictEvidence', late(800, { value: evidenceAnswer() }));
    expect((await h.appealOf(caseId)).evidence).toEqual(FOUND);
    h.stubs.trust.set('GetVerdictEvidence', late(1_300, { value: evidenceAnswer() }));
    const started = performance.now();
    expect((await h.appealOf(caseId)).evidence).toEqual(EMPTY_EVIDENCE('UNAVAILABLE'));
    expect(performance.now() - started).toBeLessThan(1_250);
    h.stubs.trust.restore();
    const appealAnswer = { value: { appeal_id: fx.appealId, event_id: fx.eventId, account_id: fx.accountId, pid: fx.pid, text: fx.text, reason_category: fx.reasonCategory, received_at: { seconds: Math.floor(Date.parse(fx.receivedAtIso) / 1000), nanos: 0 }, entry_state: 'APPEAL_ENTRY_STATE_PASSED' } };
    h.stubs.queue.set('GetVerificationAppeal', late(800, appealAnswer));
    expect((await h.appealOf(caseId)).entryState).toBe('PASSED');
    h.stubs.queue.set('GetVerificationAppeal', late(1_300, appealAnswer));
    const q0 = performance.now();
    const va = await h.appealOf(caseId);
    expect([va.entryState, va.content, va.evidence]).toEqual([null, 'AVAILABLE', FOUND]);
    expect(performance.now() - q0).toBeLessThan(1_250);
  });

  test('B-T28 ① 내용을 옮긴 뒤 queue-svc가 멈추면 상세는 200이고 entryState만 null이다(글·근거는 보인다)', async () => {
    const { caseId, fx } = await h.openAppeal();
    await h.runDispatch();
    h.stubs.queue.fail(grpc.status.UNAVAILABLE);
    const va = await h.appealOf(caseId);
    expect([va.entryState, va.content, va.text, va.evidence]).toEqual([null, 'AVAILABLE', fx.text, FOUND]);
  });

  test('B-T28 ① 내용을 아직 옮기지 못했으면 PENDING이고 글·요청·접수 시각은 null, 사유 범주는 건의 category에서 읽고 근거는 UNAVAILABLE이다', async () => {
    const fx = appealFixture({ reasonCategory: 'REASON_CATEGORY_NETWORK' });
    h.stubs.queue.fail(grpc.status.UNAVAILABLE);
    const { caseId } = await h.openAppeal(fx);
    await h.runDispatch();
    const va = await h.appealOf(caseId);
    expect(va).toMatchObject({ appealId: fx.appealId, content: 'PENDING', text: null, request: null, receivedAt: null, reasonCategory: 'NETWORK', entryState: null, evidence: EMPTY_EVIDENCE('UNAVAILABLE') });
    expect(h.stubs.trust.count('GetVerdictEvidence')).toBe(0);
    // queue가 돌아오면 상세를 여는 때 내용을 옮긴다(배경 작업을 기다리지 않는다)
    h.stubs.queue.restore();
    expect(await h.appealOf(caseId)).toMatchObject({ content: 'AVAILABLE', text: fx.text, request: 'REVIEW', entryState: 'VERIFYING', evidence: FOUND });
  });

  test('B-T28 ① 옮기기 전에 보관이 끝났으면(GetVerificationAppeal NOT_FOUND) GONE이고 사유 범주는 건의 category, 모르는 category면 null이다', async () => {
    const gone = await h.openAppeal(appealFixture({ reasonCategory: 'REASON_CATEGORY_HUMAN_CHECK' }), { content: false });
    const odd = await h.openAppeal(appealFixture(), { content: false, category: 'REASON_CATEGORY_SOMETHING_NEW' });
    await h.runDispatch();
    expect(await h.appealOf(gone.caseId)).toMatchObject({ content: 'GONE', text: null, request: null, receivedAt: null, reasonCategory: 'HUMAN_CHECK', entryState: null, evidence: EMPTY_EVIDENCE('UNAVAILABLE') });
    expect((await h.appealOf(odd.caseId)).reasonCategory).toBeNull();
  });

  test('B-T28 ① 빈 글은 설명 요구(EXPLANATION, 글 빈 글), 글이 있으면 재검토(REVIEW)다', async () => {
    const empty = await h.openAppeal(appealFixture({ text: '' }));
    const review = await h.openAppeal(appealFixture({ text: '한 글자' }));
    await h.runDispatch();
    expect(await h.appealOf(empty.caseId)).toMatchObject({ content: 'AVAILABLE', text: '', request: 'EXPLANATION' });
    expect(await h.appealOf(review.caseId)).toMatchObject({ content: 'AVAILABLE', text: '한 글자', request: 'REVIEW' });
  });

  test('B-T28 ① 대기 참여 상태 셋(VERIFYING·PASSED·ENDED)을 그대로 옮긴다', async () => {
    const fx = appealFixture();
    const { caseId } = await h.openAppeal(fx);
    await h.runDispatch();
    for (const [proto, view] of [
      ['APPEAL_ENTRY_STATE_PASSED', 'PASSED'],
      ['APPEAL_ENTRY_STATE_ENDED', 'ENDED'],
      ['APPEAL_ENTRY_STATE_VERIFYING', 'VERIFYING'],
    ] as const) {
      fx.entryState = proto;
      expect((await h.appealOf(caseId)).entryState, proto).toBe(view);
    }
  });

  test('B-T28 ① operator·commander도 상세를 보고(200) viewer는 403이다', async () => {
    const { caseId } = await h.openAppeal();
    await h.runDispatch();
    for (const role of ['operator', 'commander'] as const) expect((await h.appealOf(caseId, role)).content, role).toBe('AVAILABLE');
    expect((await h.get(h.as('viewer'), caseId)).status).toBe(403);
  });
});

// 시험 리뷰 1 TR-06 반영(시험 담당 lane3-f067-test): 확정 신호 셋·판정 출처 둘·사유 범주 여섯을 값마다 대역 답 → 상세 값으로 본다.
// 정본: openapi CsCaseDetail.verificationAppeal.evidence.hardSignal(NONE·BLOCK_LIST·HONEYPOT)·source(REALTIME·REASSESS)·reasonCategory(여섯), trust.proto HardSignal·EvidenceSource·ReasonCategory.
describe('B-T28 ① 근거·사유 범주 값마다', () => {
  test('B-T28 ① 확정 신호 셋과 판정 출처 둘을 각각 그 값으로 옮긴다', async () => {
    for (const [hard, view] of [
      ['HARD_SIGNAL_NONE', 'NONE'],
      ['HARD_SIGNAL_BLOCK_LIST', 'BLOCK_LIST'],
      ['HARD_SIGNAL_HONEYPOT', 'HONEYPOT'],
    ] as const) {
      for (const [src, srcView] of [
        ['EVIDENCE_SOURCE_REALTIME', 'REALTIME'],
        ['EVIDENCE_SOURCE_REASSESS', 'REASSESS'],
      ] as const) {
        const fx = appealFixture();
        h.stubs.evidence.set(fx.pid, evidenceAnswer({ hardSignal: hard, source: src }));
        const { caseId } = await h.openAppeal(fx);
        await h.runDispatch();
        const e = (await h.appealOf(caseId)).evidence as Record<string, unknown>;
        expect([hard, src, e.state, e.hardSignal, e.source]).toEqual([hard, src, 'FOUND', view, srcView]);
      }
    }
  });

  test('B-T28 ① 사유 범주 여섯을 내용(queue)과 건 category(내용 없음) 두 길 모두 각각 그 값으로 옮긴다', async () => {
    for (const reason of ['RAPID_REQUESTS', 'DEVICE_HISTORY', 'NETWORK', 'INTERACTION', 'HUMAN_CHECK', 'SHARED_PATTERN']) {
      const withContent = await h.openAppeal(appealFixture({ reasonCategory: `REASON_CATEGORY_${reason}` }));
      const gone = await h.openAppeal(appealFixture({ reasonCategory: `REASON_CATEGORY_${reason}` }), { content: false });
      await h.runDispatch();
      expect([reason, (await h.appealOf(withContent.caseId)).reasonCategory, (await h.appealOf(gone.caseId)).reasonCategory]).toEqual([reason, reason, reason]);
    }
  });
});
