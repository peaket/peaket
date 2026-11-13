// 파트너 콘솔의 계약 모양 가짜 API(SCR-023·025·027). 서버 모듈(core-svc shop·notify·export, payment-svc 정산)이
// 아직 없으므로 브라우저 확인·로컬 시연에서만 쓴다. 실제 서버가 생기면 이 파일을 지운다(ADR-0199와 같은 방식).
// 실행: node tools/web-checks/partner-api/server.mjs --port 4012
// 파트너 앱: NEXT_PUBLIC_PARTNER_API_ORIGIN=http://127.0.0.1:4012 pnpm --filter @peaket/partner dev
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 4012);
const REAUTH_TOKEN = 'test-booker-export-token';
const ORIGIN = process.env.PARTNER_ORIGIN ?? 'http://localhost:3001';

const now = () => new Date().toISOString();
const uuid = () => randomUUID();
const json = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-credentials': 'true',
    ...headers,
  });
  res.end(text);
};
const problem = (res, status, type, title, extra = {}) =>
  json(res, status, { type: `https://peaket.example/problems/${type}`, title, status, ...extra }, { 'content-type': 'application/problem+json; charset=utf-8' });
const text = (res, status, body, contentType, filename) => {
  res.writeHead(status, {
    'content-type': contentType,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'cache-control': 'no-store',
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-credentials': 'true',
  });
  res.end(body);
};

const productions = [
  { productionId: '11111111-1111-4111-8111-111111111111', title: 'LUMEN 콘서트 2026 서울' },
  { productionId: '22222222-2222-4222-8222-222222222222', title: '스텔라 뮤지컬 갈라' },
];
const events = {
  '11111111-1111-4111-8111-111111111111': [
    { eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', startsAt: '2026-10-25T09:00:00.000Z' },
    { eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', startsAt: '2026-10-26T08:00:00.000Z' },
  ],
  '22222222-2222-4222-8222-222222222222': [{ eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', startsAt: '2026-11-01T10:00:00.000Z' }],
};

const products = [
  {
    productId: '33333333-3333-4333-8333-333333333331',
    name: 'LUMEN 공식 응원봉',
    type: 'MERCH',
    ticketLinked: false,
    status: 'ON_SALE',
    price: 45000,
    shippingFee: 3000,
    fulfillments: ['DELIVERY', 'PICKUP'],
    stockRemaining: 120,
    stockTotal: 680,
    saleStartsAt: '2026-10-07T03:00:00.000Z',
    saleEndsAt: '2026-10-24T14:59:00.000Z',
    linkedProductionId: null,
    linkedProductionTitle: null,
    version: 2,
    linkedEventId: null,
    returnShippingFee: 3000,
    returnAddress: '서울특별시 마포구 월드컵로 1',
    limitedQty: 680,
    transferable: false,
    attributes: { options: '색상: 인디고, 화이트' },
  },
  {
    productId: '33333333-3333-4333-8333-333333333332',
    name: 'LUMEN 투어 티셔츠',
    type: 'MERCH',
    ticketLinked: false,
    status: 'ON_SALE',
    price: 39000,
    shippingFee: 3000,
    fulfillments: ['DELIVERY', 'PICKUP'],
    stockRemaining: 220,
    stockTotal: 800,
    saleStartsAt: '2026-10-07T03:00:00.000Z',
    saleEndsAt: '2026-10-24T14:59:00.000Z',
    linkedProductionId: null,
    linkedProductionTitle: null,
    version: 1,
    linkedEventId: null,
    returnShippingFee: 3000,
    returnAddress: '서울특별시 마포구 월드컵로 1',
    limitedQty: 800,
    transferable: false,
    attributes: { options: 'S, M, L' },
  },
  {
    productId: '33333333-3333-4333-8333-333333333333',
    name: 'LUMEN 콘서트 주차권',
    type: 'PARKING',
    ticketLinked: true,
    status: 'NOT_STARTED',
    price: 20000,
    shippingFee: null,
    fulfillments: ['PICKUP'],
    stockRemaining: 300,
    stockTotal: 300,
    saleStartsAt: '2026-10-14T11:00:00.000Z',
    saleEndsAt: '2026-10-25T07:30:00.000Z',
    linkedProductionId: '11111111-1111-4111-8111-111111111111',
    linkedProductionTitle: 'LUMEN 콘서트 2026 서울',
    version: 1,
    linkedEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    returnShippingFee: null,
    returnAddress: null,
    limitedQty: 300,
    transferable: true,
    attributes: {},
  },
];

const webhooks = [
  {
    endpointId: '44444444-4444-4444-8444-444444444441',
    url: 'https://partner.example.com/hook',
    eventTypes: ['order.confirmed', 'order.cancelled'],
    status: 'ACTIVE',
    disabledReason: null,
    secretIssuedAt: '2026-10-01T01:30:00.000Z',
    previousSecretValidUntil: null,
    version: 3,
  },
];
const deliveries = [
  {
    deliveryId: '55555555-5555-4555-8555-555555555551',
    webhookId: 'msg_7Q2D',
    eventType: 'order.confirmed',
    status: 'RETRYING',
    attemptCount: 3,
    lastHttpStatus: 503,
    lastError: null,
    nextAttemptAt: '2026-10-14T11:33:00.000Z',
    createdAt: '2026-10-14T11:03:40.000Z',
    finishedAt: null,
  },
  {
    deliveryId: '55555555-5555-4555-8555-555555555552',
    webhookId: 'msg_K8DW',
    eventType: 'order.cancelled',
    status: 'SUCCEEDED',
    attemptCount: 1,
    lastHttpStatus: 200,
    lastError: null,
    nextAttemptAt: null,
    createdAt: '2026-10-14T11:02:05.000Z',
    finishedAt: '2026-10-14T11:02:06.000Z',
  },
  {
    deliveryId: '55555555-5555-4555-8555-555555555553',
    webhookId: 'msg_P1XA',
    eventType: 'order.confirmed',
    status: 'DEAD',
    attemptCount: 7,
    lastHttpStatus: null,
    lastError: 'TIMEOUT',
    nextAttemptAt: null,
    createdAt: '2026-10-14T09:47:09.000Z',
    finishedAt: '2026-10-14T21:47:09.000Z',
  },
];

const merchItems = [
  {
    itemId: '66666666-6666-4666-8666-666666666661',
    orderId: '77777777-7777-4777-8777-777777777771',
    version: 1,
    status: 'READY',
    fulfillment: 'DELIVERY',
    productId: products[0].productId,
    productName: 'LUMEN 공식 응원봉',
    ticketLinked: false,
    optionSummary: '인디고',
    quantity: 1,
    orderedAt: '2026-10-14T10:41:00.000Z',
    escrow: true,
    recipient: { nameMasked: '김*수', phoneMasked: '010-****-2841' },
    trackingCarrier: null,
    trackingNo: null,
    deliveredAt: null,
    pickedUpAt: null,
    returnReason: null,
    returnTrackingNo: null,
    returnReceivedAt: null,
  },
  {
    itemId: '66666666-6666-4666-8666-666666666662',
    orderId: '77777777-7777-4777-8777-777777777772',
    version: 1,
    status: 'SHIPPED',
    fulfillment: 'DELIVERY',
    productId: products[1].productId,
    productName: 'LUMEN 투어 티셔츠',
    ticketLinked: false,
    optionSummary: 'L',
    quantity: 1,
    orderedAt: '2026-10-12T05:00:00.000Z',
    escrow: false,
    recipient: { nameMasked: '박*준', phoneMasked: '010-****-0412' },
    trackingCarrier: 'CJ',
    trackingNo: '601233457781',
    deliveredAt: null,
    pickedUpAt: null,
    returnReason: null,
    returnTrackingNo: null,
    returnReceivedAt: null,
  },
  {
    itemId: '66666666-6666-4666-8666-666666666663',
    orderId: '77777777-7777-4777-8777-777777777773',
    version: 1,
    status: 'RETURN_REQUESTED',
    fulfillment: 'DELIVERY',
    productId: products[0].productId,
    productName: 'LUMEN 공식 응원봉',
    ticketLinked: false,
    optionSummary: '화이트',
    quantity: 1,
    orderedAt: '2026-10-08T04:00:00.000Z',
    escrow: false,
    recipient: { nameMasked: '최*아', phoneMasked: '010-****-5568' },
    trackingCarrier: 'CJ',
    trackingNo: '601233449981',
    deliveredAt: '2026-10-10T06:00:00.000Z',
    pickedUpAt: null,
    returnReason: 'CHANGE_OF_MIND',
    returnTrackingNo: '702145530018',
    returnReceivedAt: null,
  },
  {
    itemId: '66666666-6666-4666-8666-666666666665',
    orderId: '77777777-7777-4777-8777-777777777775',
    version: 1,
    status: 'RETURN_REQUESTED',
    fulfillment: 'DELIVERY',
    productId: products[1].productId,
    productName: 'LUMEN 투어 티셔츠',
    ticketLinked: false,
    optionSummary: 'M',
    quantity: 1,
    orderedAt: '2026-10-09T04:00:00.000Z',
    escrow: false,
    recipient: { nameMasked: '정*호', phoneMasked: '010-****-1906' },
    trackingCarrier: 'CJ',
    trackingNo: '601233440126',
    deliveredAt: '2026-10-11T06:00:00.000Z',
    pickedUpAt: null,
    returnReason: 'DEFECT_OR_MISMATCH',
    returnTrackingNo: '702145530019',
    returnReceivedAt: null,
  },
  {
    itemId: '66666666-6666-4666-8666-666666666664',
    orderId: '77777777-7777-4777-8777-777777777774',
    version: 1,
    status: 'READY',
    fulfillment: 'PICKUP',
    productId: products[2].productId,
    productName: 'LUMEN 콘서트 주차권',
    ticketLinked: true,
    optionSummary: null,
    quantity: 1,
    orderedAt: '2026-10-14T12:00:00.000Z',
    escrow: false,
    recipient: null,
    trackingCarrier: null,
    trackingNo: null,
    deliveredAt: null,
    pickedUpAt: null,
    returnReason: null,
    returnTrackingNo: null,
    returnReceivedAt: null,
  },
];

const attendees = [
  { bookingNo: '2026101400123', name: '김*민', phone: '010-****-1234', round: '10/25(일) 18:00', seat: 'R1구역 12열 7·8번', quantity: 2 },
  { bookingNo: '2026101400219', name: '이*영', phone: '010-****-7730', round: '10/25(일) 18:00', seat: 'S1구역 3열 11~14번', quantity: 4 },
  { bookingNo: '2026101400226', name: '박*준', phone: '010-****-0412', round: '10/25(일) 18:00', seat: 'A2구역 16열 3번', quantity: 1 },
  { bookingNo: '2026101400230', name: '최*아', phone: '010-****-5568', round: '10/25(일) 18:00', seat: 'R2구역 5열 10·11번', quantity: 2 },
];
const exportLog = [
  { exportId: '88888888-8888-4888-8888-888888888881', exportedAt: '2026-10-24T06:02:00.000Z', actorDisplayName: '스텔라 관리자', actorRole: 'partner_admin', reason: '현장 명단 대조(동문 입장 확인용)', count: 4, format: 'XLSX', result: 'COMPLETED' },
];
const statements = [
  {
    statementId: '99999999-9999-4999-8999-999999999991',
    kind: 'PRODUCT',
    eventId: null,
    pg: 'TOSS',
    pgStore: 'ESCROW',
    periodStart: '2026-10-05',
    periodEnd: '2026-10-11',
    grossAmount: 3120000,
    refundAmount: 0,
    commissionAmount: 312000,
    commissionVat: 31200,
    offsetAmount: 0,
    payoutAmount: 2776800,
    revision: 1,
    supersedesId: null,
    status: 'NOTIFIED',
    disputeDueAt: '2026-10-14T14:59:59.000Z',
    payoutDate: '2026-10-16',
    payoutBankCode: '004',
    payoutAccountLast4: '1234',
  },
  {
    statementId: '99999999-9999-4999-8999-999999999992',
    kind: 'PRODUCT',
    eventId: null,
    pg: 'TOSS',
    pgStore: 'STANDARD',
    periodStart: '2026-10-05',
    periodEnd: '2026-10-11',
    grossAmount: 1284000,
    refundAmount: 42000,
    commissionAmount: 128400,
    commissionVat: 12840,
    offsetAmount: 0,
    payoutAmount: 1100760,
    revision: 1,
    supersedesId: null,
    status: 'PAID',
    disputeDueAt: '2026-10-14T14:59:59.000Z',
    payoutDate: '2026-10-16',
    payoutBankCode: '004',
    payoutAccountLast4: '1234',
  },
];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) return reject(new Error('too large'));
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type, x-reauth-token, if-match, idempotency-key, x-requested-with',
      'access-control-max-age': '600',
    });
    return res.end();
  }
  try {
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);

    if (method === 'POST' && path === '/v1/partner/auth/reauthentications') {
      return json(res, 200, { next: 'DONE', reauthToken: REAUTH_TOKEN, factors: ['password', 'totp', 'passkey'], expiresInSeconds: 300 });
    }
    if (method === 'GET' && path === '/v1/partner/products') {
      const ticketLinked = url.searchParams.get('ticketLinked');
      const q = url.searchParams.get('q')?.toLowerCase();
      const status = url.searchParams.getAll('status');
      const items = products.filter(
        (p) => (ticketLinked === null || String(p.ticketLinked) === ticketLinked) && (!q || p.name.toLowerCase().includes(q)) && (status.length === 0 || status.includes(p.status)),
      );
      return json(res, 200, { items, nextCursor: null });
    }
    if (method === 'POST' && path === '/v1/partner/products') {
      const id = uuid();
      const detail = {
        productId: id,
        name: body?.name ?? '새 상품',
        type: body?.type ?? 'MERCH',
        ticketLinked: Boolean(body?.ticketLinked),
        status: body?.status === 'DRAFT' ? 'DRAFT' : 'ON_SALE',
        price: body?.price ?? 0,
        shippingFee: body?.shippingFee ?? null,
        fulfillments: body?.fulfillments ?? ['PICKUP'],
        stockRemaining: body?.limitedQty ?? null,
        stockTotal: body?.limitedQty ?? null,
        saleStartsAt: null,
        saleEndsAt: null,
        linkedProductionId: productions.find((p) => events[p.productionId]?.some((e) => e.eventId === body?.linkedEventId))?.productionId ?? null,
        linkedProductionTitle: productions.find((p) => events[p.productionId]?.some((e) => e.eventId === body?.linkedEventId))?.title ?? null,
        version: 1,
        linkedEventId: body?.linkedEventId ?? null,
        returnShippingFee: body?.returnShippingFee ?? null,
        returnAddress: body?.returnAddress ?? null,
        limitedQty: body?.limitedQty ?? null,
        transferable: Boolean(body?.transferable),
        attributes: body?.attributes ?? {},
      };
      products.unshift(detail);
      return json(res, 201, detail, { etag: '"1"' });
    }
    const productMatch = /^\/v1\/partner\/products\/([^/]+)$/.exec(path);
    if (productMatch) {
      const p = products.find((x) => x.productId === productMatch[1]);
      if (!p) return problem(res, 404, 'not-found', '없는 상품입니다');
      if (method === 'GET') return json(res, 200, p, { etag: `"${p.version}"` });
      if (method === 'PATCH') {
        Object.assign(p, body ?? {}, { version: p.version + 1 });
        return json(res, 200, p, { etag: `"${p.version}"` });
      }
    }
    if (method === 'GET' && path === '/v1/partner/productions') return json(res, 200, { items: productions.map((p) => ({ ...p, eventCount: events[p.productionId]?.length ?? 0 })), nextCursor: null });
    const productionMatch = /^\/v1\/partner\/productions\/([^/]+)$/.exec(path);
    if (method === 'GET' && productionMatch) {
      const p = productions.find((x) => x.productionId === productionMatch[1]);
      if (!p) return problem(res, 404, 'not-found', '없는 공연입니다');
      return json(res, 200, { productionId: p.productionId, title: p.title, version: 1, events: events[p.productionId] ?? [] });
    }

    if (method === 'GET' && path === '/v1/partner/webhooks') return json(res, 200, { items: webhooks, nextCursor: null });
    if (method === 'POST' && path === '/v1/partner/webhooks') {
      const e = { endpointId: uuid(), url: body?.url ?? '', eventTypes: body?.eventTypes ?? [], status: 'ACTIVE', disabledReason: null, secretIssuedAt: now(), previousSecretValidUntil: null, version: 1 };
      webhooks.unshift(e);
      return json(res, 201, { ...e, secret: 'whsec_TESTONLY000000000000000000000000000000=' });
    }
    const webhookMatch = /^\/v1\/partner\/webhooks\/([^/]+)$/.exec(path);
    if (webhookMatch) {
      const e = webhooks.find((x) => x.endpointId === webhookMatch[1]);
      if (!e) return problem(res, 404, 'not-found', '없는 웹훅입니다');
      if (method === 'PATCH') {
        Object.assign(e, body ?? {}, { version: e.version + 1 });
        return json(res, 200, e);
      }
    }
    const rotationMatch = /^\/v1\/partner\/webhooks\/([^/]+)\/secret-rotations$/.exec(path);
    if (method === 'POST' && rotationMatch) {
      const e = webhooks.find((x) => x.endpointId === rotationMatch[1]);
      if (!e) return problem(res, 404, 'not-found', '없는 웹훅입니다');
      e.secretIssuedAt = now();
      e.previousSecretValidUntil = new Date(Date.now() + 86_400_000).toISOString();
      e.version += 1;
      return json(res, 201, { secret: 'whsec_TESTONLY111111111111111111111111111111=', previousSecretValidUntil: e.previousSecretValidUntil });
    }
    const deliveriesMatch = /^\/v1\/partner\/webhooks\/([^/]+)\/deliveries$/.exec(path);
    if (method === 'GET' && deliveriesMatch) {
      const status = url.searchParams.getAll('status');
      const items = deliveries.filter((d) => status.length === 0 || status.includes(d.status));
      return json(res, 200, { items, nextCursor: null });
    }
    const redeliverMatch = /^\/v1\/partner\/webhook-deliveries\/([^/]+)\/redeliveries$/.exec(path);
    if (method === 'POST' && redeliverMatch) {
      const d = deliveries.find((x) => x.deliveryId === redeliverMatch[1]);
      if (!d) return problem(res, 404, 'not-found', '없는 발송 기록입니다');
      d.status = 'PENDING';
      d.attemptCount += 1;
      d.nextAttemptAt = now();
      d.finishedAt = null;
      return json(res, 202, d);
    }

    if (method === 'GET' && path === '/v1/partner/merch-order-stats') {
      return json(res, 200, {
        totals: { orderCount: 4, quantity: 4, deliveryOrderCount: 3, pickupOrderCount: 1, cancelReturnCount: 1 },
        daily: [
          { date: '2026-10-12', orderCount: 1 },
          { date: '2026-10-14', orderCount: 3 },
        ],
        items: [
          { productId: products[0].productId, productName: products[0].name, orderCount: 2, quantity: 2, deliveryQuantity: 2, pickupQuantity: 0, cancelCount: 0, returnCount: 1 },
          { productId: products[1].productId, productName: products[1].name, orderCount: 1, quantity: 1, deliveryQuantity: 1, pickupQuantity: 0, cancelCount: 0, returnCount: 0 },
          { productId: products[2].productId, productName: products[2].name, orderCount: 1, quantity: 1, deliveryQuantity: 0, pickupQuantity: 1, cancelCount: 0, returnCount: 0 },
        ],
        nextCursor: null,
      });
    }
    if (method === 'GET' && path === '/v1/partner/merch-order-items') {
      const status = url.searchParams.getAll('status');
      const fulfillment = url.searchParams.get('fulfillment');
      const items = merchItems.filter((i) => (status.length === 0 || status.includes(i.status)) && (!fulfillment || i.fulfillment === fulfillment));
      return json(res, 200, { items, nextCursor: null });
    }
    const shipmentMatch = /^\/v1\/partner\/merch-order-items\/([^/]+)\/shipment$/.exec(path);
    if (method === 'PUT' && shipmentMatch) {
      const i = merchItems.find((x) => x.itemId === shipmentMatch[1]);
      if (!i) return problem(res, 404, 'not-found', '없는 항목입니다');
      i.trackingCarrier = body?.carrier ?? i.trackingCarrier;
      i.trackingNo = body?.trackingNo ?? i.trackingNo;
      i.status = 'SHIPPED';
      i.version += 1;
      return json(res, 200, { itemId: i.itemId, orderId: i.orderId, version: i.version, status: i.status, trackingCarrier: i.trackingCarrier, trackingNo: i.trackingNo });
    }
    const arrivalMatch = /^\/v1\/partner\/merch-order-items\/([^/]+)\/arrival-(confirmation|rejection)$/.exec(path);
    if (method === 'POST' && arrivalMatch) {
      const i = merchItems.find((x) => x.itemId === arrivalMatch[1]);
      if (!i) return problem(res, 404, 'not-found', '없는 항목입니다');
      if (arrivalMatch[2] === 'confirmation') {
        i.status = 'RETURN_RECEIVED';
        i.returnReceivedAt = now();
      } else {
        i.status = 'DISPUTED';
      }
      i.version += 1;
      return json(res, 200, { itemId: i.itemId, orderId: i.orderId, version: i.version, status: i.status, returnReceivedAt: i.returnReceivedAt });
    }
    if (method === 'POST' && path === '/v1/partner/merch-delivery-exports') {
      if (req.headers['x-reauth-token'] !== REAUTH_TOKEN) return problem(res, 403, 'reauth-required', '다시 인증해 주세요');
      const rows = ['주문번호,받는분,연락처,주소,상품,수량'];
      for (const i of merchItems.filter((x) => x.fulfillment === 'DELIVERY')) rows.push(`${i.orderId},${i.recipient?.nameMasked ?? ''},${i.recipient?.phoneMasked ?? ''},서울특별시 마포구 ****,${i.productName},${i.quantity}`);
      return text(res, 200, `\uFEFF${rows.join('\n')}`, 'text/csv; charset=utf-8', '배송명단.csv');
    }

    if (method === 'GET' && path === '/v1/partner/product-settlements') {
      return json(res, 200, { items: statements, nextCursor: null, awaitingSettlementAmount: 36_412_000 });
    }
    const disputeMatch = /^\/v1\/partner\/settlements\/([^/]+)\/disputes$/.exec(path);
    if (method === 'POST' && disputeMatch) {
      const s = statements.find((x) => x.statementId === disputeMatch[1]);
      if (!s) return problem(res, 404, 'not-found', '없는 정산서입니다');
      s.status = 'DISPUTED';
      return json(res, 202, {});
    }

    const attendeeMatch = /^\/v1\/partner\/events\/([^/]+)\/attendees$/.exec(path);
    if (method === 'GET' && attendeeMatch) {
      return json(res, 200, { items: attendees, nextCursor: null, totals: { bookings: attendees.length, tickets: attendees.reduce((s, a) => s + a.quantity, 0) } });
    }
    const exportMatch = /^\/v1\/partner\/events\/([^/]+)\/attendee-exports$/.exec(path);
    if (exportMatch) {
      if (method === 'GET') return json(res, 200, { items: exportLog, nextCursor: null });
      if (method === 'POST') {
        if (req.headers['x-reauth-token'] !== REAUTH_TOKEN) return problem(res, 403, 'reauth-required', '다시 인증해 주세요');
        exportLog.unshift({ exportId: uuid(), exportedAt: now(), actorDisplayName: '스텔라 관리자', actorRole: 'partner_admin', reason: body?.reason ?? '', count: attendees.length, format: body?.format ?? 'CSV', result: 'COMPLETED' });
        const rows = ['예매자,휴대폰,예매번호,회차,좌석,매수'];
        for (const a of attendees) rows.push(`${a.name},${a.phone},${a.bookingNo},${a.round},${a.seat},${a.quantity}`);
        return text(res, 200, `\uFEFF${rows.join('\n')}`, 'text/csv; charset=utf-8', '예매자명단.csv');
      }
    }

    return problem(res, 404, 'not-found', `가짜 API에 없는 경로입니다: ${method} ${path}`);
  } catch (e) {
    return problem(res, 400, 'bad-request', e instanceof Error ? e.message : '잘못된 요청입니다');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`partner fake api: http://127.0.0.1:${PORT} (origin ${ORIGIN})\n`);
});
