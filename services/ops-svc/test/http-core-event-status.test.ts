// R-T41 ③ core 회차 상태 반영 어댑터의 연결 실패·시간 초과(검증 O09 보강, BAT-420-rest 리뷰 반영, 시험 담당 l3-b420-test, 2026-11-19).
// 정본: docs/features/transfer-refund.md §5 'core 회차 상태 반영'(실패 모양은 판매 설정 읽기와 같다: 무응답·연결 실패·5xx·4xx 모두 다시 하기가 잇는다), §11 R-T41 ③.
// 어댑터가 request의 오류를 삼켜 '반영함'으로 돌려주면 core_applied_at이 잘못 써진다. 두 경우 모두 apply가 던져야 한다.
import { describe, expect, test } from 'vitest';
import { HttpCoreEventStatus } from '../src/adapters/http-core-event-status.js';

const q = { eventId: '0194b000-0000-7000-8000-0000000c5001', requestId: '0194b000-0000-7000-8000-0000000c5002', kind: 'CANCEL' as const };

describe('R-T41 ③ HttpCoreEventStatus 연결 실패·시간 초과', () => {
  test('R-T41 ③ 어댑터는 연결 실패·시간 초과를 실패로 던진다(ECONNREFUSED, TimeoutError 그 오류 그대로)', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    for (const err of [refused, timeout]) {
      let called = 0;
      const a = new HttpCoreEventStatus({ request: async () => (called++, Promise.reject(err)) } as never, 'it-token');
      await expect(a.apply(q), err.name).rejects.toBe(err);
      expect(called, err.name).toBe(1);
    }
  });
});
