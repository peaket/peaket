// 회차 취소 요청의 시작 조립(BAT-420 GAT-110 P4). main.ts가 부르고, 시험이 시작 조립을 따로 띄워 본다(architecture §8.6 '자주 놓친 결함').
// PEAKET_CORE_HTTP_URL이 있으면 소속 확인(owners), 판매 중지 집행 길(purchase·queue HTTP 둘 또는 제어 gRPC 둘)이 있으면 판매 멈춤(stopper),
// purchase gRPC 클라이언트가 있으면 미리보기·진행률 읽기(reader)와 환급 미룸(holds, SetEventRefundHold, BAT-420 몫 D)을 넣는다. 없는 것은 그 경로가 503으로 닫힌다.
import { createExternalHttpClient } from '@peaket/platform';
import { HttpCoreEventOwners } from './adapters/http-core-event-owners.js';
import { HttpEventSaleStopper } from './adapters/event-sale-stopper.js';
import type { CommandExecutor } from './modules/commands/domain/ports.js';
import type { EventOwnerLookup, EventRefundHolds, EventRefundReader, EventSaleStopper } from './modules/event-cancellations/domain/ports.js';

export interface EventCancellationDepsInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 판매 중지 집행에 쓰는 명령 실행기(main.ts의 HttpCommandExecutor) */
  readonly executor: CommandExecutor;
  /** purchase-svc EventRefundService gRPC 클라이언트(PEAKET_PURCHASE_GRPC_ADDR가 있을 때). hold가 있으면 미룸으로도 쓴다 */
  readonly refunds?: EventRefundReader & Partial<EventRefundHolds>;
  readonly internalToken?: string;
}

export interface EventCancellationDeps {
  readonly stopper?: EventSaleStopper;
  readonly reader?: EventRefundReader;
  readonly owners?: EventOwnerLookup;
  /** purchase gRPC 클라이언트가 미룸(hold)도 하면 그것(BAT-420 몫 D). 없으면 CANCEL 요청·판정·확정이 503이다 */
  readonly holds?: EventRefundHolds;
}

const has = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * 웨이브 끝 리뷰 S2(빈 뼈대, 아직 쓰지 않는다): 파트너 경로 DB 풀 주소. PEAKET_PARTNER_DATABASE_URL이 있으면 그것,
 * 없으면 local·ci만 관제 주소(mainUrl)를 쓰고 그 밖(운영·스테이징·PEAKET_ENV 없음)은 시작 실패(던짐). main.ts가 부른다
 */
export function partnerDatabaseUrlFromEnv(_env: Readonly<Record<string, string | undefined>>, _mainUrl: string): string {
  throw new Error('아직 없음');
}

export function eventCancellationDepsFromEnv(i: EventCancellationDepsInput): EventCancellationDeps {
  const coreUrl = i.env.PEAKET_CORE_HTTP_URL;
  const httpSale = has(i.env.PEAKET_PURCHASE_HTTP_URL) && has(i.env.PEAKET_QUEUE_HTTP_URL);
  const grpcSale = has(i.env.PEAKET_PURCHASE_CONTROL_GRPC_ADDR) && has(i.env.PEAKET_QUEUE_CONTROL_GRPC_ADDR);
  return {
    ...(httpSale || grpcSale ? { stopper: new HttpEventSaleStopper(i.executor) } : {}),
    ...(i.refunds ? { reader: i.refunds } : {}),
    ...(i.refunds && typeof i.refunds.hold === 'function' ? { holds: i.refunds as EventRefundHolds } : {}),
    ...(has(coreUrl)
      ? { owners: new HttpCoreEventOwners(createExternalHttpClient({ provider: 'core-svc', baseUrl: coreUrl, timeoutCapMs: 5_000 }), i.internalToken) }
      : {}),
  };
}
