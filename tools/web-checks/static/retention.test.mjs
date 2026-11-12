// 정적 자산 30일·최근 5빌드 보존 규칙(docs/frontend.md §5.18, docs/devops.md §6.6, BUILD_ORDER HOT-390).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETENTION_BUILDS, RETENTION_DAYS, retentionPlan } from './retention.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-12T00:00:00Z');
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

test('30일·최근 5빌드 상수와 경계(정확히 30일 전은 남긴다)', () => {
  assert.equal(RETENTION_DAYS, 30);
  assert.equal(RETENTION_BUILDS, 5);
  const plan = retentionPlan(
    [
      { id: 'exact-30', at: at(30), files: ['exact.js'] },
      { id: 'over-30', at: at(30.001), files: ['over.js'] },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `new${i}`, at: at(i), files: [`new${i}.js`] })),
    ],
    NOW,
  );
  assert.deepEqual(plan.keepBuilds, ['new0', 'new1', 'new2', 'new3', 'new4', 'exact-30']);
  assert.deepEqual(plan.deleteBuilds, ['over-30']);
  assert.deepEqual(plan.deleteFiles, ['over.js']);
});

test('최근 5빌드는 30일이 지나도 남기고, 그보다 오래된 빌드는 지운다', () => {
  const builds = Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, at: at(40 + i), files: [`b${i}.js`] }));
  const plan = retentionPlan(builds, NOW);
  assert.deepEqual(plan.keepBuilds, ['b0', 'b1', 'b2', 'b3', 'b4']);
  assert.deepEqual(plan.deleteBuilds, ['b5', 'b6']);
  assert.deepEqual(plan.deleteFiles, ['b5.js', 'b6.js']);
});

test('지울 빌드와 남길 빌드가 같이 쓰는 해시 파일은 남긴다', () => {
  const plan = retentionPlan(
    [
      { id: 'old', at: at(60), files: ['shared.js', 'old.js'] },
      { id: 'new', at: at(1), files: ['shared.js', 'new.js'] },
      { id: 'b1', at: at(2), files: ['b1.js'] },
      { id: 'b2', at: at(3), files: ['b2.js'] },
      { id: 'b3', at: at(4), files: ['b3.js'] },
      { id: 'b4', at: at(5), files: ['b4.js'] },
    ],
    NOW,
  );
  assert.deepEqual(plan.deleteBuilds, ['old']);
  assert.deepEqual(plan.deleteFiles, ['old.js']);
  assert.ok(plan.keepFiles.includes('shared.js'));
  assert.ok(plan.keepFiles.includes('new.js'));
});

test('같은 파일 경로가 여러 빌드에 있어도 한 번만 내고, 빈 목록은 빈 결과다', () => {
  const plan = retentionPlan(
    [
      { id: 'a', at: at(1), files: [{ path: 'same.js' }, { path: 'same.js' }] },
      { id: 'b', at: at(2), files: ['same.js', 'b.js'] },
    ],
    NOW,
  );
  assert.deepEqual(plan.keepFiles, ['b.js', 'same.js']);
  assert.deepEqual(plan.deleteFiles, []);
  assert.deepEqual(retentionPlan([], NOW), { keepBuilds: [], deleteBuilds: [], keepFiles: [], deleteFiles: [] });
});

test('빌드 ID가 겹치거나 시각이 틀리면 배포 전에 거절한다', () => {
  assert.throws(() => retentionPlan([{ id: 'a', at: at(1) }, { id: 'a', at: at(2) }], NOW), /겹친다/);
  assert.throws(() => retentionPlan([{ id: 'a', at: 'not-a-date' }], NOW), /시각/);
  assert.throws(() => retentionPlan([{ id: '', at: at(1) }], NOW), /ID/);
});
