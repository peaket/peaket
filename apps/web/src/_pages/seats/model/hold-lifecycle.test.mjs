// 홀드 다시 읽기·연장·해제와 방금 놓은 좌석(docs/frontend.md §4.2.2 6·7행, BUILD_ORDER HOT-356). 실행부를 가짜 API로 돌린다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';

register('../../../shared/lib/test-ts-resolve.mjs', import.meta.url);
const { ApiError } = await import('@peaket/api-client');
const { createBooking, REHOLD_WAIT_MS } = await import('./booking-runtime.ts');

const hold = (over = {}) => ({ holdId: 'h1', seatIds: ['A1'], expiresAt: '2026-11-09T12:07:00.000Z', extendable: true, ...over });

const harnessRefresh = { value: 'ok' };
function harness(respond) {
  const log = [];
  const saved = { id: 'h1', cleared: 0, mine: [], released: [], toggles: [] };
  const client = {
    async send(op, o = {}) {
      log.push({ op: op.operationId ?? op, o });
      const r = await respond(op, o);
      return { data: r, headers: new Headers({ date: 'Mon, 09 Nov 2026 12:00:00 GMT' }) };
    },
  };
  const b = createBooking({
    eventId: 'e1',
    session: { clientPublicKey: 'k', end: async () => {} },
    client,
    toggleOnMap: (i) => saved.toggles.push(i),
    refreshToken: async () => harnessRefresh.value,
    limit: 4,
    saveHold: (h) => {
      saved.saved = h;
    },
    clearHold: () => {
      saved.cleared += 1;
    },
    now: () => 1000,
    wall: () => Date.parse('2026-11-09T12:00:00.000Z'),
    admissionToken: 'tok',
    savedHoldId: () => saved.id,
    setMineOnMap: (ids, on) => saved.mine.push([ids, on]),
    markReleasedOnMap: (s) => saved.released.push(...s),
  });
  return { b, log, saved };
}
const apiError = (status, type) => new ApiError(status, { status, type }, null, null);

test('HOT-356 새로고침: 저장한 홀드를 다시 읽어 held로 돌아오고 지도에 내 좌석을 표시한다', async () => {
  const { b, saved } = harness(async () => hold());
  await b.restore();
  assert.equal(b.actor.getSnapshot().value, 'held');
  assert.deepEqual(saved.mine, [[['A1'], true]]);
  assert.equal(b.held().holdId, 'h1');
});

test('HOT-356 새로고침: 서버에 없으면(404) 저장값을 지우고 고르기로 남는다', async () => {
  const { b, saved } = harness(async () => {
    throw apiError(404, 'hold-not-found');
  });
  await b.restore();
  assert.equal(b.actor.getSnapshot().value, 'selecting');
  assert.equal(saved.cleared, 1);
});

test('HOT-356 새로고침: 일시 장애가 이어지면 영원히 멈추지 않고 안내를 띄운다', async () => {
  let calls = 0;
  const { b } = harness(async () => {
    calls += 1;
    throw apiError(503, 'seat-store-unavailable');
  });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (f) => realSetTimeout(f, 0);
  try {
    await b.restore();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(calls, 4);
  assert.deepEqual(b.actor.getSnapshot().context.notice, { kind: 'error' });
  assert.equal(b.actor.getSnapshot().value, 'selecting');
});

test('HOT-356 연장: 200이면 서버의 새 만료로 맞추고 연장 표시가 켜진다', async () => {
  let reads = 0;
  const { b } = harness(async (op) => {
    if (String(op.operationId ?? op).includes('getHold')) {
      reads += 1;
      return hold();
    }
    return hold({ expiresAt: '2026-11-09T12:10:00.000Z', extendable: false });
  });
  await b.restore();
  await b.extend();
  assert.equal(b.held().expiresAt, '2026-11-09T12:10:00.000Z');
  assert.equal(b.actor.getSnapshot().context.extended, true);
  assert.equal(reads, 1);
});

test('S-T6 HOT-356 두 번째 연장 409는 서버를 다시 읽어 실제 만료로 맞춘다(응답 유실·다른 탭)', async () => {
  let reads = 0;
  const { b } = harness(async (op) => {
    if (String(op.operationId ?? op).includes('getHold')) {
      reads += 1;
      return hold({ expiresAt: '2026-11-09T12:10:00.000Z', extendable: false });
    }
    throw apiError(409, 'hold-already-extended');
  });
  await b.restore();
  await b.extend();
  assert.equal(reads, 2);
  assert.equal(b.held().expiresAt, '2026-11-09T12:10:00.000Z');
  assert.equal(b.actor.getSnapshot().value, 'held');
  assert.equal(b.actor.getSnapshot().context.extended, true);
});

test('HOT-356 연장 404는 홀드가 끝난 것으로 보고 비운다', async () => {
  const { b, saved } = harness(async (op) => {
    if (String(op.operationId ?? op).includes('getHold')) return hold();
    throw apiError(404, 'hold-not-found');
  });
  await b.restore();
  await b.extend();
  assert.equal(b.actor.getSnapshot().value, 'selecting');
  assert.equal(saved.cleared, 1);
});

test('S-T33 HOT-356 해제: 204면 30초 흐리게 표시하고 그 좌석은 고르지 못한다', async () => {
  const { b, saved } = harness(async (op) => (String(op.operationId ?? op).includes('getHold') ? hold() : null));
  await b.restore();
  await b.release();
  assert.equal(b.actor.getSnapshot().value, 'selecting');
  assert.equal(saved.released.length, 1);
  assert.equal(saved.released[0].seatId, 'A1');
  assert.equal(saved.released[0].untilMs, Date.parse('2026-11-09T12:00:00.000Z') + REHOLD_WAIT_MS);
  b.pick({ seatId: 'A1', label: 'A1', tier: 'r' }, 0);
  assert.equal(b.actor.getSnapshot().context.picks.length, 0);
  assert.equal(b.actor.getSnapshot().context.notice.kind, 'recent-pick');
});

test('HOT-356 해제: 다른 좌석은 고를 수 있다', async () => {
  const { b } = harness(async (op) => (String(op.operationId ?? op).includes('getHold') ? hold() : null));
  await b.restore();
  await b.release();
  b.pick({ seatId: 'A2', label: 'A2', tier: 'r' }, 1);
  assert.equal(b.actor.getSnapshot().context.picks.length, 1);
});

test('HOT-356 결제가 진행 중인 홀드는 놓지 않고 안내만 한다(409 hold-in-payment)', async () => {
  const { b, saved } = harness(async (op) => {
    if (String(op.operationId ?? op).includes('getHold')) return hold();
    throw apiError(409, 'hold-in-payment');
  });
  await b.restore();
  await b.release();
  assert.equal(b.actor.getSnapshot().value, 'held');
  assert.equal(saved.cleared, 0);
  assert.equal(b.actor.getSnapshot().context.notice.kind, 'in-payment');
});

test('HOT-356 만료도 놓은 좌석으로 표시한다', async () => {
  const { b, saved } = harness(async () => hold());
  await b.restore();
  b.expire();
  assert.equal(saved.released[0].seatId, 'A1');
  assert.equal(b.actor.getSnapshot().context.notice.kind, 'expired');
});

const seat = (id = 'A1') => ({ seatId: id, label: id, tier: 'R' });
async function heldHarness(respond) {
  const h = harness(async (op, o) => respond(op, o) ?? hold());
  await h.b.restore();
  assert.equal(h.b.actor.getSnapshot().value, 'held');
  return h;
}
const opIs = (op, id) => (op.operationId ?? op) === id || op === id || op?.id === id;

test('M7 연장의 이름 있는 401·403은 세션 끝이다', async () => {
  for (const e of [apiError(401, 'purchase-session-ended'), apiError(403, 'forbidden')]) {
    let n = 0;
    const { b } = await heldHarness(() => {
      if ((n += 1) > 1) throw e;
    });
    await b.extend();
    assert.equal(b.actor.getSnapshot().value, 'ended');
  }
});

test('M7 해제의 이름 있는 401·403은 세션 끝이다', async () => {
  for (const e of [apiError(401, 'purchase-session-ended'), apiError(403, 'forbidden')]) {
    let n = 0;
    const { b } = await heldHarness(() => {
      if ((n += 1) > 1) throw e;
    });
    await b.release();
    assert.equal(b.actor.getSnapshot().value, 'ended');
  }
});

test('M7 토큰 갱신의 일시 장애는 세션 끝이 아니다(연장·해제·다시 읽기)', async () => {
  harnessRefresh.value = 'unavailable';
  try {
    let n = 0;
    const { b } = await heldHarness(() => {
      if ((n += 1) > 1) throw apiError(401, 'about:blank');
    });
    await b.extend();
    assert.equal(b.actor.getSnapshot().value, 'held');
    await b.release();
    assert.equal(b.actor.getSnapshot().value, 'held');
  } finally {
    harnessRefresh.value = 'ok';
  }
});

test('L13 seat-recently-released의 reholdAvailableAt을 그 좌석 표시에 반영한다', async () => {
  const until = '2026-11-09T12:00:20.000Z';
  const { b, saved } = harness(async () => {
    throw new ApiError(409, { status: 409, type: 'seat-recently-released', recentlyReleasedSeats: ['A1'], reholdAvailableAt: until }, null, null);
  });
  saved.id = undefined;
  b.pick(seat(), 3);
  await b.hold();
  assert.equal(b.actor.getSnapshot().value, 'selecting');
  assert.deepEqual(saved.released, [{ seatId: 'A1', untilMs: Date.parse(until) }]);
  b.pick(seat(), 3);
  assert.equal(b.actor.getSnapshot().context.notice.kind, 'recent-pick');
});

test('L13 연장 404는 지도 표시를 지우고 30초 다시 잡기 표시를 남긴다', async () => {
  const seen = [];
  const h = harness(async (op) => {
    seen.push(op);
    if (seen.length > 1) throw apiError(404, 'not-found');
    return { holdId: 'h1', seatIds: ['A1'], expiresAt: hold().expiresAt };
  });
  h.saved.id = undefined;
  h.b.pick(seat(), 7);
  await h.b.hold();
  assert.equal(h.b.actor.getSnapshot().value, 'held');
  await h.b.extend();
  assert.equal(h.b.actor.getSnapshot().value, 'selecting');
  assert.deepEqual(h.saved.toggles, [7, 7]);
  assert.equal(h.saved.released.length, 1);
});

test('L13 해제 응답을 잃어도 서버에서 풀렸으면 놓은 것으로 끝낸다', async () => {
  let n = 0;
  const { b } = await heldHarness(() => {
    n += 1;
    if (n === 2) throw new Error('network');
    if (n === 3) throw apiError(404, 'not-found');
  });
  await b.release();
  assert.equal(b.actor.getSnapshot().context.notice.kind, 'released');
  assert.equal(b.actor.getSnapshot().value, 'selecting');
});

test('L13 홀드 응답을 잃은 뒤 좌석을 바꿔도 먼저 앞 요청을 같은 키로 확인한다', async () => {
  const calls = [];
  const h = harness(async (op, o) => {
    calls.push(o.idempotencyKey);
    if (calls.length === 1) throw new Error('network');
    return { holdId: 'h9', seatIds: ['A1'], expiresAt: hold().expiresAt };
  });
  h.saved.id = undefined;
  h.b.pick(seat('A1'), 1);
  await h.b.hold();
  assert.equal(h.b.actor.getSnapshot().value, 'selecting');
  h.b.pick(seat('A1'), 1);
  h.b.pick(seat('B2'), 2);
  await h.b.hold();
  assert.equal(calls[0], calls[1]);
  assert.equal(h.b.actor.getSnapshot().value, 'held');
  assert.equal(h.b.held().seatIds[0], 'A1');
});

test('L13 복원 중에는 좌석을 고르지 못한다', async () => {
  let release;
  const h = harness(() => new Promise((f) => (release = () => f(hold()))));
  const p = h.b.restore();
  await new Promise((f) => setImmediate(f));
  h.b.pick(seat('B2'), 2);
  assert.deepEqual(h.saved.toggles, []);
  release();
  await p;
  assert.equal(h.b.actor.getSnapshot().context.picks.length, 0);
});

test('H3 S-T23 멈춘 홀드는 시간이 지나도 만료로 끝내지 않고 저장값을 지우지 않는다', async () => {
  const { b, saved } = harness(async () => hold({ frozen: true }));
  await b.restore();
  b.expire();
  assert.equal(b.actor.getSnapshot().value, 'held');
  assert.equal(saved.cleared, 0);
  assert.equal(b.held().frozen, true);
});
