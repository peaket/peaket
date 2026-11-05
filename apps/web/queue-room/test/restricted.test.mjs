// SCR-008 '예매 제한'(ADR-0213 결정 4): 입장 확정 403 booking-restricted면 폴링을 멈추고, 팬 API로 제한 ID를 받아 ( 소명하기 › )를 잇는다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, reply, stateFile } from './harness.mjs';

const REC = { preverifyToken: 'pv', ticket: { queueTicket: 'qt', seq: 1000, generation: 1, segment: 0 } };
const iso = (ms) => new Date(ms).toISOString();

function restricted(fan) {
  return harness({
    rec: REC,
    handler: ({ m, url, now }) => {
      if (m === 'GET') return reply(200, stateFile({ serving: 1000, generatedAtMs: now }));
      if (m === 'GETFAN') return fan(now, url);
      if (m === 'POST' && url.endsWith('/admission')) return reply(403, {}, { problem: 'booking-restricted' });
      return reply(500);
    },
  });
}

test('SCR-008 예매 제한: 403 뒤 팬 API(자격 증명 포함)로 제한 ID를 받아 소명 링크를 잇고, 대기표는 그대로 둔다', async () => {
  const h = restricted((now) => reply(200, { status: 'ACTIVE', restrictionId: 'rst-1', appealDueAt: iso(now + 86_400_000) }));
  await h.start();
  const fan = h.calls.filter((c) => c.m === 'GETFAN');
  assert.equal(fan.length, 1);
  assert.equal(fan[0].url, 'https://api/v1/booking-restrictions/me');
  assert.deepEqual([h.last().state, h.last().appealId], ['restricted', 'rst-1']);
  assert.equal(h.store.read().ticket.queueTicket, 'qt', '대기표는 지우지 않는다(제한이 풀리면 같은 대기표로 입장)');
  const polls = h.calls.filter((c) => c.m === 'GET').length;
  await h.run(10_000);
  assert.equal(h.calls.filter((c) => c.m === 'GET').length, polls, '폴링을 멈춘다');
});

test('SCR-008 예매 제한: 소명 기한이 지났거나·NONE(사본이 늦음)·실패면 소명 링크 없이(공연 상세)', async () => {
  for (const fan of [
    (now) => reply(200, { status: 'ACTIVE', restrictionId: 'rst-1', appealDueAt: iso(now - 1000) }),
    () => reply(200, { status: 'NONE' }),
    () => reply(503),
    () => reply(200, { status: 'ACTIVE', restrictionId: null }),
  ]) {
    const h = restricted(fan);
    await h.start();
    assert.equal(h.last().state, 'restricted');
    assert.equal(h.last().appealId, undefined);
  }
});

test('SCR-008 예매 제한: 소명 기한이 없으면(null) 소명 링크를 둔다', async () => {
  const h = restricted(() => reply(200, { status: 'ACTIVE', restrictionId: 'rst-2', appealDueAt: null }));
  await h.start();
  assert.equal(h.last().appealId, 'rst-2');
});
