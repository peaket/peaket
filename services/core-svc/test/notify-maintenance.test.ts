// BAT-455 N-T22 ③: 발송 기록·신청·중복 키 정비 일이 실제 조립 목록에 들어가는지 본다(보존 90일·7일, notify §12·data §2 ⑥).
import { describe, expect, test } from 'vitest';
import { CORE_MAINTENANCE_TASK_NAMES, coreMaintenanceTasks } from '../src/maintenance-tasks.js';
import { fakeClock, systemClock } from '@peaket/platform';

describe('N-T22 알림 표 정비', () => {
  test('N-T22 ③ 발송 기록 파티션 만들기·지우기, 신청 만료, 중복 키 지우기가 정비 일 목록에 있다', () => {
    for (const name of ['notification-delivery-partitions', 'notification-delivery-purge', 'notification-subscription-expired', 'notification-dedup-purge']) {
      expect(CORE_MAINTENANCE_TASK_NAMES).toContain(name);
    }
    const names = coreMaintenanceTasks({ db: {} } as never, fakeClock({ now: systemClock.now() }), {}).tasks.map((t) => t.name);
    for (const name of ['notification-delivery-partitions', 'notification-delivery-purge', 'notification-subscription-expired', 'notification-dedup-purge']) {
      expect(names).toContain(name);
    }
  });
});
