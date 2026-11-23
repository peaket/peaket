// alerts 모듈 공개 읽기(list)의 메모리 저장소 계약 시험(F-03-3 T18, 시험 먼저 ADR-0372). 같은 묶음을 test-int/ops-alerts-list.int.test.ts가 PostgreSQL 저장소에 돌린다.
// 정본: ADR-0100 결정 2(reset이면 경보를 REST로 다시 읽는다), docs/frontend.md §3.10('걸린 경보와 풀린 지 60분 [가정] 안의 경보'), 계획 '감독에게' 10.
import { describe, test } from 'vitest';
import { MemoryOpsAlertStore } from '../src/modules/alerts/index.js';
import { alertListContract } from './ops-alert-list-contract.js';

describe('F-03-3 경보 목록 읽기(메모리 저장소)', () => {
  test('F-03-3 T18 FE-T28 ②-11 걸린 경보 전부와 풀린 지 60분 안의 경보를 돌려주고, eventKey·limit을 지킨다(메모리 짝)', async () => {
    await alertListContract(new MemoryOpsAlertStore(), Date.parse('2026-11-23T10:00:00.000Z'));
  });
});
