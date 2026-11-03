// 발생기 파드가 준비되지 않았을 때 그 까닭을 읽는 부분(loadtest/runner/manifests.mjs의 podNotReadyReason) 시험.
// 2026-11-03 러너의 A/A 실행은 발생기 파드가 CPU 자리를 잡지 못해 300초를 기다린 뒤 'timed out waiting for the condition'만 남기고 실패했다.
// 까닭(스케줄러의 자리 없음·이미지 받기 실패 등)이 오류 글에 남는지 본다. 클러스터는 건드리지 않는다.
// 실행: node --test loadtest/test/pod-wait.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as manifests from '../runner/manifests.mjs';

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
