// F-06-4 구현 리뷰 IR-02: 10분 정비·다시 보내기 작업이 키트의 maintain을 부르는지.
import { describe, expect, test, vi } from 'vitest';
import { RestrictionMaintenanceJob } from '../src/jobs/restriction-maintenance.js';

const logger = { warn: () => undefined, info: () => undefined, error: () => undefined } as never;

describe('IR-02 RestrictionMaintenanceJob', () => {
  test('한 바퀴가 키트의 maintain(nowMs)을 부른다', async () => {
    const maintain = vi.fn(async () => undefined);
    const job = new RestrictionMaintenanceJob({ maintain }, logger);
    await job.tick(1234);
    expect(maintain).toHaveBeenCalledWith(1234);
  });
});
