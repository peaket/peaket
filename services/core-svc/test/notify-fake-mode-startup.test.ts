// SEC-07 회귀: 알림 발송기가 운영에서 fake 모드로 만들어지면 시작 단계에서 실패한다.
import { describe, expect, test } from 'vitest';
import { NotificationSender } from '../src/modules/notify/application/notification-sender.js';

const transport = { send: async () => undefined };

describe('SEC-07 알림 fake 모드 시작 차단', () => {
  test('NODE_ENV=production·PEAKET_ENV=production에서 fake면 생성자가 던진다', () => {
    expect(() => new NotificationSender(transport, { NODE_ENV: 'production', PEAKET_NOTIFY_SENDER_MODE: 'fake' })).toThrow(/운영/);
    expect(() => new NotificationSender(transport, { PEAKET_ENV: 'production', PEAKET_NOTIFY_SENDER_MODE: 'fake' })).toThrow(/운영/);
    expect(() => new NotificationSender(transport, { PEAKET_ENV: 'production', PEAKET_NOTIFY_SENDER_MODE: ' fake ' })).toThrow(/운영/);
  });

  test('ci·local과 fake가 아닌 모드는 생성된다', () => {
    expect(() => new NotificationSender(transport, { PEAKET_ENV: 'ci', PEAKET_NOTIFY_SENDER_MODE: 'fake' })).not.toThrow();
    expect(() => new NotificationSender(transport, { PEAKET_ENV: 'local', PEAKET_NOTIFY_SENDER_MODE: 'fake' })).not.toThrow();
    expect(() => new NotificationSender(transport, { NODE_ENV: 'production', PEAKET_NOTIFY_SENDER_MODE: 'real' })).not.toThrow();
  });
});
