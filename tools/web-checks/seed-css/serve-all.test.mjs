// 서버 다섯 띄우기(serve-all.mjs) 시험: 붙을 주소 넘기기와, 끌 때 셸 아래 서버(손자 프로세스)까지 끄기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseServeAllArgs, childEnv, spawnOptions, killTree, readyHost } from './serve-all.mjs';

test('도구 --host가 없으면 PEAKET_SERVE_HOST, 그것도 없으면 127.0.0.1이고 서버 자식에 PEAKET_SERVE_HOST로 넘긴다', () => {
  assert.deepEqual(parseServeAllArgs([], {}), { budgets: false, host: '127.0.0.1' });
  assert.deepEqual(parseServeAllArgs(['--budgets'], { PEAKET_SERVE_HOST: '0.0.0.0' }), { budgets: true, host: '0.0.0.0' });
  assert.deepEqual(parseServeAllArgs(['--host', '0.0.0.0', '--budgets'], { PEAKET_SERVE_HOST: '10.0.0.1' }), { budgets: true, host: '0.0.0.0' });
  assert.throws(() => parseServeAllArgs(['--nope'], {}));
  const env = childEnv({ PATH: 'p', PEAKET_SERVE_HOST: 'old' }, { A: '1' }, '0.0.0.0');
  assert.deepEqual(env, { PATH: 'p', PEAKET_SERVE_HOST: '0.0.0.0', A: '1' });
  // 준비 확인은 모든 주소(0.0.0.0·::)에 붙었으면 127.0.0.1로, IPv6 주소는 대괄호로 묶는다
  assert.equal(readyHost('0.0.0.0'), '127.0.0.1');
  assert.equal(readyHost('::'), '127.0.0.1');
  assert.equal(readyHost('172.17.0.1'), '172.17.0.1');
  assert.equal(readyHost('::1'), '[::1]');
});

test('도구 Windows는 taskkill /T /F로 셸 아래 서버까지 끄고, 그 밖은 묶음(detached)으로 띄워 묶음 전체에 신호를 보낸다', () => {
  const calls = [];
  const run = (...a) => calls.push(['run', ...a]);
  const kill = (...a) => calls.push(['kill', ...a]);
  killTree(1234, { platform: 'win32', run, kill });
  assert.deepEqual(calls, [['run', 'taskkill', ['/pid', '1234', '/T', '/F'], { stdio: 'ignore' }]]);
  calls.length = 0;
  killTree(1234, { platform: 'linux', run, kill });
  assert.deepEqual(calls, [['kill', -1234, 'SIGTERM']]);
  // 이미 끝난 묶음(ESRCH)은 넘어간다
  assert.doesNotThrow(() => killTree(1, { platform: 'linux', run, kill: () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); } }));
  // pid가 없으면(띄우지 못했다) 아무것도 하지 않는다
  calls.length = 0;
  killTree(undefined, { platform: 'win32', run, kill });
  assert.deepEqual(calls, []);
  assert.equal(spawnOptions('win32').detached, false);
  assert.equal(spawnOptions('linux').detached, true);
  assert.equal(spawnOptions('darwin').shell, true);
});
