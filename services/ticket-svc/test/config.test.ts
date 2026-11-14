// ticket-svc 설정 시험(BUILD_ORDER GAT-170, R-537): staging·prod에서 공유 Redis·identity 주소 없이 시작하지 않는다.
import { describe, expect, test } from 'vitest';
import { loadTicketServiceConfig } from '../src/config.js';

const DB = 'postgres://peaket:peaket@127.0.0.1:5432/peaket';

describe('ticket-svc 설정 [GAT-170]', () => {
  test('local·ci는 메모리 저장소를 허용하고, staging·prod는 Redis와 identity 주소가 없으면 시작하지 않는다', () => {
    expect(loadTicketServiceConfig({ PEAKET_DATABASE_URL: DB, PEAKET_ENV: 'ci' }).redisUrl).toBeUndefined();
    expect(() => loadTicketServiceConfig({ PEAKET_DATABASE_URL: DB, PEAKET_ENV: 'prod' })).toThrow(/PEAKET_IDENTITY_GRPC_URL/);
    expect(() => loadTicketServiceConfig({ PEAKET_DATABASE_URL: DB, PEAKET_ENV: 'prod', PEAKET_IDENTITY_GRPC_URL: 'identity-svc:50051' })).toThrow(/PEAKET_TICKET_REDIS_URL/);
    expect(loadTicketServiceConfig({ PEAKET_DATABASE_URL: DB, PEAKET_ENV: 'prod', PEAKET_TICKET_REDIS_URL: 'redis://127.0.0.1:6379', PEAKET_IDENTITY_GRPC_URL: 'identity-svc:50051' })).toMatchObject({
      identityGrpcUrl: 'identity-svc:50051',
      redisUrl: 'redis://127.0.0.1:6379',
    });
  });

  test('스캐너 오프라인 허용 시간은 기본 24시간이고 양의 밀리초만 받는다 [GAT-160]', () => {
    expect(loadTicketServiceConfig({ PEAKET_DATABASE_URL: DB, PEAKET_ENV: 'ci' }).scannerMaxOfflineMs).toBe(24 * 60 * 60_000);
    expect(loadTicketServiceConfig({ PEAKET_DATABASE_URL: DB, PEAKET_ENV: 'ci', PEAKET_SCANNER_MAX_OFFLINE_MS: '60000' }).scannerMaxOfflineMs).toBe(60_000);
    expect(() => loadTicketServiceConfig({ PEAKET_DATABASE_URL: DB, PEAKET_ENV: 'ci', PEAKET_SCANNER_MAX_OFFLINE_MS: '0' })).toThrow(/PEAKET_SCANNER_MAX_OFFLINE_MS/);
    expect(() => loadTicketServiceConfig({ PEAKET_DATABASE_URL: DB, PEAKET_ENV: 'ci', PEAKET_SCANNER_MAX_OFFLINE_MS: 'abc' })).toThrow(/PEAKET_SCANNER_MAX_OFFLINE_MS/);
  });
});
