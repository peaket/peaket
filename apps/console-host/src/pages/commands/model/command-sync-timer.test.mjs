// ack가 쌓이는 동안(DISPATCHED)은 흐름 사건이 오지 않으므로 3초마다 상세를 REST로 덮어 읽고, 끝 상태를 보면 멈춘다(F-03-4 T11 ②, C-T7 ②, 시험 먼저 ADR 0372번).
// 정본: docs/features/control-tower.md §4 T10('3초를 넘으면 명령 카드에 전파 지연'), 계획 '감독에게' 4 (나)(상태가 DISPATCHED 그대로면 사건이 오지 않는다)와
// 감독 결정(2026-11-23: ack가 쌓이는 동안의 SSE 사건은 동결, 화면은 REST로 다시 읽고 3초마다 덮어 읽는다). 시간 경계는 양쪽(2,999ms·3,000ms)을 본다.
// 구현 전 트리에는 command-sync.ts가 없어 무대에서 실패한다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C1, commandState } from './commands.test.fakes.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);
globalThis.__PREVIEW__ = false;
globalThis.__OPS_API_ORIGIN__ = 'https://ops-api.test';

/** 정본 3초(control-tower §4 T10) */
const REREAD_MS = 3_000;
const ack = (n) => ({ kind: 'ACK', ackedCount: n, targetCount: 3, unackedTargets: n < 3 ? ['purchase-svc-3'] : [] });

test('F-03-4 T11 ②-1 DISPATCHED 상세는 3초(2,999ms 아님)마다 다시 읽어 ack 수를 덮어 그리고, ACKED를 읽은 뒤에는 더 읽지 않는다', async () => {
  const { syncHarness } = await import('./command-sync.test.harness.mjs');
  const h = await syncHarness({ role: 'commander', details: { [C1]: commandState({ state: 'DISPATCHED', delivery: ack(1) }) } });
  try {
    assert.equal(h.mod.DETAIL_REREAD_MS, REREAD_MS);
    h.sync.select(C1);
    await h.tick(0);
    assert.equal(h.detailGets(C1), 1);
    await h.tick(REREAD_MS - 1);
    assert.equal(h.detailGets(C1), 1, '3초 전에 다시 읽었다');
    h.server.details[C1] = commandState({ state: 'DISPATCHED', delivery: ack(2) });
    await h.tick(1);
    assert.equal(h.detailGets(C1), 2, '3초에 다시 읽지 않았다');
    assert.equal(h.shown.at(-1).delivery.ackedCount, 2);
    await h.tick(REREAD_MS - 1);
    assert.equal(h.detailGets(C1), 2);
    h.server.details[C1] = commandState({ state: 'ACKED', delivery: ack(3) });
    await h.tick(1);
    assert.equal(h.detailGets(C1), 3);
    assert.equal(h.shown.at(-1).state, 'ACKED');
    assert.equal(h.shown.at(-1).delivery.ackedCount, 3);
    await h.tick(REREAD_MS * 4);
    assert.equal(h.detailGets(C1), 3, 'ACKED 뒤에도 다시 읽었다(주기 폴링)');
  } finally {
    h.stop();
  }
});
