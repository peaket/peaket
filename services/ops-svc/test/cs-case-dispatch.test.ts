// 보낼 호출의 다시 보내기·반영 실패·경보(F-06-7 GAT-280, B-T28 ⑥, B-T10 ⑥ '결과 반영 호출이 실패하면 ops-svc 작업 워커가 다시 보낸다'). 시험 담당 lane3-f067-test.
// 실제 ops-svc 조립(메모리) + 실제 gRPC 클라이언트 → 받는 쪽 gRPC 서버 대역의 상태 주입. 시계는 가짜 시계(fakeClock)로 옮기고 배경 작업 한 바퀴를 직접 돈다.
// 실제 서버를 멈췄다 되살리는 끝에서 끝 시험과 실제 PostgreSQL의 잡음(SKIP LOCKED)은 test-int/verification-appeal.int.test.ts·cs-case-dispatch.int.test.ts다.
// 정본(값은 모두 여기서 가져온다): docs/features/bot-defense.md §12 'CS 처리 첫 구현'의 '다시 보내기'
//   - 다시 보내는 상태: UNAVAILABLE·DEADLINE_EXCEEDED·INTERNAL·UNAUTHENTICATED·RESOURCE_EXHAUSTED·연결 실패·주소 없음(NOT_CONFIGURED). 간격 10초에서 두 배씩 10분 [가정]까지
//   - 8번 [가정] 보내도 반영되지 않으면 FAILED와 SEV3 CS_CASE_DISPATCH_FAILED(건·호출마다 한 번), 그 뒤에도 10분 [가정]마다 다시 보낸다
//   - 다시 보내지 않는 상태: INVALID_ARGUMENT·ALREADY_EXISTS·NOT_FOUND·FAILED_PRECONDITION·PERMISSION_DENIED(바로 FAILED와 경보)
//   - 답이 오면(APPLIED·UNCHANGED·NOT_ISOLATED, changed 참·거짓 모두) APPLIED이고 열린 경보를 푼다. 라벨·병합 막기는 내용(APPEAL_COPY)을 옮긴 뒤에만, 내용이 없으면 APPEAL_CONTENT_MISSING
// §15 '이의 결과가 한 번씩 반영된다' 행(ops_cs_case_dispatch_total{call,result} applied·retry·failed), openapi CsCaseDetail.verificationAppeal.dispatch·reflectState.
import * as grpc from '@grpc/grpc-js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { NOTE, RETRY, appealFixture, appealHarness, closedAddress, untilAttempted, waitAfterFailure, type AppealHarness, type StubService } from './cs-appeal-support.js';

let h: AppealHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const ACCEPT = { outcome: 'ACCEPTED', resultNote: NOTE } as const;

async function decidedWithDown(stub: (h: AppealHarness) => StubService, method: string, code = grpc.status.UNAVAILABLE) {
  h = await appealHarness();
  const opened = await h.openAppeal();
  await h.runDispatch();
  stub(h).fail(code, method);
  const r = await h.decide(h.as('cs_agent'), opened.caseId, ACCEPT, { ifMatch: '"1"' });
  expect(r.status).toBe(202);
  return { h, ...opened, decision: r };
}

describe('B-T28 ⑥ B-T10 ⑥ 받는 서비스 하나씩 멈춘 채 결정', () => {
  const targets = [
    ['queue-svc', 'QUEUE_RESOLVE', (x: AppealHarness) => x.stubs.queue, 'ResolveVerificationAppeal'],
    ['trust-svc', 'TRUST_LABEL', (x: AppealHarness) => x.stubs.trust, 'ApplyLabel'],
    ['identity-svc', 'ACCOUNT_HOLD_CLOSE', (x: AppealHarness) => x.stubs.identity, 'SetAccountHold'],
  ] as const;
  for (const [svc, call, stub, method] of targets) {
    test(`B-T28 ⑥ B-T10 ⑥ ${svc}가 멈춘 채 결정해도 202·결정 저장이고, 되살린 뒤 배경 작업이 같은 건 ID·판으로 한 번 더 보내 반영하며 그 뒤에는 보내지 않는다`, async () => {
      const { h, caseId } = await decidedWithDown(stub, method);
      await untilAttempted(h, caseId, [call]);
      const pending = await h.appealOf(caseId);
      expect((await h.get(h.as('cs_agent'), caseId)).body).toMatchObject({ status: 'RESOLVED', version: 2, resultNote: NOTE });
      expect(pending.decision).toMatchObject({ outcome: 'ACCEPTED' });
      expect(pending.reflectState).toBe('PENDING');
      expect(await h.dispatchOf(caseId, call)).toMatchObject({ state: 'PENDING', attempts: 1, lastError: 'UNAVAILABLE' });
      const before = stub(h).count(method);
      stub(h).restore();
      await h.advanceAndRun(RETRY.firstMs);
      const sent = stub(h).of(method).slice(before);
      expect(sent).toHaveLength(1);
      if (method === 'ResolveVerificationAppeal') expect([sent[0]!.case_id, sent[0]!.case_version]).toEqual([caseId, 2]);
      if (method === 'ApplyLabel') expect([sent[0]!.source_ref, sent[0]!.source_version]).toEqual([caseId, 2]);
      if (method === 'SetAccountHold') expect([sent[0]!.source_ref, sent[0]!.source_version, sent[0]!.state]).toEqual([caseId, 2, 'ACCOUNT_HOLD_STATE_CLOSED']);
      expect(await h.dispatchOf(caseId, call)).toMatchObject({ state: 'APPLIED', attempts: 2, lastError: null });
      expect((await h.appealOf(caseId)).reflectState).toBe('APPLIED');
      await h.advanceAndRun(3_600_000);
      await h.advanceAndRun(3_600_000);
      expect(stub(h).of(method).slice(before)).toHaveLength(1);
      expect(h.dispatchAlerts(caseId)).toEqual([]);
    });
  }
});

describe('B-T28 ⑥ 간격 경계·8번 뒤 반영 실패·경보', () => {
  test('B-T28 ⑥ 간격 10초에서 두 배씩 10분까지: 기다릴 시각 − 1ms엔 보내지 않고 그 시각엔 보내며, 7번째 실패까지 경보 0, 8번째에 FAILED·SEV3 하나, 9번째에도 하나다', async () => {
    const { h, caseId } = await decidedWithDown((x) => x.stubs.queue, 'ResolveVerificationAppeal');
    await untilAttempted(h, caseId, ['QUEUE_RESOLVE']);
    const sends = () => h.stubs.queue.count('ResolveVerificationAppeal');
    expect(sends()).toBe(1);
    // 시험이 센 기다림: 10, 20, 40, 80, 160, 320, 600초(640초가 아니라 상한 10분)
    expect([1, 2, 3, 4, 5, 6, 7].map(waitAfterFailure)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000]);
    for (let n = 1; n < RETRY.failAfter; n++) {
      const wait = waitAfterFailure(n);
      await h.advanceAndRun(wait - 1);
      expect([n, 'before', sends()]).toEqual([n, 'before', n]);
      await h.advanceAndRun(1);
      expect([n, 'at', sends()]).toEqual([n, 'at', n + 1]);
      const row = await h.dispatchOf(caseId, 'QUEUE_RESOLVE');
      if (n + 1 < RETRY.failAfter) {
        expect([n + 1, row?.state, row?.attempts, h.dispatchAlerts(caseId).length]).toEqual([n + 1, 'PENDING', n + 1, 0]);
      }
    }
    // 8번째 실패
    expect(await h.dispatchOf(caseId, 'QUEUE_RESOLVE')).toMatchObject({ state: 'FAILED', attempts: 8, lastError: 'UNAVAILABLE' });
    expect((await h.appealOf(caseId)).reflectState).toBe('FAILED');
    const alerts = h.dispatchAlerts(caseId);
    expect(alerts.map((a) => [a.severity, a.open])).toEqual([['SEV3', true]]);
    expect(Object.values(alerts[0]!.detail)).toEqual(expect.arrayContaining([caseId, 'VERIFICATION_APPEAL', 'QUEUE_RESOLVE', 'UNAVAILABLE']));
    expect(await h.dispatchMetric('QUEUE_RESOLVE', 'retry')).toBe(7);
    expect(await h.dispatchMetric('QUEUE_RESOLVE', 'failed')).toBe(1);
    // 반영 실패 뒤에도 10분마다 다시 보낸다(− 1ms엔 보내지 않는다). 9번째 실패에도 경보는 하나다
    await h.advanceAndRun(RETRY.capMs - 1);
    expect(sends()).toBe(8);
    await h.advanceAndRun(1);
    expect(sends()).toBe(9);
    expect(h.dispatchAlerts(caseId).map((a) => [a.severity, a.open])).toEqual([['SEV3', true]]);
    expect(await h.dispatchOf(caseId, 'QUEUE_RESOLVE')).toMatchObject({ state: 'FAILED', attempts: 9 });
    // 시험 리뷰 1 TR-19 반영: 'failed'는 반영 실패로 바뀌는 때 한 번, 그 뒤 실패는 'retry'(bot-defense §12 '지표')
    expect([await h.dispatchMetric('QUEUE_RESOLVE', 'retry'), await h.dispatchMetric('QUEUE_RESOLVE', 'failed')]).toEqual([8, 1]);
  });

  test('B-T28 ⑥ 반영 실패 뒤 10분에 다시 보내 성공하면 APPLIED·경보 풀림·reflectState APPLIED이고 지표 applied가 오른다', async () => {
    const { h, caseId } = await decidedWithDown((x) => x.stubs.trust, 'ApplyLabel');
    await untilAttempted(h, caseId, ['TRUST_LABEL']);
    for (let n = 1; n < RETRY.failAfter; n++) await h.advanceAndRun(waitAfterFailure(n));
    expect(await h.dispatchOf(caseId, 'TRUST_LABEL')).toMatchObject({ state: 'FAILED', attempts: 8 });
    expect(h.dispatchAlerts(caseId).map((a) => a.open)).toEqual([true]);
    h.stubs.trust.restore();
    await h.advanceAndRun(RETRY.capMs);
    expect(await h.dispatchOf(caseId, 'TRUST_LABEL')).toMatchObject({ state: 'APPLIED', attempts: 9, lastError: null });
    const va = await h.appealOf(caseId);
    expect([va.reflectState, (va.decision as Record<string, unknown>).blockListChange]).toEqual(['APPLIED', 'REMOVED']);
    expect(h.dispatchAlerts(caseId).map((a) => a.open)).toEqual([false]);
    expect(await h.dispatchMetric('TRUST_LABEL', 'applied')).toBe(1);
    await h.advanceAndRun(3_600_000);
    expect(h.stubs.trust.count('ApplyLabel')).toBe(9);
  });

  test('B-T28 ⑥ 건·호출마다 경보가 따로다: 두 호출이 반영 실패면 그 건에 경보 둘이다', async () => {
    h = await appealHarness();
    const { caseId } = await h.openAppeal();
    await h.runDispatch();
    h.stubs.queue.fail(grpc.status.INVALID_ARGUMENT, 'ResolveVerificationAppeal');
    h.stubs.identity.fail(grpc.status.PERMISSION_DENIED, 'SetAccountHold');
    expect((await h.decide(h.as('cs_agent'), caseId, ACCEPT, { ifMatch: '"1"' })).status).toBe(202);
    await untilAttempted(h, caseId, ['QUEUE_RESOLVE', 'ACCOUNT_HOLD_CLOSE']);
    const calls = h.dispatchAlerts(caseId).map((a) => Object.values(a.detail).find((v) => v === 'QUEUE_RESOLVE' || v === 'ACCOUNT_HOLD_CLOSE'));
    expect(calls.sort()).toEqual(['ACCOUNT_HOLD_CLOSE', 'QUEUE_RESOLVE']);
  });
});

describe('B-T28 ⑥ 다시 보내지 않는 상태와 다시 보내는 상태(값마다)', () => {
  for (const [name, code] of [
    ['INVALID_ARGUMENT', grpc.status.INVALID_ARGUMENT],
    ['ALREADY_EXISTS', grpc.status.ALREADY_EXISTS],
    ['NOT_FOUND', grpc.status.NOT_FOUND],
    ['FAILED_PRECONDITION', grpc.status.FAILED_PRECONDITION],
    ['PERMISSION_DENIED', grpc.status.PERMISSION_DENIED],
  ] as const) {
    test(`B-T28 ⑥ ${name}는 바로 FAILED·경보 하나이고 그 뒤 다시 보내지 않는다`, async () => {
      const { h, caseId } = await decidedWithDown((x) => x.stubs.queue, 'ResolveVerificationAppeal', code);
      await untilAttempted(h, caseId, ['QUEUE_RESOLVE']);
      expect(await h.dispatchOf(caseId, 'QUEUE_RESOLVE')).toMatchObject({ state: 'FAILED', attempts: 1, lastError: name });
      expect(h.dispatchAlerts(caseId).map((a) => [a.severity, a.open])).toEqual([['SEV3', true]]);
      for (let i = 0; i < 3; i++) await h.advanceAndRun(3_600_000);
      expect(h.stubs.queue.count('ResolveVerificationAppeal')).toBe(1);
      expect((await h.appealOf(caseId)).reflectState).toBe('FAILED');
      expect(h.dispatchAlerts(caseId)).toHaveLength(1);
    });
  }

  for (const [name, code] of [
    ['UNAVAILABLE', grpc.status.UNAVAILABLE],
    ['DEADLINE_EXCEEDED', grpc.status.DEADLINE_EXCEEDED],
    ['INTERNAL', grpc.status.INTERNAL],
    ['UNAUTHENTICATED', grpc.status.UNAUTHENTICATED],
    ['RESOURCE_EXHAUSTED', grpc.status.RESOURCE_EXHAUSTED],
  ] as const) {
    test(`B-T28 ⑥ ${name}는 PENDING으로 남아 10초 뒤 다시 보내고 경보가 없다`, async () => {
      const { h, caseId } = await decidedWithDown((x) => x.stubs.identity, 'SetAccountHold', code);
      await untilAttempted(h, caseId, ['ACCOUNT_HOLD_CLOSE']);
      expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_CLOSE')).toMatchObject({ state: 'PENDING', attempts: 1, lastError: name });
      const before = h.stubs.identity.count('SetAccountHold');
      await h.advanceAndRun(RETRY.firstMs);
      expect(h.stubs.identity.count('SetAccountHold')).toBe(before + 1);
      expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_CLOSE')).toMatchObject({ state: 'PENDING', attempts: 2, lastError: name });
      expect(h.dispatchAlerts(caseId)).toEqual([]);
    });
  }

  test('B-T28 ⑥ 연결 실패(아무도 듣지 않는 주소)는 UNAVAILABLE로 PENDING이고 다시 보낸다', async () => {
    const dead = await closedAddress();
    h = await appealHarness({ env: { identity: dead } });
    const { caseId } = await h.openAppeal();
    await h.runDispatch();
    expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_OPEN')).toMatchObject({ state: 'PENDING', attempts: 1, lastError: 'UNAVAILABLE' });
    await h.advanceAndRun(RETRY.firstMs);
    expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_OPEN')).toMatchObject({ state: 'PENDING', attempts: 2 });
    expect(h.dispatchAlerts(caseId)).toEqual([]);
  });

  test('B-T28 ⑥ 주소 설정이 없으면(local·ci) NOT_CONFIGURED로 쌓아 두고 다시 보내며 경보는 8번 전에 없다', async () => {
    h = await appealHarness({ env: { identity: false } });
    const { caseId } = await h.openAppeal();
    await h.runDispatch();
    expect(await h.dispatchOf(caseId, 'APPEAL_COPY')).toMatchObject({ state: 'APPLIED' });
    expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_OPEN')).toMatchObject({ state: 'PENDING', attempts: 1, lastError: 'NOT_CONFIGURED' });
    await h.advanceAndRun(RETRY.firstMs);
    expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_OPEN')).toMatchObject({ state: 'PENDING', attempts: 2, lastError: 'NOT_CONFIGURED' });
    expect(h.dispatchAlerts(caseId)).toEqual([]);
    // 시험 리뷰 1 TR-13 반영: 7번째까지 경보 0, 8번째에 FAILED·경보 하나(다른 다시 보내는 상태와 같다)
    for (let n = 2; n < RETRY.failAfter; n++) {
      await h.advanceAndRun(waitAfterFailure(n));
      const row = await h.dispatchOf(caseId, 'ACCOUNT_HOLD_OPEN');
      if (n + 1 < RETRY.failAfter) expect([n + 1, row?.state, h.dispatchAlerts(caseId).length]).toEqual([n + 1, 'PENDING', 0]);
    }
    expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_OPEN')).toMatchObject({ state: 'FAILED', attempts: 8, lastError: 'NOT_CONFIGURED' });
    expect(h.dispatchAlerts(caseId).map((a) => [a.severity, a.open])).toEqual([['SEV3', true]]);
  });

  // 시험 리뷰 1 TR-11 반영: 라벨 호출의 다시 보내지 않는 실패도 바로 FAILED(queue만 보지 않는다)
  test('B-T28 ⑥ TRUST_LABEL이 FAILED_PRECONDITION이면 바로 FAILED·경보 하나이고 다시 보내지 않는다', async () => {
    const { h, caseId } = await decidedWithDown((x) => x.stubs.trust, 'ApplyLabel', grpc.status.FAILED_PRECONDITION);
    await untilAttempted(h, caseId, ['TRUST_LABEL']);
    expect(await h.dispatchOf(caseId, 'TRUST_LABEL')).toMatchObject({ state: 'FAILED', attempts: 1, lastError: 'FAILED_PRECONDITION' });
    for (let i = 0; i < 2; i++) await h.advanceAndRun(3_600_000);
    expect(h.stubs.trust.count('ApplyLabel')).toBe(1);
    expect(h.dispatchAlerts(caseId).map((a) => [a.severity, a.open])).toEqual([['SEV3', true]]);
  });
});

describe('B-T28 ⑥ 답이 오면 changed 참·거짓 모두 반영됨', () => {
  test('B-T28 ⑥ 처음 보낸 것이 받는 쪽에서 반영됐는데 답을 잃으면, 다시 보낸 같은 판의 UNCHANGED·changed false도 APPLIED다', async () => {
    h = await appealHarness();
    const { caseId } = await h.openAppeal();
    await h.runDispatch();
    h.stubs.queue.next('ResolveVerificationAppeal', { code: grpc.status.UNAVAILABLE }, { value: { result: 'RESOLVE_APPEAL_RESULT_UNCHANGED' } });
    h.stubs.trust.next('ApplyLabel', { code: grpc.status.DEADLINE_EXCEEDED }, { value: { changed: false, block_list: 'BLOCK_LIST_CHANGE_REMOVED' } });
    h.stubs.identity.next('SetAccountHold', { code: grpc.status.UNAVAILABLE }, { value: { changed: false } });
    expect((await h.decide(h.as('cs_agent'), caseId, ACCEPT, { ifMatch: '"1"' })).status).toBe(202);
    await untilAttempted(h, caseId, ['QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE']);
    await h.advanceAndRun(RETRY.firstMs);
    const va = await h.appealOf(caseId);
    expect((va.dispatch as Array<Record<string, unknown>>).slice(2).map((d) => [d.call, d.state, d.attempts])).toEqual([
      ['QUEUE_RESOLVE', 'APPLIED', 2],
      ['TRUST_LABEL', 'APPLIED', 2],
      ['ACCOUNT_HOLD_CLOSE', 'APPLIED', 2],
    ]);
    expect([va.reflectState, (va.decision as Record<string, unknown>).blockListChange]).toEqual(['APPLIED', 'REMOVED']);
    // 다시 보내기는 판을 올리지 않는다
    expect(h.stubs.queue.of('ResolveVerificationAppeal').map((r) => r.case_version)).toEqual([2, 2]);
    expect(h.stubs.trust.of('ApplyLabel').map((r) => r.source_version)).toEqual([2, 2]);
  });

  test('B-T28 ⑥ queue-svc가 NOT_ISOLATED(이미 통과·끝남)로 답해도 APPLIED이고 인정의 라벨은 그대로 보낸다', async () => {
    h = await appealHarness();
    const { caseId } = await h.openAppeal();
    await h.runDispatch();
    h.stubs.queue.set('ResolveVerificationAppeal', { value: { result: 'RESOLVE_APPEAL_RESULT_NOT_ISOLATED' } });
    expect((await h.decide(h.as('cs_agent'), caseId, ACCEPT, { ifMatch: '"1"' })).status).toBe(202);
    await untilAttempted(h, caseId, ['QUEUE_RESOLVE', 'TRUST_LABEL']);
    expect(await h.dispatchOf(caseId, 'QUEUE_RESOLVE')).toMatchObject({ state: 'APPLIED', attempts: 1 });
    expect(h.stubs.trust.count('ApplyLabel')).toBe(1);
  });
});

describe('B-T28 ⑥ 내용이 없을 때', () => {
  test('B-T28 ⑥ 내용을 옮기기 전(queue 멈춤)에는 병합 막기를 보내지 않고 시도 수 0이며, 내용이 오면 그 바퀴에 보낸다', async () => {
    h = await appealHarness();
    h.stubs.queue.fail(grpc.status.UNAVAILABLE);
    const { caseId, fx } = await h.openAppeal();
    await h.runDispatch();
    expect(await h.dispatchOf(caseId, 'APPEAL_COPY')).toMatchObject({ state: 'PENDING', attempts: 1, lastError: 'UNAVAILABLE' });
    expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_OPEN')).toMatchObject({ state: 'PENDING', attempts: 0, lastError: null });
    expect(h.stubs.identity.count('SetAccountHold')).toBe(0);
    h.stubs.queue.restore();
    await h.advanceAndRun(RETRY.firstMs);
    expect(h.stubs.identity.of('SetAccountHold').map((r) => [r.state, r.account_id])).toEqual([['ACCOUNT_HOLD_STATE_OPEN', fx.accountId]]);
  });

  test('B-T28 ⑥ 보관이 끝나 내용이 없으면(NOT_FOUND) 병합 막기·라벨은 APPEAL_CONTENT_MISSING 반영 실패이고 대기 참여 반영은 보낸다', async () => {
    h = await appealHarness();
    const { caseId, fx } = await h.openAppeal(appealFixture(), { content: false });
    await h.runDispatch();
    expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_OPEN')).toMatchObject({ state: 'FAILED', lastError: 'APPEAL_CONTENT_MISSING' });
    expect((await h.appealOf(caseId)).content).toBe('GONE');
    expect((await h.decide(h.as('cs_agent'), caseId, ACCEPT, { ifMatch: '"1"' })).status).toBe(202);
    await untilAttempted(h, caseId, ['QUEUE_RESOLVE']);
    await h.advanceAndRun(3_600_000);
    expect(h.stubs.queue.of('ResolveVerificationAppeal').map((r) => [r.appeal_id, r.outcome])).toEqual([[fx.appealId, 'APPEAL_OUTCOME_ACCEPTED']]);
    expect(await h.dispatchOf(caseId, 'TRUST_LABEL')).toMatchObject({ state: 'FAILED', lastError: 'APPEAL_CONTENT_MISSING' });
    expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_CLOSE')).toMatchObject({ state: 'FAILED', lastError: 'APPEAL_CONTENT_MISSING' });
    expect([h.stubs.trust.count('ApplyLabel'), h.stubs.identity.count('SetAccountHold')]).toEqual([0, 0]);
    expect((await h.appealOf(caseId)).reflectState).toBe('FAILED');
  });
});

describe('B-T28 ⑥ 겹쳐 보내지 않는다(잡음)', () => {
  test('B-T28 ⑥ 결정 직후 보내기와 배경 작업 두 바퀴가 겹쳐도 각 호출은 한 번이다', async () => {
    h = await appealHarness();
    const { caseId } = await h.openAppeal();
    await h.runDispatch();
    // real-time: 받는 쪽이 0.3초 늦게 답해 보내기가 실제로 겹치게 한다(gRPC 답은 실제 시계로 온다) F-06-7
    const slow = <T>(v: T) => () => new Promise<T>((r) => setTimeout(() => r(v), 300));
    h.stubs.queue.set('ResolveVerificationAppeal', slow({ value: { result: 'RESOLVE_APPEAL_RESULT_APPLIED' } }));
    h.stubs.trust.set('ApplyLabel', slow({ value: { changed: true, block_list: 'BLOCK_LIST_CHANGE_REMOVED' } }));
    const job = h;
    const [r] = await Promise.all([h.decide(h.as('cs_agent'), caseId, ACCEPT, { ifMatch: '"1"' }), (async () => {
      await expect.poll(() => job.stubs.queue.count('ResolveVerificationAppeal'), { timeout: 5_000, interval: 5 }).toBe(1);
      await Promise.all([job.runDispatch(), job.runDispatch()]);
    })()]);
    expect(r.status).toBe(202);
    await untilAttempted(h, caseId, ['QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE']);
    await expect.poll(async () => (await h!.appealOf(caseId)).reflectState, { timeout: 5_000 }).toBe('APPLIED');
    expect([h.stubs.queue.count('ResolveVerificationAppeal'), h.stubs.trust.count('ApplyLabel')]).toEqual([1, 1]);
  });
});

describe('B-T28 ⑥ 지표', () => {
  test('B-T28 ⑥ ops_cs_case_dispatch_total은 호출·결과(applied·retry·failed)별로 센다', async () => {
    h = await appealHarness();
    const { caseId } = await h.openAppeal();
    await h.runDispatch();
    h.stubs.queue.next('ResolveVerificationAppeal', { code: grpc.status.UNAVAILABLE });
    h.stubs.identity.set('SetAccountHold', { code: grpc.status.NOT_FOUND });
    expect((await h.decide(h.as('cs_agent'), caseId, ACCEPT, { ifMatch: '"1"' })).status).toBe(202);
    await untilAttempted(h, caseId, ['QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE']);
    await h.advanceAndRun(RETRY.firstMs);
    const got = {
      copy: await h.dispatchMetric('APPEAL_COPY', 'applied'),
      openApplied: await h.dispatchMetric('ACCOUNT_HOLD_OPEN', 'applied'),
      queueRetry: await h.dispatchMetric('QUEUE_RESOLVE', 'retry'),
      queueApplied: await h.dispatchMetric('QUEUE_RESOLVE', 'applied'),
      label: await h.dispatchMetric('TRUST_LABEL', 'applied'),
      closeFailed: await h.dispatchMetric('ACCOUNT_HOLD_CLOSE', 'failed'),
      closeRetry: await h.dispatchMetric('ACCOUNT_HOLD_CLOSE', 'retry'),
    };
    expect(got).toEqual({ copy: 1, openApplied: 1, queueRetry: 1, queueApplied: 1, label: 1, closeFailed: 1, closeRetry: 0 });
  });
});

// 시험 리뷰 1 TR-02 반영(시험 담당 lane3-f067-test): 이의 내용(APPEAL_COPY)을 옮기기 전에 내린 결정.
// 정본: bot-defense §12 '기다림과 이어 보내기'(내용이 없으면 OPEN·TRUST_LABEL·CLOSE는 보내지 않고 시도 0, QUEUE_RESOLVE는 이의 ID만 써서 바로 간다,
// 내용을 옮긴 그 바퀴에 기다리던 호출을 이어 보낸다), '호출 모양'(ApplyLabel은 회차·pid, SetAccountHold는 계정). 대역은 빈 pid·회차·계정을 INVALID_ARGUMENT로 거절한다.
describe('B-T28 ⑥ B-T10 ⑥ 내용을 옮기기 전의 결정', () => {
  for (const outcome of ['ACCEPTED', 'REJECTED'] as const) {
    test(`B-T28 ⑥ ${outcome}: QUEUE_RESOLVE는 바로 가고 라벨·병합 막기는 시도 0으로 기다리다가, 내용을 옮긴 바퀴에 옮긴 회차·pid·계정으로 한 번씩 간다`, async () => {
      h = await appealHarness();
      h.stubs.queue.fail(grpc.status.UNAVAILABLE, 'GetVerificationAppeal');
      const { caseId, fx } = await h.openAppeal();
      await h.runDispatch();
      expect((await h.decide(h.as('cs_agent'), caseId, { outcome, resultNote: NOTE }, { ifMatch: '"1"' })).status).toBe(202);
      await untilAttempted(h, caseId, ['QUEUE_RESOLVE']);
      const waiting = outcome === 'ACCEPTED' ? ['ACCOUNT_HOLD_OPEN', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE'] : ['ACCOUNT_HOLD_OPEN', 'ACCOUNT_HOLD_CLOSE'];
      expect(await h.dispatchOf(caseId, 'QUEUE_RESOLVE')).toMatchObject({ state: 'APPLIED', attempts: 1 });
      for (const call of waiting) expect(await h.dispatchOf(caseId, call), call).toMatchObject({ state: 'PENDING', attempts: 0, lastError: null });
      expect([h.stubs.trust.count('ApplyLabel'), h.stubs.identity.count('SetAccountHold')]).toEqual([0, 0]);
      h.stubs.queue.restore();
      await h.advanceAndRun(RETRY.capMs);
      const labels = h.stubs.trust.of('ApplyLabel');
      expect(labels.map((r) => [r.event_id, r.pid, r.source_version])).toEqual(outcome === 'ACCEPTED' ? [[fx.eventId, fx.pid, 2]] : []);
      expect(h.stubs.identity.of('SetAccountHold').map((r) => [r.state, r.account_id, r.source_version]).sort()).toEqual([
        ['ACCOUNT_HOLD_STATE_CLOSED', fx.accountId, 2],
        ['ACCOUNT_HOLD_STATE_OPEN', fx.accountId, 1],
      ]);
      for (const call of waiting) expect(await h.dispatchOf(caseId, call), call).toMatchObject({ state: 'APPLIED', attempts: 1, lastError: null });
      expect((await h.appealOf(caseId)).reflectState).toBe('APPLIED');
      await h.advanceAndRun(3_600_000);
      expect([h.stubs.trust.count('ApplyLabel'), h.stubs.identity.count('SetAccountHold')]).toEqual([outcome === 'ACCEPTED' ? 1 : 0, 2]);
    });
  }
});

// 시험 리뷰 1 TR-03 반영: 답하지 않는 받는 쪽. 정본 bot-defense §12 '결정'(커밋 뒤 호출마다 2초 [가정], 결과와 상관없이 202), 계획 §4(호출마다 데드라인).
describe('B-T28 ⑥ 데드라인', () => {
  test('B-T28 ⑥ identity가 답하지 않아도 결정은 2초 데드라인 안에 202이고 그 호출은 DEADLINE_EXCEEDED로 PENDING이며, 배경 작업 한 바퀴도 묶이지 않는다', async () => {
    h = await appealHarness();
    const { caseId } = await h.openAppeal();
    await h.runDispatch();
    // real-time: gRPC 데드라인은 실제 시계로 잰다. 받는 쪽은 6초 뒤에야 답한다(정본 2초 + 여유 1.5초 안에 끊겨야 한다) F-06-7
    h.stubs.identity.set('SetAccountHold', () => new Promise((r) => setTimeout(() => r({ value: { changed: true } }), 6_000)));
    const started = performance.now();
    const r = await h.decide(h.as('cs_agent'), caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, { ifMatch: '"1"' });
    expect(r.status).toBe(202);
    expect(performance.now() - started).toBeLessThan(3_500);
    await untilAttempted(h, caseId, ['ACCOUNT_HOLD_CLOSE']);
    await expect.poll(async () => (await h!.dispatchOf(caseId, 'ACCOUNT_HOLD_CLOSE'))?.lastError, { timeout: 5_000 }).toBe('DEADLINE_EXCEEDED');
    expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_CLOSE')).toMatchObject({ state: 'PENDING', attempts: 1 });
    h.clock.advance(RETRY.firstMs);
    const round = performance.now();
    await h.runDispatch();
    expect(performance.now() - round).toBeLessThan(3_500);
    expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_CLOSE')).toMatchObject({ state: 'PENDING', attempts: 2, lastError: 'DEADLINE_EXCEEDED' });
  }, 30_000);
});

// 시험 리뷰 1 TR-05 반영: 배경 작업이 손으로 부르지 않아도 도는지(타이머). 정본 bot-defense §12 '다시 보내기'(배경 작업이 10초 [가정]마다),
// 계획 §4(background.csCaseDispatchMs, 메모리·DB 두 조립). 타이머만 가짜로 두고(gRPC·Fastify의 setTimeout은 실제) 앱 시계는 가짜 시계로 함께 옮긴다.
describe('B-T28 ⑥ 배경 작업 타이머', () => {
  test('B-T28 ⑥ background를 켜면 runOnce를 부르지 않아도 10초 − 1ms엔 돌지 않고 10초에 한 바퀴 돌아 이의 내용을 옮긴다', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      h = await appealHarness({ background: {} });
      const { fx } = await h.openAppeal();
      h.clock.advance(RETRY.firstMs);
      await vi.advanceTimersByTimeAsync(RETRY.firstMs - 1);
      expect(h.stubs.queue.count('GetVerificationAppeal')).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await expect.poll(() => h!.stubs.queue.of('GetVerificationAppeal'), { timeout: 5_000 }).toEqual([{ appeal_id: fx.appealId }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
