// BAT-450B 계약·라우트·메시 정적 확인(BUILD_ORDER BAT-450B, ADR-0353).
// 1) openapi 네 작업이 내는 404·409·422·503을 계약에 적는지, 2) gw-partner가 그 네 작업을 identity-svc로 보내는지,
// 3) core-svc REST 부르는 쪽에 identity-svc가 있는지, 4) 생성 라우트도 같은지를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, parseAllDocuments } from 'yaml';

const repo = new URL('../../', import.meta.url);
const spec = parse(readFileSync(new URL('docs/api/openapi.yaml', repo), 'utf8'));
const Y = (p) => parseAllDocuments(readFileSync(new URL(p, repo), 'utf8')).map((d) => d.toJS()).filter(Boolean);

const CREATE = '/v1/partner/events/{eventId}/staff-invitations';
const LIST = '/v1/partner/events/{eventId}/staff';
const REVOKE = '/v1/partner/staff/{assignmentId}';
const REISSUE = '/v1/partner/staff/{assignmentId}/invitation';

test('BAT-450B 파트너 초대 네 작업이 404·409·422·503을 계약에 적는다', () => {
  const types = spec['x-peaket-problem-types'].types;
  assert.equal(types['staff-invitation-duplicate']?.status, 422);
  assert.equal(types['staff-invitation-already-accepted']?.status, 409);
  assert.equal(types['authz-unavailable']?.status, 503);

  const create = spec.paths[CREATE]?.post?.responses;
  assert.ok(create, `${CREATE} POST`);
  for (const status of ['201', '400', '404', '422', '503']) assert.ok(create[status], `${CREATE} ${status}`);
  const list = spec.paths[LIST]?.get?.responses;
  assert.ok(list, `${LIST} GET`);
  for (const status of ['200', '400', '404', '503']) assert.ok(list[status], `${LIST} ${status}`);
  const revoke = spec.paths[REVOKE]?.delete?.responses;
  assert.ok(revoke, `${REVOKE} DELETE`);
  for (const status of ['204', '404', '503']) assert.ok(revoke[status], `${REVOKE} ${status}`);
  const reissue = spec.paths[REISSUE]?.post?.responses;
  assert.ok(reissue, `${REISSUE} POST`);
  for (const status of ['200', '404', '409', '503']) assert.ok(reissue[status], `${REISSUE} ${status}`);
  assert.equal(spec.paths[CREATE].post.requestBody.content['application/json'].schema.properties.invitations.minItems, 1);
});

test('BAT-450B gw-partner 원천이 초대 네 경로를 identity-svc로 보내고 core-svc에는 두지 않는다', () => {
  const docs = Y('deploy/gateways/routes/gw-partner.yaml');
  const api = docs.find((d) => d.kind === 'HTTPRoute' && d.metadata?.name === 'gw-partner-api');
  assert.ok(api, 'gw-partner-api 라우트');
  const rules = api.spec.rules;
  const backendsOf = (prefix) => {
    const out = [];
    for (const r of rules) {
      for (const m of r.matches ?? []) {
        if (m.path?.value === prefix) out.push(...(r.backendRefs ?? []).map((b) => b.name));
      }
    }
    return [...new Set(out)];
  };
  for (const p of ['/v1/partner/events/{eventId}/staff', '/v1/partner/events/{eventId}/staff-invitations', '/v1/partner/staff']) {
    assert.deepEqual(backendsOf(p), ['identity-svc'], `${p} 백엔드`);
  }
});

test('BAT-450B 생성 라우트도 초대 경로를 identity-svc로 보낸다', () => {
  const docs = Y('deploy/gateways/gw-partner.routes.yaml');
  const api = docs.find((d) => d.kind === 'HTTPRoute' && d.metadata?.name === 'gw-partner-api');
  assert.ok(api, '생성된 gw-partner-api 라우트');
  // 생성기는 경로 틀을 RegularExpression으로 바꾼다. staff·staff-invitations가 든 규칙은 모두 identity-svc여야 한다
  const staffBackends = new Set();
  for (const r of api.spec.rules) {
    for (const m of r.matches ?? []) {
      const v = m.path?.value ?? '';
      if (v.includes('/staff')) for (const b of r.backendRefs ?? []) staffBackends.add(b.name);
    }
  }
  assert.deepEqual([...staffBackends], ['identity-svc'], '생성 라우트의 staff 경로 백엔드');
  for (const needle of ['/events/[^/]+/staff', '/events/[^/]+/staff-invitations', '/v1/partner/staff/[^/]+']) {
    assert.ok(
      api.spec.rules.some((r) => (r.matches ?? []).some((m) => (m.path?.value ?? '').includes(needle)) && (r.backendRefs ?? []).some((b) => b.name === 'identity-svc')),
      `${needle} 경로가 identity-svc로 가지 않는다`,
    );
  }
});

test('BAT-450B core-svc REST 부르는 쪽에 identity-svc가 있다', () => {
  const src = parse(readFileSync(new URL('deploy/platform/mesh/port-allow.yaml', repo), 'utf8'));
  assert.ok(src.workloads['core-svc'].ports.rest.callers.includes('identity-svc'), 'core-svc REST callers');
  const generated = Y('deploy/platform/mesh/meshless-networkpolicies.yaml');
  const np = generated.find((o) => o.kind === 'NetworkPolicy' && o.metadata?.name === 'core-svc-ports');
  assert.ok(np, 'core-svc-ports NetworkPolicy');
  const from = (np.spec.ingress ?? []).flatMap((r) => (r.from ?? []).map((f) => f.podSelector?.matchLabels?.['app.kubernetes.io/name'])).filter(Boolean);
  assert.ok(from.includes('identity-svc'), 'NetworkPolicy core-svc-ports의 identity-svc 출처');
});
