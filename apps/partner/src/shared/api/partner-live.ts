// 파트너 화면이 부르는 실제 API(openapi partner 태그). 계약의 operationId만 쓰고, 화면마다 fetch를 만들지 않는다.
// 실행부는 늦게 가져온다(await import) — 첫 화면 JS에 API 실행부를 싣지 않는다(docs/frontend.md §4.1).
import type { ProblemShape } from './problem';

export type ProductStatus = 'DRAFT' | 'NOT_STARTED' | 'ON_SALE' | 'SOLD_OUT' | 'ENDED' | 'HIDDEN';
export type Fulfillment = 'DELIVERY' | 'PICKUP' | 'WALLET';
export type WebhookEventType =
  | 'order.confirmed'
  | 'order.cancelled'
  | 'event.sold_out'
  | 'event.cancelled'
  | 'event.postponed'
  | 'statement.notified'
  | 'payout.completed'
  | 'payout.failed';

export interface PartnerProductSummary {
  productId: string;
  name: string;
  type: string;
  ticketLinked: boolean;
  status: ProductStatus;
  price: number;
  shippingFee: number | null;
  fulfillments: Fulfillment[];
  stockRemaining: number | null;
  stockTotal: number | null;
  saleStartsAt: string | null;
  saleEndsAt: string | null;
  linkedProductionId: string | null;
  linkedProductionTitle: string | null;
}

export interface PartnerProductDetail extends PartnerProductSummary {
  version: number;
  linkedEventId: string | null;
  returnShippingFee: number | null;
  returnAddress: string | null;
  limitedQty: number | null;
  transferable: boolean;
  attributes: Record<string, unknown>;
}

export interface PartnerProductPage {
  items: PartnerProductSummary[];
  nextCursor: string | null;
}

export interface PartnerProductCreate {
  type: string;
  name: string;
  price: number;
  shippingFee?: number | null;
  returnShippingFee?: number | null;
  returnAddress?: string | null;
  ticketLinked: boolean;
  linkedEventId?: string | null;
  limitedQty?: number | null;
  fulfillments: Fulfillment[];
  transferable?: boolean;
  status: 'DRAFT' | 'PUBLISHED';
  attributes?: Record<string, unknown>;
}

/** 고치기는 숨김 상태도 보낼 수 있다(openapi PartnerProductUpdate.status). */
export type PartnerProductUpdateBody = Omit<PartnerProductCreate, 'status'> & { status?: 'DRAFT' | 'PUBLISHED' | 'HIDDEN' };

export interface WebhookEndpoint {
  endpointId: string;
  url: string;
  eventTypes: WebhookEventType[];
  status: 'ACTIVE' | 'DISABLED';
  disabledReason: 'PARTNER' | 'FAILING' | null;
  secretIssuedAt: string;
  previousSecretValidUntil: string | null;
  version: number;
}

export interface WebhookDelivery {
  deliveryId: string;
  webhookId: string;
  eventType: string;
  status: 'PENDING' | 'RETRYING' | 'SUCCEEDED' | 'DEAD';
  attemptCount: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface MerchOrderItem {
  itemId: string;
  orderId: string;
  version: number;
  status:
    | 'READY'
    | 'SHIPPED'
    | 'DELIVERED'
    | 'PICKED_UP'
    | 'LOCKED'
    | 'RETURN_REQUESTED'
    | 'RETURN_RECEIVED'
    | 'DISPUTED'
    | 'CANCELLED'
    | 'REFUNDED';
  fulfillment: Fulfillment;
  productId: string;
  productName: string;
  ticketLinked: boolean;
  optionSummary: string | null;
  quantity: number;
  orderedAt: string;
  escrow: boolean;
  recipient: { nameMasked: string; phoneMasked: string } | null;
  trackingCarrier: string | null;
  trackingNo: string | null;
  deliveredAt: string | null;
  pickedUpAt: string | null;
  returnReason: 'CHANGE_OF_MIND' | 'DEFECT_OR_MISMATCH' | null;
  returnTrackingNo: string | null;
  returnReceivedAt: string | null;
}

export interface MerchOrderItemPage {
  items: MerchOrderItem[];
  nextCursor: string | null;
}

export interface MerchOrderStats {
  totals: {
    orderCount: number;
    quantity: number;
    deliveryOrderCount: number;
    pickupOrderCount: number;
    cancelReturnCount: number;
  };
  daily: { date: string; orderCount: number }[];
  items: {
    productId: string;
    productName: string;
    orderCount: number;
    quantity: number;
    deliveryQuantity: number;
    pickupQuantity: number;
    cancelCount: number;
    returnCount: number;
  }[];
  nextCursor: string | null;
}

export interface SettlementStatement {
  statementId?: string;
  kind?: 'EVENT' | 'PRODUCT';
  eventId?: string | null;
  pg?: 'TOSS' | 'PORTONE';
  pgStore?: 'STANDARD' | 'ESCROW';
  periodStart?: string;
  periodEnd?: string;
  grossAmount?: number;
  refundAmount?: number;
  commissionAmount?: number;
  commissionVat?: number;
  offsetAmount?: number;
  payoutAmount?: number;
  revision?: number;
  supersedesId?: string | null;
  status?:
    | 'CALCULATED'
    | 'NOTIFIED'
    | 'DISPUTED'
    | 'CONFIRMED'
    | 'HELD'
    | 'SCHEDULED'
    | 'FAILED'
    | 'PAID'
    | 'CARRIED_OVER'
    | 'SUPERSEDED';
  holdReason?: 'KYC' | 'ACCOUNT_CHANGE' | 'BALANCE' | 'ACCOUNT_MISMATCH' | 'SALE_SUSPENDED';
  disputeDueAt?: string;
  payoutDate?: string;
  payoutBankCode?: string;
  payoutAccountLast4?: string;
}

export interface ProductSettlementPage {
  items: SettlementStatement[];
  nextCursor: string | null;
  awaitingSettlementAmount?: number;
}

export interface AttendeeRow {
  bookingNo: string;
  name: string;
  phone: string;
  round: string;
  seat: string;
  quantity: number;
}

export interface AttendeePage {
  items: AttendeeRow[];
  nextCursor: string | null;
  totals?: { bookings: number; tickets: number };
}

export interface AttendeeExport {
  exportId: string;
  exportedAt: string;
  actorDisplayName: string;
  actorRole: string;
  reason: string;
  count: number;
  format: 'CSV' | 'XLSX' | 'PDF';
  result: 'COMPLETED' | 'FAILED';
}

export interface AttendeeExportPage {
  items: AttendeeExport[];
  nextCursor: string | null;
}

export interface ProductionOption {
  productionId: string;
  title: string;
}

export interface EventOption {
  eventId: string;
  startsAt: string;
}

export interface DownloadedFile {
  blob: Blob;
  filename: string;
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // 시험·아주 오래된 브라우저의 대체값. 서버는 UUIDv4만 받는다.
  const b = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** CSV는 api-client가 text로 읽고, XLSX·PDF는 Blob으로 읽는다. 화면은 둘 다 파일로 내려받는다. */
export function asBlob(data: Blob | string, headers: Headers): Blob {
  if (data instanceof Blob) return data;
  return new Blob([data], { type: headers.get('content-type') ?? 'text/csv; charset=utf-8' });
}

function filenameOf(headers: Headers, fallback: string): string {
  const cd = headers.get('content-disposition');
  if (!cd) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star?.[1]) return decodeURIComponent(star[1]);
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain?.[1] ? decodeURIComponent(plain[1]) : fallback;
}

const load = () => import('@/shared/api');

/* ---------- 상품 ---------- */

export async function listProducts(
  query: { ticketLinked?: boolean; status?: ProductStatus[]; linkedProductionId?: string; q?: string; cursor?: string; limit?: number },
  signal?: AbortSignal,
): Promise<PartnerProductPage> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request<PartnerProductPage>(OPERATIONS.listPartnerProducts, { query, signal });
}

export async function getProduct(productId: string, signal?: AbortSignal): Promise<PartnerProductDetail> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request<PartnerProductDetail>(OPERATIONS.getPartnerProduct, { params: { productId }, signal });
}

export async function createProduct(body: PartnerProductCreate): Promise<PartnerProductDetail> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request<PartnerProductDetail>(OPERATIONS.createPartnerProduct, { body });
}

export async function updateProduct(productId: string, body: PartnerProductUpdateBody, version: number): Promise<PartnerProductDetail> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request<PartnerProductDetail>(OPERATIONS.updatePartnerProduct, {
    params: { productId },
    body,
    ifMatch: `"${version}"`,
  });
}

export async function listProductions(signal?: AbortSignal): Promise<ProductionOption[]> {
  const { partnerApi, OPERATIONS } = await load();
  const r = await partnerApi().request<{ items: { productionId: string; title: string }[] }>(OPERATIONS.listPartnerProductions, {
    query: { limit: 100 },
    signal,
  });
  return r.items.map((p) => ({ productionId: p.productionId, title: p.title }));
}

export async function listProductionEvents(productionId: string, signal?: AbortSignal): Promise<EventOption[]> {
  const { partnerApi, OPERATIONS } = await load();
  const r = await partnerApi().request<{ events: { eventId: string; startsAt: string }[] }>(OPERATIONS.getPartnerProduction, {
    params: { productionId },
    signal,
  });
  return r.events.map((e) => ({ eventId: e.eventId, startsAt: e.startsAt }));
}

/* ---------- 웹훅 ---------- */

export async function listWebhooks(signal?: AbortSignal): Promise<WebhookEndpoint[]> {
  const { partnerApi, OPERATIONS } = await load();
  const r = await partnerApi().request<{ items: WebhookEndpoint[] }>(OPERATIONS.listPartnerWebhooks, { query: { limit: 100 }, signal });
  return r.items;
}

export async function createWebhook(body: { url: string; eventTypes: WebhookEventType[] }): Promise<WebhookEndpoint & { secret: string }> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request<WebhookEndpoint & { secret: string }>(OPERATIONS.createPartnerWebhook, { body });
}

export async function updateWebhook(
  endpointId: string,
  body: { url?: string; eventTypes?: WebhookEventType[]; status?: 'ACTIVE' | 'DISABLED' },
  version: number,
): Promise<WebhookEndpoint> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request<WebhookEndpoint>(OPERATIONS.updatePartnerWebhook, { params: { endpointId }, body, ifMatch: `"${version}"` });
}

export async function rotateWebhookSecret(endpointId: string): Promise<{ secret: string; previousSecretValidUntil: string }> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request<{ secret: string; previousSecretValidUntil: string }>(OPERATIONS.createPartnerWebhookSecretRotation, {
    params: { endpointId },
    timeoutMs: 20_000,
  });
}

export async function listWebhookDeliveries(
  endpointId: string,
  query: { status?: string[]; cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<{ items: WebhookDelivery[]; nextCursor: string | null }> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request<{ items: WebhookDelivery[]; nextCursor: string | null }>(OPERATIONS.listPartnerWebhookDeliveries, {
    params: { endpointId },
    query,
    signal,
  });
}

export async function redeliverWebhook(deliveryId: string): Promise<WebhookDelivery> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request<WebhookDelivery>(OPERATIONS.createPartnerWebhookDeliveryRedelivery, { params: { deliveryId } });
}

/* ---------- 배송·반품 ---------- */

export async function listMerchOrderStats(
  query: { from?: string; to?: string; linkedProductionId?: string; cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<MerchOrderStats> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request<MerchOrderStats>(OPERATIONS.listPartnerMerchOrderStats, { query, signal });
}

export async function listMerchOrderItems(
  query: { status?: string[]; fulfillment?: Fulfillment; productId?: string; from?: string; to?: string; cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<MerchOrderItemPage> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request<MerchOrderItemPage>(OPERATIONS.listPartnerMerchOrderItems, { query, signal });
}

export async function putShipment(itemId: string, body: { carrier: string; trackingNo: string }, version: number): Promise<{ itemId: string; version: number; status: MerchOrderItem['status'] }> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request(OPERATIONS.putPartnerMerchOrderItemShipment, { params: { itemId }, body, ifMatch: `"${version}"` });
}

export async function confirmArrival(itemId: string): Promise<{ itemId: string; version: number; status: MerchOrderItem['status'] }> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request(OPERATIONS.createPartnerMerchOrderItemArrivalConfirmation, {
    params: { itemId },
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function rejectArrival(itemId: string, body: { reasonCode: 'DAMAGED_BY_BUYER' | 'VALUE_LOST_BY_USE'; evidence: string }): Promise<{ itemId: string; version: number; status: MerchOrderItem['status'] }> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request(OPERATIONS.createPartnerMerchOrderItemArrivalRejection, {
    params: { itemId },
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function confirmPickup(voucherToken: string): Promise<unknown> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request(OPERATIONS.createPartnerMerchPickup, { body: { voucherToken }, idempotencyKey: newIdempotencyKey() });
}

export async function importShipments(file: File): Promise<{ totalRows: number; appliedCount: number; failedRows: { row: number; itemId: string | null; reason: string }[] }> {
  const { partnerApi, OPERATIONS } = await load();
  const body = new FormData();
  body.append('file', file, file.name);
  return partnerApi().request(OPERATIONS.createPartnerMerchShipmentImport, {
    body,
    headers: { 'X-Requested-With': 'peaket-partner' },
    idempotencyKey: newIdempotencyKey(),
    timeoutMs: 60_000,
  });
}

export async function createDeliveryExport(
  token: string,
  body: { reason: string; format: 'CSV' | 'XLSX' | 'PDF'; status?: string[] },
): Promise<DownloadedFile> {
  const { partnerApi, OPERATIONS } = await load();
  const r = await partnerApi().send<Blob | string>(OPERATIONS.createPartnerMerchDeliveryExport, {
    body,
    headers: { 'X-Reauth-Token': token },
    timeoutMs: 60_000,
  });
  return { blob: asBlob(r.data, r.headers), filename: filenameOf(r.headers, `배송명단.${body.format.toLowerCase()}`) };
}

/* ---------- 상품 정산 ---------- */

export async function listProductSettlements(
  query: { from?: string; to?: string; pgStore?: 'STANDARD' | 'ESCROW'; cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<ProductSettlementPage> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request<ProductSettlementPage>(OPERATIONS.listPartnerProductSettlements, { query, signal });
}

export async function createSettlementDispute(
  statementId: string,
  body: { reasonCode: 'GROSS_AMOUNT' | 'REFUND_AMOUNT' | 'COMMISSION' | 'OFFSET' | 'OTHER'; detail?: string },
): Promise<void> {
  const { partnerApi, OPERATIONS } = await load();
  await partnerApi().request(OPERATIONS.createPartnerSettlementDispute, {
    params: { statementId },
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

/* ---------- 예매자 명단·다운로드 이력 ---------- */

export async function listAttendees(
  eventId: string,
  query: { orderId?: string; tier?: string; cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<AttendeePage> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request<AttendeePage>(OPERATIONS.listPartnerEventAttendees, { params: { eventId }, query, signal });
}

export async function listAttendeeExports(
  eventId: string,
  query: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<AttendeeExportPage> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request<AttendeeExportPage>(OPERATIONS.listPartnerEventAttendeeExports, { params: { eventId }, query, signal });
}

export async function createAttendeeExport(
  eventId: string,
  token: string,
  body: { reason: string; format: 'CSV' | 'XLSX' | 'PDF' },
): Promise<DownloadedFile> {
  const { partnerApi, OPERATIONS } = await load();
  const r = await partnerApi().send<Blob | string>(OPERATIONS.createPartnerEventAttendeeExport, {
    params: { eventId },
    body,
    headers: { 'X-Reauth-Token': token },
    timeoutMs: 60_000,
  });
  return { blob: asBlob(r.data, r.headers), filename: filenameOf(r.headers, `예매자명단.${body.format.toLowerCase()}`) };
}

/** 시험·화면이 같은 모양으로 오류를 읽도록 내보낸다. */
export type PartnerApiProblem = ProblemShape;
