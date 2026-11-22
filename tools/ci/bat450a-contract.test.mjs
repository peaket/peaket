// BAT-450A 계약 확인: 기기 승인 두 경로가 실제로 내는 409 응답을 OpenAPI가 적는지 본다(리뷰 RV-01).
// 문제 유형 목록에만 있고 경로 응답에 없으면 소비자는 그 응답을 계약으로 알 수 없다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const spec = parse(readFileSync(new URL('../../docs/api/openapi.yaml', import.meta.url), 'utf8'));

test('BAT-450A 두 기기 승인 경로가 409 문제 응답을 계약에 적는다', () => {
  assert.equal(spec['x-peaket-problem-types'].types['user-code-unavailable']?.status, 409);
  assert.equal(spec['x-peaket-problem-types'].types['device-approval-conflict']?.status, 409);
  assert.ok(spec.paths['/v1/scanner/device-authorizations']?.post.responses['409'], 'device-authorizations 409 응답이 없다');
  assert.ok(spec.paths['/v1/device-approvals']?.post.responses['409'], 'device-approvals 409 응답이 없다');
});
