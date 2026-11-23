// alerts 모듈 공개 읽기 OpsAlertStore.list({ eventKey?, resolvedSinceMs, limit })의 계약 시험 묶음(F-03-3, 계획 '감독에게' 10·§4 'alerts 공개 읽기').
// 메모리 저장소(test/ops-alerts-list.test.ts)와 PostgreSQL 저장소(test-int/ops-alerts-list.int.test.ts)에 같은 묶음을 돌려 짝을 확인한다(mock-policy 3절 '행동 짝').
// 기존 open·resolve 서명과 (eventKey, kind) 멱등 규칙은 그대로다(조건 ②). 시험은 열고 푸는 데 그 두 함수만 쓴다.
// 공유 DB에서도 돌게 키마다 실행 이름(runId)을 붙이고, 목록 전체 단언은 '들어 있음·없음'으로만 한다.
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { OpsAlert, OpsAlertStore } from '../src/modules/alerts/index.js';

const MIN = 60_000;

/** list가 생긴 포트(구현 전 트리의 포트에는 없다) */
type ListingStore = OpsAlertStore & {
  list(q: { eventKey?: string; resolvedSinceMs: number; limit: number }): Promise<readonly OpsAlert[]>;
};

/**
 * 계약: 걸린 경보는 언제 열렸든 모두, 풀린 경보는 resolvedSinceMs 이후에 풀린 것만, eventKey를 주면 그 키만, limit을 넘지 않는다.
 * @param store 시험할 저장소
 * @param nowMs 기준 시각
 */
export async function alertListContract(store: OpsAlertStore, nowMs: number): Promise<void> {
  const s = store as ListingStore;
  expect(typeof s.list).toBe('function');
  const run = randomUUID();
  const key = (n: string) => `f033-${run}-${n}`;
  const open = (n: string, kind: string, atMs: number) =>
    store.open({ alertId: randomUUID(), eventKey: key(n), kind, severity: 'SEV2', source: 'f033-contract', reason: `계약 ${n}`, detail: { n }, nowMs: atMs });

  // 3시간 전에 열려 아직 걸린 경보, 30분 전에 풀린 경보, 61분 전에 풀린 경보, 같은 키의 다른 종류
  const firingOld = await open('a', 'slo', nowMs - 180 * MIN);
  const recent = await open('b', 'slo', nowMs - 90 * MIN);
  await store.resolve({ eventKey: key('b'), kind: 'slo', reason: 'ok', nowMs: nowMs - 30 * MIN });
  const stale = await open('c', 'slo', nowMs - 120 * MIN);
  await store.resolve({ eventKey: key('c'), kind: 'slo', reason: 'ok', nowMs: nowMs - 61 * MIN });
  const otherKind = await open('a', 'cause', nowMs - 5 * MIN);

  const since = nowMs - 60 * MIN;
  const all = await s.list({ resolvedSinceMs: since, limit: 10_000 });
  const ids = new Set(all.map((a) => a.alertId));
  expect([firingOld.alertId, recent.alertId, otherKind.alertId].filter((id) => !ids.has(id))).toEqual([]);
  expect(ids.has(stale.alertId)).toBe(false);
  // 돌려준 경보는 열고 풀 때의 값 그대로다(같은 모양의 OpsAlert)
  const r = all.find((a) => a.alertId === recent.alertId)!;
  expect(r).toMatchObject({ eventKey: key('b'), kind: 'slo', severity: 'SEV2', source: 'f033-contract', reason: '계약 b', detail: { n: 'b' }, createdAtMs: nowMs - 90 * MIN, resolvedAtMs: nowMs - 30 * MIN, resolvedReason: 'ok' });
  expect(all.find((a) => a.alertId === firingOld.alertId)!.resolvedAtMs).toBeUndefined();

  // eventKey를 주면 그 키의 경보만(종류 둘)
  const onlyA = await s.list({ eventKey: key('a'), resolvedSinceMs: since, limit: 100 });
  expect(onlyA.map((a) => a.kind).sort()).toEqual(['cause', 'slo']);
  // 풀린 지 오래된 경보만 있는 키는 비어 있다
  expect(await s.list({ eventKey: key('c'), resolvedSinceMs: since, limit: 100 })).toEqual([]);
  // limit을 넘지 않는다
  expect(await s.list({ eventKey: key('a'), resolvedSinceMs: since, limit: 1 })).toHaveLength(1);
}
