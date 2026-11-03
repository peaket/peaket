// 생성물 차이 검사: 커밋된 생성물 폴더와 새로 만든 폴더를 견준다(design.md 결정 4, 기술 검토 중간-085)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { diffTrees } from '../scripts/tree-diff.mjs';

const made: string[] = [];
function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'contracts-diff-'));
  made.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('생성물 차이 검사', () => {
  test('중간085_같으면_차이가없다', () => {
    const files = { 'openapi/model/index.ts': 'a\n', 'asyncapi/model/orderEvent.zod.ts': 'b\n' };
    expect(diffTrees(tree(files), tree(files))).toEqual({ missing: [], extra: [], changed: [] });
  });

  test('중간085_내용이다르거나_빠졌거나_더있는파일을_이름으로알린다', () => {
    const committed = tree({ 'openapi/queue.ts': 'old\n', 'openapi/gone.ts': 'x\n', 'same.ts': 's\n' });
    const fresh = tree({ 'openapi/queue.ts': 'new\n', 'openapi/model/added.zod.ts': 'y\n', 'same.ts': 's\n' });
    expect(diffTrees(committed, fresh)).toEqual({
      missing: ['openapi/model/added.zod.ts'],
      extra: ['openapi/gone.ts'],
      changed: ['openapi/queue.ts'],
    });
  });

  test('중간085_줄바꿈만다르면_차이가없다', () => {
    expect(diffTrees(tree({ 'a.ts': 'x\r\ny\r\n' }), tree({ 'a.ts': 'x\ny\n' }))).toEqual({ missing: [], extra: [], changed: [] });
  });

  test('중간085_커밋된폴더가없으면_새로만든파일이모두빠진것이다', () => {
    const fresh = tree({ 'b.ts': '1', 'a/c.ts': '2' });
    expect(diffTrees(join(tmpdir(), 'contracts-diff-none-' + process.pid), fresh)).toEqual({ missing: ['a/c.ts', 'b.ts'], extra: [], changed: [] });
  });
});
