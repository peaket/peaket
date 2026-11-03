// 발생기 파드가 준비되지 않았을 때 그 까닭을 읽는 부분(loadtest/runner/manifests.mjs의 podNotReadyReason) 시험.
// 2026-11-03 러너의 A/A 실행은 발생기 파드가 CPU 자리를 잡지 못해 300초를 기다린 뒤 'timed out waiting for the condition'만 남기고 실패했다.
// 까닭(스케줄러의 자리 없음·이미지 받기 실패 등)이 오류 글에 남는지 본다. 클러스터는 건드리지 않는다.
// 다시 돈 A/A는 4회째에 측정 뒤 기록 읽기(앱 파드 안 관리 스크립트)가 대기열 Redis에 5초 안에 붙지 못해 멈췄다. 관리 스크립트의 연결 마감과
// 실패할 때 붙이는 파드 상태(다시 시작·직전 종료 까닭)도 본다.
// 실행: node --test loadtest/test/pod-wait.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as manifests from '../runner/manifests.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const reason = (pod) => manifests.podNotReadyReason(pod);

test('BSL090_D-T40_자리를잡지못한파드_단계와스케줄러의글(Insufficient cpu)이남는다', () => {
  const msg = '0/1 nodes are available: 1 Insufficient cpu. preemption: 0/1 nodes are available: 1 No preemption victims found for incoming pod.';
  const r = reason({ status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: msg }] } });
  assert.match(r, /Pending/);
  assert.match(r, /PodScheduled/);
  assert.match(r, /Unschedulable/);
  assert.match(r, /Insufficient cpu/);
});

test('BSL090_D-T40_이미지를받지못한파드_컨테이너이름과기다리는까닭·글이남고_참인조건은빠진다', () => {
  const r = reason({
    status: {
      phase: 'Pending',
      conditions: [
        { type: 'PodScheduled', status: 'True' },
        { type: 'Ready', status: 'False', reason: 'ContainersNotReady', message: 'containers with unready status: [k6]' },
      ],
      containerStatuses: [{ name: 'k6', ready: false, state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image "grafana/k6:1.4.2"' } } }],
    },
  });
  assert.match(r, /k6/);
  assert.match(r, /ImagePullBackOff/);
  assert.match(r, /Back-off pulling image/);
  assert.doesNotMatch(r, /PodScheduled/);
});

test('BSL090_D-T40_끝나버린컨테이너_끝난까닭이남는다', () => {
  const r = reason({ status: { phase: 'Failed', containerStatuses: [{ name: 'k6', state: { terminated: { reason: 'OOMKilled', exitCode: 137 } } }] } });
  assert.match(r, /Failed/);
  assert.match(r, /OOMKilled/);
});

test('BSL090_D-T40_상태가없거나비면_까닭을알수없다고말한다', () => {
  for (const pod of [undefined, null, {}, { status: {} }, { status: { conditions: [], containerStatuses: [] } }]) {
    const r = reason(pod);
    assert.equal(typeof r, 'string');
    assert.ok(r.length > 0, JSON.stringify(pod));
  }
});

test('BSL090_D-T40_까닭은_1000자를넘지않는다(오류글이너무길어지지않게)', () => {
  const long = 'x'.repeat(5000);
  const r = reason({ status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: long }] } });
  assert.ok(r.length <= 1000, String(r.length));
  assert.match(r, /Unschedulable/);
});

test('BSL090_D-T40_다시시작한컨테이너_횟수와직전종료까닭·종료코드가남는다', () => {
  const r = reason({
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [
        { name: 'valkey', ready: true, restartCount: 1, state: { running: {} }, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: '2026-11-03T13:47:58Z' } } },
        { name: 'sidecar', ready: true, restartCount: 0, state: { running: {} } },
      ],
    },
  });
  assert.match(r, /Running/);
  assert.match(r, /valkey/);
  assert.match(r, /다시 시작 1번/);
  assert.match(r, /OOMKilled/);
  assert.match(r, /137/);
  assert.doesNotMatch(r, /sidecar/);
});

test('BSL090_D-T40_앱파드안관리스크립트는_대기열Redis에붙는마감을_앱시작마감보다길게준다', () => {
  const run = readFileSync(join(REPO, 'loadtest', 'run.mjs'), 'utf8');
  const calls = [...run.matchAll(/createV0Redis\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, '관리 스크립트(회차 열기·serving 기록 읽기)가 createV0Redis를 부른다');
  for (const args of calls) assert.match(args, /startupTimeoutMs: \$\{ADMIN_REDIS_STARTUP_MS\}/, args);
  const ms = (text, name) => Number(new RegExp(`const ${name} = ([0-9_]+);`).exec(text)?.[1].replaceAll('_', ''));
  const admin = ms(run, 'ADMIN_REDIS_STARTUP_MS');
  const app = ms(readFileSync(join(REPO, 'services', 'v0-monolith', 'src', 'redis.ts'), 'utf8'), 'REDIS_STARTUP_TIMEOUT_MS');
  assert.ok(app > 0, '앱 시작 마감을 읽는다');
  assert.ok(admin >= app * 4, `관리 스크립트 ${admin}ms, 앱 시작 ${app}ms`);
});

test('BSL090_D-T40_앱파드안스크립트가실패하면_앱과대기열Redis파드의상태를오류에붙인다', () => {
  const run = readFileSync(join(REPO, 'loadtest', 'run.mjs'), 'utf8');
  const body = /export async function inAppPod\([\s\S]*?\n\}\n/.exec(run)?.[0] ?? '';
  assert.match(body, /catch/);
  assert.match(body, /podsNote\(/);
  assert.match(body, /APP_SELECTOR/);
  assert.match(body, /VALKEY_SELECTOR/);
});
