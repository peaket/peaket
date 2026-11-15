// SEC-07: 운영에서 알림 발송 fake 모드를 켜면 시작을 막는다.
import { describe, expect, test } from 'vitest';
import { assertNotifyFakeAllowed } from '../src/modules/notify/application/notification-sender.js';

describe('SEC-07 알림 fake 모드', () => {
  test('운영(NODE_ENV·PEAKET_ENV=production)에서는 fake가 시작 실패다', () => {
    expect(() => assertNotifyFakeAllowed({ NODE_ENV: 'production', PEAKET_NOTIFY_SENDER_MODE: 'fake' })).toThrow(/운영/);
    expect(() => assertNotifyFakeAllowed({ PEAKET_ENV: 'production', PEAKET_NOTIFY_SENDER_MODE: 'fake' })).toThrow(/운영/);
  });

  test('시험·로컬과 fake가 아닌 모드는 통과한다', () => {
    expect(() => assertNotifyFakeAllowed({ PEAKET_ENV: 'ci', PEAKET_NOTIFY_SENDER_MODE: 'fake' })).not.toThrow();
    expect(() => assertNotifyFakeAllowed({ NODE_ENV: 'production' })).not.toThrow();
  });
});
