// 외부 불변 저장소·OpenTimestamps 앵커 경계 시험(BAT-465 잔여).
import { describe, expect, test } from 'vitest';
import { MemoryImmutableAnchorStore, MemoryOpenTimestampsAnchor, OpenTimestampsAnchorAdapter, S3ObjectLockAnchorStore, anchorCheckpoint } from '../src/modules/audit/index.js';

const input = { checkpointId: '01900000-0000-7000-8000-000000000001', rootHash: 'ab'.repeat(32), createdAtMs: 1_760_000_000_000 };

describe('외부 불변 앵커 경계', () => {
  test('버킷·달력이 없으면 503으로 막고 로컬 앵커를 유지한다', async () => {
    const out = await anchorCheckpoint(input, { immutable: new S3ObjectLockAnchorStore({}), ots: new OpenTimestampsAnchorAdapter({}) });
    expect(out.localOnly).toBe(true);
    expect(out.errors).toEqual(['immutable:ProblemError', 'ots:ProblemError']);
    await expect(new S3ObjectLockAnchorStore({}).put(input)).rejects.toMatchObject({ status: 503, type: expect.stringContaining('anchor-unavailable') });
    await expect(new OpenTimestampsAnchorAdapter({}).stamp(input)).rejects.toMatchObject({ status: 503 });
  });

  test('가짜 저장소는 참조를 만들고 검증한다', async () => {
    const immutable = new MemoryImmutableAnchorStore();
    const ots = new MemoryOpenTimestampsAnchor();
    const out = await anchorCheckpoint(input, { immutable, ots });
    expect(out.localOnly).toBe(false);
    expect(out.errors).toEqual([]);
    expect(out.immutable?.ref).toMatch(/^memory:s3:/);
    expect(out.ots?.ref).toBe(`memory:ots:${input.checkpointId}`);
    expect(await immutable.verify(out.immutable!.ref)).toBe(true);
    expect(await ots.verify(out.ots!.ref)).toBe(true);
    expect(await immutable.verify('memory:s3:nope')).toBe(false);
  });
});
