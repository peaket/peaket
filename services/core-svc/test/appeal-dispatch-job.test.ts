// F-06-4 구현 리뷰 IR-03: FRAUD_CASE 소명 보내기 작업이 dispatchOnce를 부르는지.
import { describe, expect, test, vi } from 'vitest';
import { AppealDispatchJob } from '../src/jobs/appeal-dispatch.js';

const logger = { warn: () => undefined, info: () => undefined, error: () => undefined } as never;

describe('IR-03 AppealDispatchJob', () => {
  test('한 바퀴가 Appeals.dispatchOnce를 부른다', async () => {
    const dispatchOnce = vi.fn(async () => ({ sent: 0, retry: 0, invalid: 0 }));
    const job = new AppealDispatchJob({ dispatchOnce }, logger);
    await job.tick(1234);
    expect(dispatchOnce).toHaveBeenCalledWith(1234);
  });
});
