// OPS-08 차트 회귀: Lease create 권한은 이름으로 좁힐 수 없으므로 별도 규칙이어야 하고,
// 읽기·고치기·패치는 차트가 미리 만든 Lease 이름으로 좁혀야 한다. helm이 없어 템플릿 글을 검사한다.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const templates = new URL('../templates/', import.meta.url);
const read = (name) => readFileSync(new URL(name, templates), 'utf8');

const CREATE = /- apiGroups: \["coordination\.k8s\.io"\]\s*\n\s*resources: \["leases"\]\s*\n\s*verbs: \["create"\]/;
const SCOPED = /- apiGroups: \["coordination\.k8s\.io"\]\s*\n\s*resources: \["leases"\]\s*\n\s*resourceNames: ([^\n]+)\n\s*verbs: \["get", "update", "patch"\]/;

for (const name of ['outbox-relay.yaml', 'leader-lease.yaml']) {
  test(`${name}는 create를 이름 없는 별도 규칙으로, get/update/patch를 이름 한정 규칙으로 준다`, () => {
    const s = read(name);
    const create = s.match(CREATE);
    assert.ok(create, 'leases create 규칙이 없다');
    assert.ok(!/resourceNames/.test(create[0]), 'create 규칙에 resourceNames를 붙였다(create는 이름으로 좁힐 수 없다)');

    const scoped = s.match(SCOPED);
    assert.ok(scoped, 'leases get/update/patch를 이름으로 좁힌 규칙이 없다');
    assert.match(scoped[1], /\$(relay|leases)/, '이름 한정 규칙이 Lease 이름 변수를 가리키지 않는다');

    assert.match(s, /kind: RoleBinding/);
    assert.match(s, /subjects:/);
    assert.match(s, /kind: ServiceAccount/);
  });
}

test('outbox-relay는 만든 Lease와 같은 이름으로 권한을 좁힌다', () => {
  const s = read('outbox-relay.yaml');
  assert.match(s, /name: \{\{ \$relay \}\}/, '미리 만든 Lease 이름이 없다');
  assert.match(s, /resourceNames: \[\{\{ \$relay \| quote \}\}\]/, '권한 이름이 Lease 이름과 다르다');
});

test('leader-lease는 leaderLeases 목록을 Lease와 권한에 함께 쓴다', () => {
  const s = read('leader-lease.yaml');
  assert.match(s, /\$leases := include "peaket\.leaderLeases" \. \| fromJsonArray/);
  assert.match(s, /name: \{\{ \. \}\}/, '미리 만든 Lease 이름이 없다');
  assert.match(s, /resourceNames: \{\{ toJson \$leases \}\}/, '권한 이름이 leaderLeases 목록과 다르다');
});
