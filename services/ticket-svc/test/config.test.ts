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
});
