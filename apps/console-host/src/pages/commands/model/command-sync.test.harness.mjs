// 명령 화면 다시 읽기 시험(command-sync-*.test.mjs, F-03-4 T11)이 함께 쓰는 무대(시험 전용). 이름이 *.test.mjs로 끝나지 않아 시험 파일로 돌지 않는다.
// 호스트가 연 늘 여는 흐름(connection.ts startLive, 가짜 SSE)과 가짜 관제 REST(shared/api/live/live.test.fakes.mjs)를 쓰고,
// 화면 쪽 다시 읽기 모듈 model/command-sync.ts의 syncCommands({ role, onList, onDetail })를 붙인다.
// 서버 쪽 값(server.list·server.details)을 바꾸면 다음 REST 응답이 바뀐다. 사건 본문은 0028 트리거 꼴(commandId·type·state·eventId·approvalExpiresAt)이다.
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { fakeOpsApi, drain, json } from '../../../shared/api/live/live.test.fakes.mjs';
import { E } from './commands.test.fakes.mjs';

export { drain };

/** 상세 GET 경로 */
export const detailPath = (id) => `/v1/ops/commands/${id}`;

export async function syncHarness({ role = 'operator', list = [], details = {} } = {}) {
  mock.timers.enable({ apis: ['setTimeout'] });
  mock.method(Math, 'random', () => 0);
  const api = fakeOpsApi();
  const server = { list: [...list], details: { ...details } };
  api.on('GET', '/v1/ops/commands', () => json(200, { items: server.list, nextCursor: null }));
  for (const id of Object.keys(details)) api.on('GET', detailPath(id), () => json(200, server.details[id]));
  api.install();
  const c = await import('../../../shared/api/live/connection.ts');
  c.startLive({ origin: 'https://ops-api.test', screen: 'commands', onUnauthorized: () => assert.fail('로그인으로 가면 안 된다') });
  c.setLiveEvent(E, 'commands');
  await drain();
  const live = api.live().at(-1);
  assert.ok(live, '늘 여는 흐름이 열리지 않았다');
  live.stream.push('retry: 10000\nid: 1\n\n');
  await drain();
  const mod = await import('./command-sync.ts');
  assert.equal(typeof mod.syncCommands, 'function', 'command-sync.ts에 syncCommands가 없다');
  const lists = [];
  const shown = [];
  const sync = mod.syncCommands({ role, onList: (p) => lists.push(p), onDetail: (d) => shown.push(d) });
  await drain();
  let seq = 10;
  return {
    api,
    server,
    sync,
    lists,
    shown,
    mod,
    /** 그 명령 상세 GET 수 */
    detailGets: (id) => api.requests.filter((r) => r.method === 'GET' && r.path === detailPath(id)).length,
    /** 화면 목록 GET 수(호스트의 승인 대기 다시 읽기 state=PENDING_APPROVAL,REVERT_PENDING은 뺀다) */
    listGets: () => api.requests.filter((r) => r.method === 'GET' && r.path === '/v1/ops/commands' && r.query.state === undefined).length,
    /** 흐름 사건 하나를 민다 */
    async push(event, data) {
      seq += 1;
      live.stream.push(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      await drain();
    },
    async tick(ms) {
      mock.timers.tick(ms);
      await drain();
    },
    stop() {
      sync.stop();
      c.stopLive();
    },
  };
}
