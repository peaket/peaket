// 배상 송금 gRPC 계약(BAT-425 GAT-130 잔여, R-592) 단위 시험. 정본 설명자로 실제 gRPC 서버에 붙는다.
import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CompensationTransfers } from '../src/modules/compensation/application/compensation-transfers.js';
import { FakeCompensationTransfer } from '../src/modules/compensation/adapters/fake-compensation-transfer.js';
import { compensationTransferHandlers, compensationTransferPackage } from '../src/modules/compensation/inbound/compensation-transfer.grpc.js';
import { startGrpcServer } from '../src/grpc-server.js';

const COMP = '01900000-0000-7000-8000-000000000001';
const ORDER = '01900000-0000-7000-8000-000000000002';
const ACCOUNT = '01900000-0000-7000-8000-000000000003';
type Unary = (req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res?: Record<string, unknown>) => void) => void;
let server: Awaited<ReturnType<typeof startGrpcServer>>;
let client: { RequestCompensationTransfer: Unary; GetCompensationTransfer: Unary; close(): void };

beforeAll(async () => {
  const transfers = new CompensationTransfers(new FakeCompensationTransfer({ PEAKET_COMPENSATION_TRANSFER_MODE: 'fake' }));
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: compensationTransferPackage().CompensationTransferService.service, handlers: compensationTransferHandlers(transfers) }],
  });
  const pkg = compensationTransferPackage() as unknown as { CompensationTransferService: new (address: string, credentials: grpc.ChannelCredentials) => typeof client };
  client = new pkg.CompensationTransferService(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure());
});
afterAll(async () => {
  client?.close();
  await server?.close();
});

const call = (method: 'RequestCompensationTransfer' | 'GetCompensationTransfer', req: Record<string, unknown>) =>
  new Promise<Record<string, unknown>>((resolve, reject) => client[method](req, (err, res) => (err ? reject(err) : resolve(res ?? {}))));

describe('CompensationTransferService gRPC [BAT-425]', () => {
  test('fake 모드는 REQUESTED와 멱등 transfer_id를 답하고 Get이 같은 건을 준다', async () => {
    const req = { compensation_id: COMP, order_id: ORDER, account_id: ACCOUNT, amount: 11_000, bank_code: '004', account_number: '1234567890', holder_name: '홍길동', requested_by: 'ops-1' };
    const a = await call('RequestCompensationTransfer', req);
    expect(a).toMatchObject({ status: 'COMPENSATION_TRANSFER_STATUS_REQUESTED', transfer_id: expect.any(String) });
    const b = await call('RequestCompensationTransfer', req);
    expect(b.transfer_id).toBe(a.transfer_id);
    expect(await call('GetCompensationTransfer', { transfer_id: a.transfer_id })).toMatchObject({ compensation_id: COMP, amount: 11_000, status: 'COMPENSATION_TRANSFER_STATUS_REQUESTED' });
  });
});
