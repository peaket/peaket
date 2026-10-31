// 생성물이 지금 계약에서 다시 만든 것과 같은지 본다(design.md 결정 4, 기술 검토 중간-085).
// 계약을 고치고 다시 만들지 않았거나 생성물을 손으로 고쳤으면 실패한다. 고치는 법: pnpm --filter @peaket/contracts gen
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { generateAll } from '../scripts/generate.mjs';
import { diffTrees } from '../scripts/tree-diff.mjs';

test('중간085_ADR0165_커밋된생성물이_지금계약에서다시만든것과같다', async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'contracts-gen-'));
  try {
    await generateAll(fresh);
    const committed = fileURLToPath(new URL('../src/gen', import.meta.url));
    expect(diffTrees(committed, fresh)).toEqual({ missing: [], extra: [], changed: [] });
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}, 120_000);
