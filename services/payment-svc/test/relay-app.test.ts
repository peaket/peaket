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
  await startPaymentRelay({ database, maintenanceDatabase: database, serviceDatabase: database, outboxPublisher: {} as OutboxPublisher, leaseApi: {} as LeaseApi, clock: fakeClock({ now: 0 }) });
  return vi.mocked(startOutboxRelayProcess).mock.calls[0]![0];
};

const startedWith = async (o: Partial<Parameters<typeof startPaymentRelay>[0]>) => {
  vi.mocked(startOutboxRelayProcess).mockClear();
  const database = {} as Database;
  await startPaymentRelay({ database, maintenanceDatabase: database, serviceDatabase: database, outboxPublisher: {} as OutboxPublisher, leaseApi: {} as LeaseApi, clock: fakeClock({ now: 0 }), ...o });
  return vi.mocked(startOutboxRelayProcess).mock.calls[0]![0];
};

describe('startPaymentRelay', () => {
  test('P-T17_리뷰 고침 M8: 정비 일은 Outbox 파티션 만들기·지우기와 웹훅 수신 기록·입금 해시·대사 작업 표 지우기뿐이다(표가 없는 일은 돌리지 않는다, BUILD_ORDER HOT-153)', async () => {
    const names = ((await started()).maintenanceTasks ?? []).map((t) => t.name);
    expect([...names].sort()).toEqual(['deposit-secret-hash-delete', 'outbox-partitions-drop', 'outbox-partitions-ensure', 'payment-entry-trial-delete', 'reconciliation-seen-delete', 'webhook-receipts-delete']);
  });

  test('P-T32_결제사 어댑터를 넘기면 대사 일이 더해진다(매일 일, 시간 규칙은 일이 스스로 본다)', async () => {
    const tasks = (await startedWith({ gateways: { of: () => undefined } })).maintenanceTasks ?? [];
    expect(tasks.find((t) => t.name === 'payment-reconciliation')).toMatchObject({ when: 'daily' });
  });

  test('P-T32_리뷰 고침 M10: 운영(PEAKET_ENV=prod)에서 온세일 일정 부품이 없으면 대사 일을 켜지 않는다. 일정을 넘기면 켠다', async () => {
    const off = (await startedWith({ gateways: { of: () => undefined }, env: { PEAKET_ENV: 'prod' } })).maintenanceTasks ?? [];
    expect(off.map((t) => t.name)).not.toContain('payment-reconciliation');
    const on = (await startedWith({ gateways: { of: () => undefined }, env: { PEAKET_ENV: 'prod' }, onSaleCalendar: { active: async () => false } })).maintenanceTasks ?? [];
    expect(on.map((t) => t.name)).toContain('payment-reconciliation');
  });

  test('P-T32_리뷰 고침 M14: 원장을 쓰는 입금 해시 지우기는 정비 역할이 아니라 서비스 역할로 돈다(purchase-svc 릴레이와 같은 나눔)', async () => {
    const transaction = vi.fn(async () => 0);
    const serviceDatabase = { transaction } as unknown as Database;
    const maintenance = {
      get db(): never {
        throw new Error('정비 역할을 쓰면 안 된다');
      },
      transaction: async () => {
        throw new Error('정비 역할을 쓰면 안 된다');
      },
    } as unknown as Database;
    const tasks = (await startedWith({ serviceDatabase, maintenanceDatabase: maintenance, clock: fakeClock({ now: Date.parse('2026-11-10T04:30:00+09:00') }) })).maintenanceTasks ?? [];
    await tasks.find((t) => t.name === 'deposit-secret-hash-delete')!.run();
    expect(transaction).toHaveBeenCalled();
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
