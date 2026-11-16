// 회차 취소 요청의 시작 조립(BAT-420 GAT-110 P4, 빈 뼈대). main.ts가 부르고, 시험이 시작 조립을 따로 띄워 본다(architecture §8.6 '자주 놓친 결함').
// PEAKET_CORE_HTTP_URL이 있으면 소속 확인(owners), 판매 중지 집행 길(purchase·queue HTTP 또는 제어 gRPC 둘)이 있으면 판매 멈춤(stopper),
// purchase gRPC 클라이언트가 있으면 미리보기·진행률 읽기(reader)를 넣는다. 없는 것은 그 경로가 503으로 닫힌다.
import type { CommandExecutor } from './modules/commands/domain/ports.js';
import type { EventOwnerLookup, EventRefundReader, EventSaleStopper } from './modules/event-cancellations/domain/ports.js';

export interface EventCancellationDepsInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 판매 중지 집행에 쓰는 명령 실행기(main.ts의 HttpCommandExecutor) */
  readonly executor: CommandExecutor;
  /** purchase-svc EventRefundService gRPC 클라이언트(PEAKET_PURCHASE_GRPC_ADDR가 있을 때) */
  readonly refunds?: EventRefundReader;
  readonly internalToken?: string;
}

export interface EventCancellationDeps {
  readonly stopper?: EventSaleStopper;
  readonly reader?: EventRefundReader;
  readonly owners?: EventOwnerLookup;
}

export function eventCancellationDepsFromEnv(_i: EventCancellationDepsInput): EventCancellationDeps {
  throw new Error('아직 없음');
}
