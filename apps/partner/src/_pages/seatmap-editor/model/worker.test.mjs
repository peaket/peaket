// 에디터 Worker 시험(ADR-0264 결정 5, asvs/frontend.md 15.1.3). 가짜 시계·가짜 Worker로 한도 − 1ms와 한도를 재고, 단언 값은 정본(10초)의 값을 적는다.
// Worker가 하는 일(worker-jobs.ts)은 Worker 없이 메시지 하나씩 부른다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkerClient, JobEnded, TIMEOUT_TEXT } from './worker-client.ts';
import { runJob } from './worker-jobs.ts';
import { packSection, unpackSection } from './worker-protocol.ts';
import { rectPoints } from './shapes.ts';

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

function fakeWorkers() {
  const made = [];
  return {
    made,
    make() {
      const w = { posted: [], terminated: false, onmessage: null, onerror: null, postMessage(m, transfer) { w.posted.push({ m, transfer }); }, terminate() { w.terminated = true; } };
      made.push(w);
      return w;
    },
  };
}

const settled = async (p) => {
  let state = 'pending';
  p.then(() => (state = 'resolved'), () => (state = 'rejected'));
  await new Promise((r) => setImmediate(r));
  return state;
};

test('채우기·내보내기는 Worker에서 돌고 새 요청이 앞 요청을 버리며 9,999ms에는 기다리고 10,000ms에 Worker를 다시 띄운다 [ASVS v5.0.0-15.1.3]', async () => {
  const t = fakeTimers();
  const w = fakeWorkers();
  const c = createWorkerClient(() => w.make(), t);
  // 같은 종류의 새 요청이 앞 요청을 버린다(cancel을 보낸다)
  const first = c.request('fill', { shape: [] });
  const second = c.request('fill', { shape: [] });
  await assert.rejects(first, (e) => e instanceof JobEnded && e.reason === 'cancelled');
  const posted = w.made[0].posted.map((p) => p.m.type);
  assert.deepEqual(posted, ['fill', 'cancel', 'fill']);
  assert.equal(w.made[0].posted[1].m.target, w.made[0].posted[0].m.id);
  // 버린 요청의 답은 무시하고 지금 요청의 답만 받는다
  w.made[0].onmessage({ data: { id: w.made[0].posted[0].m.id, ok: true, result: 'old' } });
  w.made[0].onmessage({ data: { id: w.made[0].posted[2].m.id, ok: true, result: 'new' } });
  assert.equal(await second, 'new');

  // 시간 한도 10초: 9,999ms에는 아직 기다리고, 10,000ms에 '계산을 끝내지 못했습니다'로 끝나며 Worker를 버리고 새로 띄운다
  const slow = c.request('export', { format: 'JSON' });
  const other = c.request('align', {});
  t.advance(9_999);
  assert.equal(await settled(slow), 'pending');
  assert.equal(w.made[0].terminated, false);
  t.advance(1);
  await assert.rejects(slow, (e) => e instanceof JobEnded && e.reason === 'timeout' && e.message === TIMEOUT_TEXT);
  await assert.rejects(other, (e) => e.reason === 'timeout');
  assert.equal(w.made[0].terminated, true);
  // 다음 요청은 새 Worker로 간다
  const again = c.request('fill', {});
  assert.equal(w.made.length, 2);
  assert.equal(c.started(), 2);
  w.made[1].onmessage({ data: { id: w.made[1].posted[0].m.id, ok: true, result: 1 } });
  assert.equal(await again, 1);
  // Worker가 죽으면(오류) 걸린 요청을 끝내고 다음에 새로 띄운다
  const crash = c.request('fill', {});
  w.made[1].onerror(new Error('boom'));
  await assert.rejects(crash, (e) => e.reason === 'crashed');
  c.request('fill', {}).catch(() => {});
  assert.equal(w.made.length, 3);
  c.close();
});

test('Worker 일: 채우기 결과는 형식 배열로 넘기고 다듬기는 바뀐 구역만 돌려준다 [ASVS v5.0.0-15.1.3]', () => {
  const stage = [{ kind: 'RECT', points: rectPoints({ x: 3000, y: 200, w: 2000, h: 600, rotation: 0 }) }];
  const canvas = { width: 8000, height: 6000 };
  const fill = runJob({ id: 7, type: 'fill', shape: rectPoints({ x: 3500, y: 1500, w: 1000, h: 500, rotation: 0 }), rule: { method: 'COUNT', targetCount: 10 }, stage, canvas });
  assert.equal(fill.reply.ok, true);
  assert.equal(fill.reply.id, 7);
  assert.equal(fill.reply.result.xs.length, 10);
  assert.equal(fill.transfer.length, 3);
  assert.ok(fill.transfer.every((b) => b instanceof ArrayBuffer));
  const section = { sectionId: 's1', name: 'A', shape: { kind: 'RECT', points: rectPoints({ x: 2800, y: 1800, w: 1400, h: 600, rotation: 0 }) }, seats: [1, 2, 3].map((n) => ({ seatId: `a${n}`, row: '1', number: n, x: 3000 + 100 * n, y: n === 2 ? 2050 : 2000, ...(n === 1 ? { wheelchair: true, tierId: 'R' } : {}) })) };
  const packed = packSection(section);
  assert.deepEqual(unpackSection(packed), section);
  const al = runJob({ id: 8, type: 'align', sections: [packed], ids: ['a2'], stage, canvas });
  assert.equal(al.reply.ok, true);
  const out = unpackSection(al.reply.result[0]);
  assert.deepEqual(out.seats.map((x) => [x.x, x.y]), [[3100, 2000], [3200, 2000], [3300, 2000]]);
  assert.equal(out.seats[0].wheelchair, true);
  // 모양이 틀린 메시지는 계산하지 않는다. cancel은 답하지 않는다
  assert.deepEqual(runJob({ id: 9, type: 'eval', code: '1' }).reply, { id: 9, ok: false, error: 'bad-message' });
  assert.equal(runJob({ id: 10, type: 'cancel', target: 8 }), undefined);
  const ex = runJob({ id: 11, type: 'export', format: 'CSV', doc: { canvas, stage, order: ['s1'], sections: { s1: section }, priceTiers: [] }, productionId: '0b8f1f2e-0000', version: 4 });
  assert.equal(ex.reply.result.name, 'seatmap-0b8f1f2e-v4.csv');
});
