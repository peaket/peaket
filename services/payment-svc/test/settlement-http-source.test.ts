// 상품 정산 원천 HTTP 클라이언트 시험(A2-01). 가짜 core HTTP가 200을 주고 실제 정산서가 계산되는지 본다.
import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HttpProductSettlementSource, MemoryReauthVerifier, MemorySettlementStore, ManualPortonePayoutGateway, Settlements, UnavailableTossPayoutGateway } from '../src/modules/settlement/index.js';
import { noApprovals, noSaleSuspensions } from './settlement-support.js';

const NOW = new Date('2026-11-14T00:00:00.000Z');
const A = randomUUID();

describe('A2-01 상품 정산 원천 HTTP', () => {
  let server: Server;
  let baseUrl: string;
  const seen: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.url ?? '');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/internal/v1/shop/product-settlement-items' || !url.searchParams.get('from') || !url.searchParams.get('to')) {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'invalid-query' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          items: [
            {
              itemId: randomUUID(),
              orderId: randomUUID(),
              promoterId: A,
              eventId: null,
              pg: 'TOSS',
              pgStore: 'STANDARD',
              productId: randomUUID(),
              productName: '응원봉',
              quantity: 2,
              grossAmount: 30_000,
              refundedAmount: 0,
              commissionRateBp: 1000,
              basisDate: '2026-11-09',
              returnStatus: 'DELIVERED',
              eventEndsAt: null,
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('주소를 읽지 못했다');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  test('from·to를 query로 보내고 200 원천으로 상품 정산서를 계산한다', async () => {
    const store = new MemorySettlementStore();
    store.kycs.set(A, { promoterId: A, status: 'VERIFIED', businessVerified: true, representativeVerified: true, verifiedAt: NOW, source: 'MANUAL', updatedAt: NOW });
    const settlements = new Settlements({
      store,
      payments: { listEventPayments: async () => [] },
      products: new HttpProductSettlementSource(baseUrl, 'internal-test-token'),
      eventCommission: { rateBp: async () => 1000 },
      approvals: noApprovals,
      saleSuspensions: noSaleSuspensions,
      gateways: [new ManualPortonePayoutGateway(), new UnavailableTossPayoutGateway()],
      reauth: new MemoryReauthVerifier(),
      clock: fakeClock({ now: NOW.getTime() }),
    });
    const out = await settlements.calculateProduct({ periodStart: '2026-11-09', periodEnd: '2026-11-15' });
    expect(out.created).toBe(1);
    expect(out.items[0]).toMatchObject({ kind: 'PRODUCT', grossAmount: 30_000, payoutAmount: 26_700, status: 'NOTIFIED' });
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]!, 'http://127.0.0.1');
    expect(url.searchParams.get('from')).toBe('2026-11-09');
    expect(url.searchParams.get('to')).toBe('2026-11-15');
  });
});
