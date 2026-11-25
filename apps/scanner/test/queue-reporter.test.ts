// F-05-12 큐 비움 보고 앱 연결(TR-02). 정본: docs/features/offline-gate.md §7.3 '큐 비움 보고' 끝(추천 적용 2026-11-26),
// docs/review/plans/F-05-12.md §3 결정 7·§6 큐 행, architecture §8.6 4 '부르는 쪽이 결과를 쓰는지 바깥에서'.
//
// queueReportDue(api/live.ts)의 순수 규칙만 보던 시험을 대신해, 앱이 실제로 queueReport(→ PUT /v1/scanner/queue-reports/{eventId})를
// 몇 번·어느 eventId로 부르는지 센다. live-runtime.ts는 브라우저 저장소·화면과 얽혀 node --test가 읽지 못하므로,
// 그 파일이 쓰는 QueueReporter(앱 계층, 순수)를 시험한다. live-runtime이 이 조립을 실제로 쓰는지는 같은 파일의 소스 경계 시험이 본다
// (ticket-svc/test/device-key-assembly.test.ts와 같은 방식).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const MODULE = '../src/app/queue-reporter.ts';
const loaded = (await import(MODULE).catch(() => ({}))) as Partial<{
  QueueReporter: new (d: {
    api: { queueReport(eventId: string, pendingUploads: number): Promise<void> };
    eventId: () => string | undefined;
  }) => {
    reportFirstReady(pendingUploads: number): Promise<void>;
    note(i: { previousPending: number; nextPending: number }): Promise<void>;
  };
}>;

function reporterClass() {
  assert.equal(typeof loaded.QueueReporter, 'function', `${MODULE}의 QueueReporter가 없다(app이 queueReport를 실제로 부르는 조립)`);
  return loaded.QueueReporter!;
}

interface Call {
  eventId: string;
  pendingUploads: number;
}

function harness(o: { eventId?: string | undefined; failFirst?: boolean } = {}) {
  const calls: Call[] = [];
  let fail = o.failFirst === true;
  const api = {
    async queueReport(eventId: string, pendingUploads: number): Promise<void> {
      calls.push({ eventId, pendingUploads });
      if (fail) {
        fail = false;
        throw Object.assign(new Error('503'), { status: 503 });
      }
    },
  };
  // `{ eventId: undefined }`는 '회차 없음'이다. `??`로 기본값을 주면 그 경우를 만들 수 없다
  const reporter = new (reporterClass())({ api, eventId: () => ('eventId' in o ? o.eventId : 'ev-shift') });
  return { reporter, calls };
}

test('O-T29 ⑤ 첫 근무 준비·1건 이상에서 0건이 된 순간에만 PUT하고 0건이 이어지면 다시 보내지 않는다', async () => {
  const h = harness();
  // 첫 근무 준비 보고: 큐가 비어 있으면 한 번 보낸다
  await h.reporter.reportFirstReady(0);
  assert.deepEqual(h.calls, [{ eventId: 'ev-shift', pendingUploads: 0 }]);
  // 같은 '비었음'이 이어지는 동안 0회
  await h.reporter.note({ previousPending: 0, nextPending: 0 });
  await h.reporter.note({ previousPending: 0, nextPending: 0 });
  assert.equal(h.calls.length, 1);
  // 1 이상에서 0이 된 순간 한 번
  await h.reporter.note({ previousPending: 3, nextPending: 0 });
  assert.deepEqual(h.calls.at(-1), { eventId: 'ev-shift', pendingUploads: 0 });
  assert.equal(h.calls.length, 2);
  // 다시 0 유지면 0회, 다시 차면 다음 0에서 한 번
  await h.reporter.note({ previousPending: 0, nextPending: 0 });
  assert.equal(h.calls.length, 2);
  await h.reporter.note({ previousPending: 0, nextPending: 2 });
  await h.reporter.note({ previousPending: 2, nextPending: 1 });
  assert.equal(h.calls.length, 2);
  await h.reporter.note({ previousPending: 1, nextPending: 0 });
  assert.equal(h.calls.length, 3);
});

test('O-T29 ⑤ 첫 근무 준비 때 큐가 남아 있으면 실제 pendingUploads를 보내고, 그 뒤 0이 되면 한 번 더 보낸다', async () => {
  const h = harness();
  await h.reporter.reportFirstReady(4);
  assert.deepEqual(h.calls, [{ eventId: 'ev-shift', pendingUploads: 4 }]);
  await h.reporter.note({ previousPending: 4, nextPending: 0 });
  assert.deepEqual(h.calls.at(-1), { eventId: 'ev-shift', pendingUploads: 0 });
  assert.equal(h.calls.length, 2);
});

test('O-T29 ⑤ 503은 삼키고 같은 비었음에서 다시 시도해 성공하면 그때부터 0 유지에는 보내지 않는다', async () => {
  const h = harness({ failFirst: true });
  await h.reporter.reportFirstReady(0);
  assert.equal(h.calls.length, 1, '실패도 실제로 한 번 보냈다');
  // 실패는 던지지 않는다(근무 준비 화면을 막지 않는다)
  await h.reporter.note({ previousPending: 0, nextPending: 0 });
  assert.equal(h.calls.length, 2, '다음 0에서 다시 보낸다');
  await h.reporter.note({ previousPending: 0, nextPending: 0 });
  assert.equal(h.calls.length, 2, '성공한 뒤에는 0 유지에 보내지 않는다');
});

test('O-T29 ⑤ eventId는 shift의 회차이고, 회차를 모르면 PUT하지 않는다', async () => {
  const h = harness({ eventId: 'ev-shift-42' });
  await h.reporter.reportFirstReady(0);
  await h.reporter.note({ previousPending: 1, nextPending: 0 });
  assert.deepEqual(
    h.calls.map((c) => c.eventId),
    ['ev-shift-42', 'ev-shift-42'],
  );

  const none = harness({ eventId: undefined });
  await none.reporter.reportFirstReady(0);
  await none.reporter.note({ previousPending: 1, nextPending: 0 });
  assert.equal(none.calls.length, 0, '회차가 없으면 보내지 않는다');
});

test('SCR-052 실제 시작 파일(live-runtime)이 QueueReporter를 만들어 첫 근무 준비·0건 순간에 쓰고, 60초 변경분과 같은 eventId를 쓴다', () => {
  const source = readFileSync(new URL('../src/app/live-runtime.ts', import.meta.url), 'utf8');
  // 주석 속 이름에 속지 않게 주석 줄을 뺀다
  const code = source
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  assert.ok(/new QueueReporter\(/.test(code), 'live-runtime이 QueueReporter를 조립해야 한다');
  assert.ok(/reportFirstReady\(/.test(code), '근무 준비 보고 때 실제 큐 보고를 불러야 한다');
  assert.ok(/\.note\(\{/.test(code), '큐가 1건 이상에서 0건이 된 순간 실제 큐 보고를 불러야 한다');
  assert.ok(/eventId:\s*\(\)\s*=>[^\n]*#shift\?\.eventId/.test(code), 'eventId는 shift(근무 회차)에서 온다');
  assert.ok(!/queueReport\(\s*['"][^'"]+['"]/.test(code), '회차를 고정 문자열로 두지 않는다');
});
