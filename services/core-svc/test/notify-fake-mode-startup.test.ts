// SEC-07 회귀: 알림 발송기가 운영에서 fake 모드로 만들어지면 시작 단계에서 실패한다.
// 정본 PEAKET_ENV 값은 prod·staging이고, production은 옛 호환 값이다. 이미지처럼 PEAKET_ENV가 비어도 NODE_ENV=production이면 운영이다.
import { describe, expect, test } from 'vitest';
import { NotificationSender } from '../src/modules/notify/application/notification-sender.js';

const transport = { send: async () => undefined };

describe('SEC-07 알림 fake 모드 시작 차단', () => {
  test('PEAKET_ENV=prod(정본)·staging과 미설정(NODE_ENV=production)에서 fake면 생성자가 던진다', () => {
    for (const env of [{ PEAKET_ENV: 'prod' }, { PEAKET_ENV: 'staging' }, { NODE_ENV: 'production' }, { NODE_ENV: 'production', PEAKET_ENV: '' }]) {
      expect(() => new NotificationSender(transport, { ...env, PEAKET_NOTIFY_SENDER_MODE: 'fake' })).toThrow(/운영/);
    }
    expect(() => new NotificationSender(transport, { PEAKET_ENV: 'prod', PEAKET_NOTIFY_SENDER_MODE: ' fake ' })).toThrow(/운영/);
  });

  test('NODE_ENV=production과 옛 호환 값 PEAKET_ENV=production도 fake를 막는다', () => {
    expect(() => new NotificationSender(transport, { NODE_ENV: 'production', PEAKET_NOTIFY_SENDER_MODE: 'fake' })).toThrow(/운영/);
    expect(() => new NotificationSender(transport, { PEAKET_ENV: 'production', PEAKET_NOTIFY_SENDER_MODE: 'fake' })).toThrow(/운영/);
  });

  test('ci·local·demo와 fake가 아닌 모드는 생성된다', () => {
    for (const env of ['ci', 'local', 'demo']) {
      expect(() => new NotificationSender(transport, { PEAKET_ENV: env, PEAKET_NOTIFY_SENDER_MODE: 'fake' })).not.toThrow();
    }
    expect(() => new NotificationSender(transport, { PEAKET_ENV: 'prod', PEAKET_NOTIFY_SENDER_MODE: 'real' })).not.toThrow();
  });
});
