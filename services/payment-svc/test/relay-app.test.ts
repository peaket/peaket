// payment-svc 릴레이 조립의 정비 일 목록(BUILD_ORDER PRF-180 코드 리뷰 L9, docs/features/payment.md §2 '승인 명령 접수의 첫 구현' 프로세스·만들지 않은 것).
// 이 단계의 마이그레이션에는 Outbox 표만 있어 다른 공용 정비 일(멱등 기록·보류 행·통계 스냅샷)을 돌리면 정비 시간마다 실패한다. 실제로 띄워 보는 것은 test-int가 본다.
import type { Database, LeaseApi, OutboxPublisher, OutboxRelayProcess, OutboxRelayProcessOptions } from '@peaket/platform';
import { fakeClock, platformMaintenanceTasks, startOutboxRelayProcess } from '@peaket/platform';
import { describe, expect, test, vi } from 'vitest';
import { startPaymentRelay } from '../src/relay-app.js';

vi.mock('@peaket/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@peaket/platform')>()),
  startOutboxRelayProcess: vi.fn(async () => ({}) as OutboxRelayProcess),
}));

const started = async (): Promise<OutboxRelayProcessOptions> => {
  vi.mocked(startOutboxRelayProcess).mockClear();
  const database = {} as Database;
  await startPaymentRelay({ database, maintenanceDatabase: database, outboxPublisher: {} as OutboxPublisher, leaseApi: {} as LeaseApi, clock: fakeClock({ now: 0 }) });
  return vi.mocked(startOutboxRelayProcess).mock.calls[0]![0];
};

describe('startPaymentRelay', () => {
  test('P-T53_리뷰 고침 L9: 정비 일은 Outbox 파티션 만들기·지우기 둘뿐이다(표가 없는 일은 돌리지 않는다)', async () => {
    const names = ((await started()).maintenanceTasks ?? []).map((t) => t.name);
    expect([...names].sort()).toEqual(['outbox-partitions-drop', 'outbox-partitions-ensure']);
  });

  test('P-T53_리뷰 고침 L9: 공용 정비 일에는 이 서비스가 뺀 일이 실제로 있다(위 시험이 거르는 쪽을 본다)', () => {
    const all = platformMaintenanceTasks({} as Database, fakeClock({ now: 0 })).map((t) => t.name);
    expect(all).toContain('idempotency-records-delete');
    expect(all).toContain('held-events-delete');
  });

  test('P-T53_리뷰 고침 L9: 서비스 이름은 payment-svc다', async () => {
    expect((await started()).service).toBe('payment-svc');
  });
});
