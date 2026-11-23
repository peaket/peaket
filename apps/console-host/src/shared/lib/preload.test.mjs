// 화면 덩어리 미리 받기(F-03-2 OPS-360 T10, FE-T25). 정본: ADR-0091 결정 1 '미리 받기'(대시보드를 처음 그린 뒤 2초 [가정]가 지나면 명령 화면(SCR-030)
// 덩어리를 낮은 우선순위로 받는다, 메뉴 항목에 포인터가 올라가거나 초점이 가면 그 화면의 lazy를 미리 부른다), docs/frontend.md §5.7 '화면별 늦게 싣기',
// ADR-0361 결정 6. 경계는 Node 가짜 시계(mock.timers)로 1,999·2,000ms 양쪽을 본다. 화면 덩어리 받기는 넘겨받은 lazy 대역으로 센다.
// 실제 운영 빌드의 낮은 우선순위·원격 미리 싣기의 무결성은 tools/web-checks/console-remotes/preload.spec.mjs가 본다. 모듈 상태가 전역이라 파일 하나에 차례로 둔다.
import { register } from 'node:module';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

register('../api/live/live.test.resolve.mjs', import.meta.url);
globalThis.__CONSOLE_BUILD__ = 'mf';
const { preloadScreen, registerScreenPreloads, scheduleDashboardPreload } = await import('./preload.ts');

const PRELOAD_MS = 2_000;
const drain = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};

const calls = { commands: 0, audit: 0, settlements: 0 };
registerScreenPreloads(
  {
    '/audit': async () => void (calls.audit += 1),
    '/settlements': async () => void (calls.settlements += 1),
  },
  async () => void (calls.commands += 1),
);

test('F-03-2 T10 FE-T25 ① 대시보드를 그린 뒤 2초에 명령 화면 덩어리를 한 번 받고(1,999ms에는 없음), 그 전에 떠나면 받지 않는다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // 2초 전에 떠남: 지우면 받지 않는다
    const cancel = scheduleDashboardPreload({ live: false });
    mock.timers.tick(PRELOAD_MS - 1);
    cancel();
    mock.timers.tick(10 * PRELOAD_MS);
    await drain();
    assert.equal(calls.commands, 0);
    // 다시 돌아와 처음 그리면 다시 건다
    scheduleDashboardPreload({ live: false });
    mock.timers.tick(PRELOAD_MS - 1);
    await drain();
    assert.equal(calls.commands, 0, '1,999ms에는 아직');
    mock.timers.tick(1);
    await drain();
    assert.equal(calls.commands, 1, '2,000ms에 한 번');
    // 한 번 받은 뒤에는 대시보드를 다시 그려도 다시 받지 않는다
    scheduleDashboardPreload({ live: false })();
    scheduleDashboardPreload({ live: false });
    mock.timers.tick(10 * PRELOAD_MS);
    await drain();
    assert.equal(calls.commands, 1);
  } finally {
    mock.timers.reset();
  }
});

test('F-03-2 T10 FE-T25 ② 메뉴 위 미리 부르기는 같은 출처의 아는 화면 주소만 그 화면 lazy를 부른다', async () => {
  preloadScreen('/audit');
  preloadScreen('/audit?tab=x');
  preloadScreen('https://evil.example/settlements');
  preloadScreen('//evil.example/settlements');
  preloadScreen('/no-such-screen');
  await drain();
  assert.deepEqual({ audit: calls.audit, settlements: calls.settlements }, { audit: 2, settlements: 0 });
});
