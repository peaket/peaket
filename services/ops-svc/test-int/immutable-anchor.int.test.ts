// 외부 불변 저장소(S3 Object Lock)·OpenTimestamps 앵커 경계 통합 시험(BAT-465 잔여 2차, GAT-310).
// 설정이 없으면 503 anchor-unavailable로 막고 로컬 앵커를 유지하며, 가짜 저장소는 참조를 만들고 검증한다.
import { describe, expect, test } from 'vitest';
import {
  anchorCheckpoint,
  MemoryImmutableAnchorStore,
  MemoryOpenTimestampsAnchor,
  OpenTimestampsAnchorAdapter,
  S3ObjectLockAnchorStore,
} from '../src/modules/audit/index.js';

const input = { checkpointId: '01900000-0000-7000-8000-000000000001', rootHash: 'ab'.repeat(32), createdAtMs: 1_760_000_000_000 };

describe('Q-T59 외부 불변 앵커 경계', () => {
  test('버킷·달력 설정이 없으면 S3·OpenTimestamps 모두 503 anchor-unavailable이다', async () => {
    await expect(new S3ObjectLockAnchorStore({}).put(input)).rejects.toMatchObject({ status: 503, type: expect.stringContaining('anchor-unavailable') });
    await expect(new S3ObjectLockAnchorStore({ bucket: 'b', region: 'ap-northeast-2' }).put(input)).rejects.toMatchObject({ status: 503, type: expect.stringContaining('anchor-unavailable') });
    await expect(new S3ObjectLockAnchorStore({}).verify('s3://b/x')).rejects.toMatchObject({ status: 503, type: expect.stringContaining('anchor-unavailable') });
    await expect(new OpenTimestampsAnchorAdapter({}).stamp(input)).rejects.toMatchObject({ status: 503, type: expect.stringContaining('anchor-unavailable') });
    await expect(new OpenTimestampsAnchorAdapter({ calendarUrl: 'https://calendar.example' }).stamp(input)).rejects.toMatchObject({ status: 503, type: expect.stringContaining('anchor-unavailable') });
    await expect(new OpenTimestampsAnchorAdapter({}).verify('ots:x')).rejects.toMatchObject({ status: 503, type: expect.stringContaining('anchor-unavailable') });
  });

  test('외부 앵커가 모두 실패해도 로컬 앵커를 유지하고 오류만 기록한다', async () => {
    const out = await anchorCheckpoint(input, { immutable: new S3ObjectLockAnchorStore({}), ots: new OpenTimestampsAnchorAdapter({}) });
    expect(out.localOnly).toBe(true);
    expect(out.immutable).toBeUndefined();
    expect(out.ots).toBeUndefined();
    expect(out.errors).toEqual(['immutable:ProblemError', 'ots:ProblemError']);
  });

  test('가짜 저장소는 참조를 만들고 검증하며, 하나만 성공해도 나머지 오류를 남긴다', async () => {
    const immutable = new MemoryImmutableAnchorStore();
    const ots = new MemoryOpenTimestampsAnchor();
    const both = await anchorCheckpoint(input, { immutable, ots });
    expect(both.localOnly).toBe(false);
    expect(both.errors).toEqual([]);
    expect(both.immutable?.ref).toMatch(/^memory:s3:/);
    expect(both.ots?.ref).toBe(`memory:ots:${input.checkpointId}`);
    expect(await immutable.verify(both.immutable!.ref)).toBe(true);
    expect(await ots.verify(both.ots!.ref)).toBe(true);
    expect(await immutable.verify('memory:s3:nope')).toBe(false);

    const partial = await anchorCheckpoint(input, { immutable, ots: new OpenTimestampsAnchorAdapter({}) });
    expect(partial.localOnly).toBe(false);
    expect(partial.immutable?.ref).toMatch(/^memory:s3:/);
    expect(partial.errors).toEqual(['ots:ProblemError']);
  });
});
