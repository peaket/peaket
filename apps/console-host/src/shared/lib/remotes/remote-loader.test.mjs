// 원격 위젯 적재기 단위 시험(F-03-2 OPS-350 T1·T2·T3·T10·T18, FE-T17). 브라우저 손잡이(스크립트 넣기·전역 컨테이너·시계·목록 받기)를 대역으로 넘긴다.
// 정본: docs/frontend.md §4.5 '싣는 순서'(목록 → 계약 판 확인(다르면 받지 않는다) → integrity 스크립트(시간 초과 5초 [가정]) → 실패하면 한 번 다시 →
// 또 실패하면 대체, 판 불일치·목록 거절·정책 거절은 다시 받지 않는다, [다시 시도]는 목록부터), §5.7 '원격 실패'(마지막 실패에 한 번 센다),
// ADR-0091 결정 1·ADR-0361 결정 6(미리 싣기도 같은 적재기를 거친다), ADR-0361 결정 5(이미 실패한 원격을 미리 싣기가 다시 받지 않는다).
// 대역은 브라우저 경계(스크립트 요소·전역 컨테이너)만이고 적재 순서·다시 받기·까닭 판단은 진짜 remote-loader.ts다. 실제 브라우저 쪽은 tools/web-checks/console-remotes/가 본다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../api/live/live.test.resolve.mjs', import.meta.url);
const { createRemoteLoader, RemoteLoadError } = await import('./remote-loader.ts');

/** 정본 값(코드 상수를 옮기지 않는다): 진입 파일 시간 초과 5초 [가정], 한 번 다시(§4.5) */
const TIMEOUT_MS = 5_000;
const SHA = { queue: '1a2b3c4d5e6f', purchase: '6f5e4d3c2b1a' };
const SRI = { queue: `sha384-${'Q'.repeat(64)}`, purchase: `sha384-${'P'.repeat(64)}` };
const entryOf = (name) => `/remotes/${name}/${SHA[name]}/remoteEntry.js`;
const CONTAINER = { queue: 'peaket_widget_queue', purchase: 'peaket_widget_purchase' };

const drain = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

/** 가짜 시계: advance가 그 사이 타이머를 차례로 부른다 */
class FakeTimers {
  now = 0;
  #q = [];
  #id = 0;
  setTimeout = (fn, ms) => {
    this.#id += 1;
    this.#q.push({ h: this.#id, at: this.now + ms, fn });
    return this.#id;
  };
  clearTimeout = (h) => {
    this.#q = this.#q.filter((t) => t.h !== h);
  };
  async advance(ms) {
    const end = this.now + ms;
    for (;;) {
      await drain();
      const due = this.#q.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.h - b.h)[0];
      if (!due) break;
      this.#q = this.#q.filter((t) => t !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = end;
    await drain();
  }
}

/**
 * 브라우저 대역: 스크립트 요청마다 정한 결과(ok·integrity·network·hang·noContainer)를 차례로 낸다.
 * ok는 전역 컨테이너를 만든 뒤 onload, integrity는 바이트를 받았지만 실행하지 않고 onerror(컨테이너 없음), hang은 아무것도 하지 않는다.
 */
function world(o = {}) {
  const timers = new FakeTimers();
  const globals = new Map();
  const scripts = [];
  const failures = [];
  const plan = { queue: [...(o.queue ?? [])], purchase: [...(o.purchase ?? [])] };
  let lastKind = 'network';
  let listCalls = 0;
  const list = o.list ?? [
    { name: 'queue', sha: SHA.queue, entry: entryOf('queue'), integrity: SRI.queue, contractMajor: o.listMajor ?? 1 },
    { name: 'purchase', sha: SHA.purchase, entry: entryOf('purchase'), integrity: SRI.purchase, contractMajor: 1 },
  ];
  const widgetMajor = o.widgetMajor ?? 1;
  const makeContainer = (name) => ({
    inits: 0,
    async init() {
      this.inits += 1;
      if (o.initError) throw new Error(o.initError);
    },
    async get(mod) {
      assert.equal(mod, './widgets');
      return () => ({ widgets: [{ name: `${name}-w`, contractMajor: widgetMajor, title: 't', permissions: ['ops:read'], refresh: 'subscription', load: async () => ({ default: `${name}-component` }) }] });
    },
  });
  const deps = {
    async fetchList() {
      listCalls += 1;
      if (o.listFails) throw new Error('HTTP 503');
      return structuredClone(list);
    },
    insertScript(r, allowed) {
      if (o.policyThrows) throw new TypeError(`원격 목록에 없는 주소: ${r.src}`);
      const name = r.src.split('/')[2];
      const kind = plan[name]?.shift() ?? 'ok';
      const s = { name, src: r.src, integrity: r.integrity, priority: r.priority, allowed: [...allowed].sort(), removed: false, kind, r };
      scripts.push(s);
      queueMicrotask(() => {
        if (kind === 'ok') {
          globals.set(CONTAINER[name], makeContainer(name));
          r.onload();
        } else if (kind === 'noContainer') r.onload();
        else if (kind === 'integrity' || kind === 'network') {
          lastKind = kind;
          r.onerror();
        }
      });
      return { remove: () => (s.removed = true) };
    },
    container: (n) => globals.get(n),
    shareScope: async () => ({ default: {} }),
    timers,
    classifyError: () => lastKind,
    onFailure: (remote, reason) => failures.push({ remote, reason }),
    ...(o.hostMajor !== undefined ? { hostMajor: o.hostMajor } : {}),
  };
  const loader = createRemoteLoader(deps);
  return { loader, timers, scripts, failures, globals, listCalls: () => listCalls, makeContainer };
}

const reasonOf = async (p) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof RemoteLoadError, `RemoteLoadError가 아니다: ${e}`);
    return { remote: e.remote, reason: e.reason };
  }
  assert.fail('실패해야 한다');
};

test('F-03-2 T1 FE-T17 ① 무결성이 처음 틀리고 다시 받아 맞으면 위젯을 싣고 실패로 세지 않는다(진입 파일 요청 2번, 목록의 integrity 그대로)', async () => {
  const w = world({ queue: ['integrity', 'ok'] });
  const ws = await w.loader.loadRemoteWidgets('queue');
  assert.deepEqual(ws.map((x) => x.name), ['queue-w']);
  const q = w.scripts.filter((s) => s.name === 'queue');
  assert.equal(q.length, 2);
  for (const s of q) {
    assert.equal(s.src, '/remotes/queue/1a2b3c4d5e6f/remoteEntry.js');
    assert.equal(s.integrity, SRI.queue);
    // 정책이 통과시키는 주소는 읽은 목록의 정식 주소뿐이다
    assert.deepEqual(s.allowed, ['/remotes/purchase/6f5e4d3c2b1a/remoteEntry.js', '/remotes/queue/1a2b3c4d5e6f/remoteEntry.js']);
  }
  assert.equal(q[0].removed, true, '실패한 스크립트 요소는 치운다');
  assert.deepEqual(w.failures, []);
});

test('F-03-2 T1 FE-T17 ② 무결성이 두 번 틀리면 그 원격만 integrity로 실패하고(요청 정확히 2번, 실패 수 1), 다른 원격은 싣는다', async () => {
  const w = world({ queue: ['integrity', 'integrity'] });
  const [q, p] = await Promise.allSettled([w.loader.loadRemoteWidget('queue', 'queue-w'), w.loader.loadRemoteWidget('purchase', 'purchase-w')]);
  assert.equal(q.status, 'rejected');
  assert.deepEqual({ remote: q.reason.remote, reason: q.reason.reason }, { remote: 'queue', reason: 'integrity' });
  assert.equal(p.status, 'fulfilled');
  assert.equal(p.value, 'purchase-component');
  assert.equal(w.scripts.filter((s) => s.name === 'queue').length, 2);
  assert.equal(w.scripts.filter((s) => s.name === 'purchase').length, 1);
  assert.equal(w.globals.has(CONTAINER.queue), false, '위조 바이트는 실행되지 않았다(전역 컨테이너 없음)');
  assert.deepEqual(w.failures, [{ remote: 'queue', reason: 'integrity' }]);
  // 목록은 한 번 읽어 두 원격이 함께 쓴다
  assert.equal(w.listCalls(), 1);
});

test('F-03-2 T1 FE-T17 ③ 네트워크 실패·컨테이너 없음도 한 번 다시 받고, 같은 원격의 동시 요청은 하나로 묶는다', async () => {
  const w = world({ queue: ['network', 'network'], purchase: ['noContainer', 'noContainer'] });
  const a = w.loader.loadRemoteWidgets('queue');
  const b = w.loader.loadRemoteWidgets('queue');
  const c = w.loader.loadRemoteWidgets('purchase');
  assert.deepEqual(await reasonOf(a), { remote: 'queue', reason: 'network' });
  assert.deepEqual(await reasonOf(b), { remote: 'queue', reason: 'network' });
  assert.deepEqual(await reasonOf(c), { remote: 'purchase', reason: 'container' });
  assert.equal(w.scripts.filter((s) => s.name === 'queue').length, 2, '동시 둘이어도 한 적재(처음 + 한 번 다시)');
  assert.equal(w.scripts.filter((s) => s.name === 'purchase').length, 2);
  assert.deepEqual(w.failures, [
    { remote: 'queue', reason: 'network' },
    { remote: 'purchase', reason: 'container' },
  ]);
});

test('F-03-2 T1 FE-T17 ④ 실패 뒤 [다시 시도](보통 호출)는 목록부터 새로 읽고 다시 받아 성공하면 위젯을 싣는다', async () => {
  const w = world({ queue: ['integrity', 'integrity', 'ok'] });
  assert.deepEqual(await reasonOf(w.loader.loadRemoteWidgets('queue')), { remote: 'queue', reason: 'integrity' });
  assert.equal(w.listCalls(), 1);
  const ws = await w.loader.loadRemoteWidgets('queue');
  assert.deepEqual(ws.map((x) => x.name), ['queue-w']);
  assert.equal(w.listCalls(), 2, '[다시 시도]는 목록부터');
  assert.equal(w.scripts.filter((s) => s.name === 'queue').length, 3);
  assert.deepEqual(w.failures, [{ remote: 'queue', reason: 'integrity' }]);
});

test('F-03-2 T2 FE-T17 ① 진입 파일이 5초 안에 안 오면 버리고 한 번 다시 받는다(4,999ms에는 그대로, 5,000ms에 두 번째)', async () => {
  const w = world({ queue: ['hang', 'ok'] });
  const p = w.loader.loadRemoteWidgets('queue');
  await w.timers.advance(TIMEOUT_MS - 1);
  assert.equal(w.scripts.length, 1);
  assert.equal(w.scripts[0].removed, false);
  await w.timers.advance(1);
  assert.equal(w.scripts.length, 2);
  assert.equal(w.scripts[0].removed, true, '시간 초과한 요소는 치운다');
  assert.deepEqual((await p).map((x) => x.name), ['queue-w']);
  assert.deepEqual(w.failures, []);
});

test('F-03-2 T2 FE-T17 ② 다시 받기도 5초를 넘으면 timeout으로 실패하고 한 번 세며, 늦게 온 첫 응답이 실행돼도 그 적재는 실패로 남는다', async () => {
  const w = world({ queue: ['hang', 'hang'] });
  let settled = null;
  const p = w.loader.loadRemoteWidget('queue', 'queue-w').then(
    () => (settled = 'ok'),
    (e) => (settled = e),
  );
  await w.timers.advance(TIMEOUT_MS);
  assert.equal(w.scripts.length, 2);
  await w.timers.advance(TIMEOUT_MS - 1);
  assert.equal(settled, null, '두 번째도 4,999ms에는 아직');
  await w.timers.advance(1);
  await p;
  assert.ok(settled instanceof RemoteLoadError);
  assert.equal(settled.reason, 'timeout');
  assert.deepEqual(w.failures, [{ remote: 'queue', reason: 'timeout' }]);
  // 늦게 온 첫 응답(무결성을 거쳐 실행됨)이 컨테이너를 만들고 onload를 불러도 끝난 적재는 그대로다
  w.globals.set(CONTAINER.queue, w.makeContainer('queue'));
  w.scripts[0].r.onload();
  await drain();
  assert.equal(w.scripts.length, 2, '늦은 응답이 새 요청을 부르지 않는다');
  assert.deepEqual(w.failures, [{ remote: 'queue', reason: 'timeout' }], '다시 세지 않는다');
});

test('F-03-2 T3 FE-T17 ① 목록의 contractMajor가 호스트와 다르면 그 원격 요청이 0이고 contract로 한 번 센다(다시 받지 않는다)', async () => {
  // 시험 값은 코드 상수와 다르게: 호스트 3, 목록 2
  const w = world({ hostMajor: 3, listMajor: 2, list: [
    { name: 'queue', sha: SHA.queue, entry: entryOf('queue'), integrity: SRI.queue, contractMajor: 2 },
    { name: 'purchase', sha: SHA.purchase, entry: entryOf('purchase'), integrity: SRI.purchase, contractMajor: 3 },
  ], widgetMajor: 3 });
  assert.deepEqual(await reasonOf(w.loader.loadRemoteWidgets('queue')), { remote: 'queue', reason: 'contract' });
  assert.equal(w.scripts.filter((s) => s.name === 'queue').length, 0);
  assert.equal(await w.loader.loadRemoteWidget('purchase', 'purchase-w'), 'purchase-component');
  assert.deepEqual(w.failures, [{ remote: 'queue', reason: 'contract' }]);
});

test('F-03-2 T3 FE-T17 ② 실은 위젯 정보의 contractMajor가 다르면 그 위젯을 싣지 않고 contract다', async () => {
  const w = world({ widgetMajor: 2 });
  assert.deepEqual(await reasonOf(w.loader.loadRemoteWidget('queue', 'queue-w')), { remote: 'queue', reason: 'contract' });
  assert.equal(w.scripts.length, 1, '진입 파일은 받았고 다시 받지 않는다');
  assert.deepEqual(w.failures, [{ remote: 'queue', reason: 'contract' }]);
});

test('F-03-2 T18 FE-T17 공유 싱글턴(계약 패키지) 판이 strictVersion 범위 밖이면(webpack Unsatisfied version) 그 원격만 contract다', async () => {
  const w = world({ initError: 'Unsatisfied version 1.0.0 from peaket_console_host of shared singleton module @peaket/console-contract (required ^2.0.0)' });
  assert.deepEqual(await reasonOf(w.loader.loadRemoteWidgets('queue')), { remote: 'queue', reason: 'contract' });
  assert.deepEqual(w.failures, [{ remote: 'queue', reason: 'contract' }]);
});

test('F-03-2 T5 FE-T39 ① 정책이 주소를 거절하면 policy로 실패하고 다시 받지 않는다', async () => {
  const w = world({ policyThrows: true });
  assert.deepEqual(await reasonOf(w.loader.loadRemoteWidgets('queue')), { remote: 'queue', reason: 'policy' });
  assert.deepEqual(w.failures, [{ remote: 'queue', reason: 'policy' }]);
});

test('F-03-2 T4 목록을 못 읽거나 그 항목이 거절되면 list로 실패하고 요청이 없으며, 나머지 원격은 싣는다', async () => {
  const down = world({ listFails: true });
  assert.deepEqual(await reasonOf(down.loader.loadRemoteWidgets('queue')), { remote: 'queue', reason: 'list' });
  assert.equal(down.scripts.length, 0);
  // 목록 밖 진입 주소(쿼리를 붙임)는 항목 검사가 그 원격만 거절한다(F-03-1 검증 덧14)
  const bad = world({ list: [
    { name: 'queue', sha: SHA.queue, entry: `${entryOf('queue')}?x=1`, integrity: SRI.queue, contractMajor: 1 },
    { name: 'purchase', sha: SHA.purchase, entry: entryOf('purchase'), integrity: SRI.purchase, contractMajor: 1 },
  ] });
  assert.deepEqual(await reasonOf(bad.loader.loadRemoteWidgets('queue')), { remote: 'queue', reason: 'list' });
  assert.equal((await bad.loader.loadRemoteWidgets('purchase')).length, 1);
  assert.equal(bad.scripts.filter((s) => s.name === 'queue').length, 0, '거절된 원격 요청 0');
  assert.deepEqual(bad.scripts.find((s) => s.name === 'purchase').allowed, ['/remotes/purchase/6f5e4d3c2b1a/remoteEntry.js'], '정책 허용 목록에 거절 항목이 없다');
});

test('F-03-2 T10 FE-T17 ① 미리 싣기(낮은 우선순위)도 같은 적재기라 위조 원격은 실행되지 않고 integrity로 한 번 센다', async () => {
  const w = world({ queue: ['integrity', 'integrity'] });
  assert.deepEqual(await reasonOf(w.loader.loadRemoteWidgets('queue', { priority: 'low' })), { remote: 'queue', reason: 'integrity' });
  const q = w.scripts.filter((s) => s.name === 'queue');
  assert.equal(q.length, 2);
  assert.deepEqual(q.map((s) => [s.priority, s.integrity]), [
    ['low', SRI.queue],
    ['low', SRI.queue],
  ]);
  assert.equal(w.globals.has(CONTAINER.queue), false);
  assert.deepEqual(w.failures, [{ remote: 'queue', reason: 'integrity' }]);
});

test('F-03-2 T10 FE-T17 ② 이미 마지막에 실패한 원격을 미리 싣기가 다시 받지 않고 다시 세지 않으며, [다시 시도]만 새로 받는다', async () => {
  const w = world({ queue: ['integrity', 'integrity', 'ok'] });
  assert.deepEqual(await reasonOf(w.loader.loadRemoteWidget('queue', 'queue-w')), { remote: 'queue', reason: 'integrity' });
  assert.deepEqual(await reasonOf(w.loader.loadRemoteWidgets('queue', { priority: 'low' })), { remote: 'queue', reason: 'integrity' });
  assert.equal(w.listCalls(), 1, '미리 싣기는 목록을 다시 읽지 않는다');
  assert.equal(w.scripts.filter((s) => s.name === 'queue').length, 2, '미리 싣기는 다시 받지 않는다');
  assert.deepEqual(w.failures, [{ remote: 'queue', reason: 'integrity' }], '실패 수는 1 그대로');
  // 사람이 누른 [다시 시도]
  assert.equal(await w.loader.loadRemoteWidget('queue', 'queue-w'), 'queue-component');
  assert.equal(w.scripts.filter((s) => s.name === 'queue').length, 3);
  assert.equal(w.scripts.at(-1).priority, undefined, '[다시 시도]는 보통 우선순위');
});

test('F-03-2 T10 FE-T17 ③ 이미 실은 원격을 미리 싣기가 부르면 진입 파일을 다시 받지 않는다', async () => {
  const w = world();
  await w.loader.loadRemoteWidget('queue', 'queue-w');
  await w.loader.loadRemoteWidgets('queue', { priority: 'low' });
  assert.equal(w.scripts.filter((s) => s.name === 'queue').length, 1);
  assert.equal(w.globals.get(CONTAINER.queue).inits, 1, '공유 범위는 한 번만 연다');
});
