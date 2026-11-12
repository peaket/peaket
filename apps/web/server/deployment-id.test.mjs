// 배포 식별자(docs/frontend.md §2.5, docs/devops.md §6.6, BUILD_ORDER HOT-390).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deploymentIdOf } from './deployment-id.mjs';

test('PEAKET_DEPLOYMENT_ID가 있으면 그 값을, 없으면 GITHUB_SHA를 쓴다', () => {
  assert.equal(deploymentIdOf({ PEAKET_DEPLOYMENT_ID: 'abc123', GITHUB_SHA: 'def456' }), 'abc123');
  assert.equal(deploymentIdOf({ GITHUB_SHA: 'def456' }), 'def456');
});

test('빈 값·공백은 배포 식별자로 쓰지 않고, 둘 다 없으면 undefined다', () => {
  assert.equal(deploymentIdOf({ PEAKET_DEPLOYMENT_ID: '   ', GITHUB_SHA: 'def456' }), 'def456');
  assert.equal(deploymentIdOf({ PEAKET_DEPLOYMENT_ID: '', GITHUB_SHA: '' }), undefined);
  assert.equal(deploymentIdOf({}), undefined);
  assert.equal(deploymentIdOf({ PEAKET_DEPLOYMENT_ID: 123, GITHUB_SHA: 'def456' }), 'def456');
});

test('[ASVS v5.0.0-13.4.1] 운영 이미지는 standalone 산출물만 쓰고, 배포 식별자를 next.config.ts에 건다(HOT-390)', () => {
  const src = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8');
  assert.match(src, /output:\s*'standalone'/);
  assert.match(src, /deploymentId:\s*deploymentIdOf\(\)/);
});
