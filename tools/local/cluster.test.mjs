// cluster.mjs의 판단 부분(Strimzi 설치 파일 고치기, 고정 판 표) 시험. 실제 클러스터는 띄우지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { PINNED, strimziInstall } from './cluster.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Strimzi 0.47.0 설치 파일의 해당 부분만 줄인 표본(실제 파일은 1MB)
const SAMPLE = `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: strimzi-cluster-operator
subjects:
  - kind: ServiceAccount
    name: strimzi-cluster-operator
    namespace: myproject
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: strimzi-cluster-operator
spec:
  template:
    spec:
      containers:
        - name: strimzi-cluster-operator
          image: quay.io/strimzi/operator:0.47.0
          env:
            - name: STRIMZI_DEFAULT_TOPIC_OPERATOR_IMAGE
              value: quay.io/strimzi/operator:0.47.0
            - name: STRIMZI_DEFAULT_KAFKA_INIT_IMAGE
              value: quay.io/strimzi/operator:0.47.0
          resources:
            limits:
              cpu: 1000m
              memory: 384Mi
            requests:
              cpu: 200m
              memory: 384Mi
`;

test('FND110_Strimzi설치파일_네임스페이스·운영자메모리·이미지다이제스트를고친다', () => {
  const out = strimziInstall(SAMPLE, 'kafka');
  const [rb, dep] = parseAllDocuments(out).map((d) => d.toJS());
  assert.equal(rb.subjects[0].namespace, 'kafka');
  const c = dep.spec.template.spec.containers[0];
  assert.equal(c.image, `quay.io/strimzi/operator@${PINNED.strimziOperatorDigest}`);
  // 384Mi에서 운영자가 메모리 초과로 죽었다(2026-11-01 kind 확인)
  assert.equal(c.resources.limits.memory, '512Mi');
  assert.equal(c.resources.requests.memory, '512Mi');
  assert.equal(out.includes('myproject'), false);
  // 운영자가 띄우는 엔티티 운영자·초기화 컨테이너의 이미지(환경 변수 값)도 다이제스트다(코드 리뷰 2026-11-01)
  assert.deepEqual(c.env.map((e) => e.value), [`quay.io/strimzi/operator@${PINNED.strimziOperatorDigest}`, `quay.io/strimzi/operator@${PINNED.strimziOperatorDigest}`]);
  assert.equal(out.includes('operator:0.47.0'), false);
});

test('FND110_Strimzi설치파일_고칠자리가없으면_조용히넘어가지않고실패한다', () => {
  assert.throws(() => strimziInstall(SAMPLE.replace('quay.io/strimzi/operator:0.47.0', 'quay.io/strimzi/operator:0.48.0'), 'kafka'), /운영자 이미지/);
  assert.throws(() => strimziInstall(SAMPLE.replaceAll('memory: 384Mi', 'memory: 1Gi'), 'kafka'), /메모리/);
});

test('FND110_고정판_kind노드·Kafka·PostgreSQL·AWS흉내이미지는_다이제스트로_고정했다', () => {
  for (const [k, v] of Object.entries(PINNED)) {
    if (k.endsWith('Digest')) assert.match(v, /^sha256:[0-9a-f]{64}$/, k);
    if (k.endsWith('Sha256')) assert.match(v, /^[0-9a-f]{64}$/, k);
  }
  const kind = readFileSync(join(REPO, 'deploy', 'local', 'kind.yaml'), 'utf8');
  assert.match(kind, /image: kindest\/node:v1\.35\.8@sha256:[0-9a-f]{64}/);
  for (const f of ['kafka.yaml', 'postgres.yaml', 'aws.yaml']) {
    const text = readFileSync(join(REPO, 'deploy', 'local', f), 'utf8');
    for (const m of text.matchAll(/^\s*image: (\S+)/gm)) assert.match(m[1], /@sha256:[0-9a-f]{64}$/, `${f}: ${m[1]}`);
  }
});
