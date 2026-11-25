// 늘 여는 흐름 autoAction 사건을 호스트 저장소에 넣는 시험(F-03-7 T18-4, C-T44 ⑦, 시험 먼저).
// 정본: docs/features/control-tower.md §12, asyncapi OpsAutoAction(이름·뜻만 정했고 본문 모양은 wbs 0.2.3),
// packages/console-contract HostState.autoActions. 구현 전 트리에는 hostActions.autoAction이 없어 실패한다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../../pages/dashboard/ui/board.test.resolve.mjs', import.meta.url);
const load = () => import('../../model/live-host.ts');
const AT = '2026-11-23T11:00:00.000Z';
const AT_MS = Date.parse(AT);
const MIN = 60_000;

test('F-03-7 T18-4 autoAction 사건은 걸린 조치를 쌓고, 같은 이름·대상은 바꾸며, 풀린 지 10분이 지나면 버린다', async () => {
  const { hostStore, hostActions, AUTO_ACTIONS_MAX } = await load();
  hostStore.setState({ autoActions: [] });
  assert.equal(AUTO_ACTIONS_MAX, 50, '들고 있는 양의 상한');
  hostActions.autoAction({ name: '실시간 표 신선도 저하', target: '전체', state: 'STUCK', startedAt: AT }, AT_MS);
  hostActions.autoAction({ name: '결제사 시험 재개', target: 'payment-svc', state: 'STUCK', startedAt: AT }, AT_MS);
  assert.equal(hostStore.getState().autoActions.length, 2);
  hostActions.autoAction({ name: '실시간 표 신선도 저하', target: '전체', state: 'CLEARED', startedAt: AT, endedAt: AT }, AT_MS + MIN);
  const after = hostStore.getState().autoActions;
  assert.equal(after.length, 2, '같은 이름·대상은 새 줄을 만들지 않는다');
  assert.equal(after.find((a) => a.name === '실시간 표 신선도 저하').state, 'CLEARED');
  hostActions.autoAction({ name: '실시간 표 신선도 저하', target: '전체', state: 'CLEARED', startedAt: AT, endedAt: AT }, AT_MS + 10 * MIN + 1);
  assert.equal(hostStore.getState().autoActions.some((a) => a.name === '실시간 표 신선도 저하'), false, '풀린 지 10분이 지나면 버린다');
});
