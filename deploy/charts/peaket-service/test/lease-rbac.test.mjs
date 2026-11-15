// OPS-08 차트 검증: 리더 Lease RBAC가 create/get/update/patch를 주는지 본다(helm이 없는 환경에서도 도는 글 검사).
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const templates = new URL('../templates/', import.meta.url);
const read = (name) => readFileSync(new URL(name, templates), 'utf8');

for (const name of ['outbox-relay.yaml', 'leader-lease.yaml']) {
  test(`${name} leases create/get/update/patch`, () => {
    const s = read(name);
    assert.match(s, /resources: \["leases"\]\s*\n\s*verbs: \["create"\]/, 'leases create 규칙이 없다');
    assert.match(s, /resources: \["leases"\]\s*\n\s*resourceNames:/, '이름으로 좁힌 leases 규칙이 없다');
    assert.match(s, /verbs: \["get", "update", "patch"\]/, 'get/update/patch 권한이 없다');
  });
}
