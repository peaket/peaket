// 파트너 실시간 판매 현황 읽기(GET /v1/partner/events/{eventId}/live-snapshot, FR-026, control-tower §11, C-T20).
// 소속은 core 판매 설정의 promoterId와 세션 테넌트로만 본다(경로·본문의 값은 쓰지 않는다). 다른 파트너 회차는 403(openapi), 없는 회차·판매 승인 전 회차는 404,
// 소속 확인 실패는 503 authz-unavailable, 실시간 표를 읽지 못하거나 판매 대상 좌석 수를 모르면 503 dependency-unavailable(Retry-After 60)이다.
// 소속을 확인한 뒤에만 보드에 관심 회차로 올린다(남의 회차 ID로 조회를 늘리지 못한다).
import { RtProblem, RtSourceFailure, type PartnerLiveSnapshot } from '../domain/realtime-table.js';
import type { EventOwners } from '../domain/ports.js';
import type { RtBoard } from './rt-board.js';

/** 503에 싣는 다시 묻기 하한(초). 화면은 1분마다 묻는다 */
export const LIVE_SNAPSHOT_RETRY_AFTER_SECONDS = 60;

export class GetPartnerLiveSnapshot {
  constructor(
    private readonly board: RtBoard,
    private readonly owners: EventOwners | undefined,
  ) {}

  async run(eventId: string, tenantId: string): Promise<PartnerLiveSnapshot> {
    if (!this.owners) throw new RtProblem('authz-unavailable', 503, '권한을 확인하지 못했습니다');
    let owner: { readonly promoterId: string } | undefined;
    try {
      owner = await this.owners.find(eventId);
    } catch {
      throw new RtProblem('authz-unavailable', 503, '권한을 확인하지 못했습니다');
    }
    if (!owner) throw new RtProblem('not-found', 404, '찾을 수 없습니다');
    if (owner.promoterId !== tenantId) throw new RtProblem('forbidden', 403, '다른 파트너의 회차입니다');
    let view: PartnerLiveSnapshot | undefined;
    try {
      view = await this.board.partner(eventId);
    } catch (e) {
      if (e instanceof RtSourceFailure) throw new RtProblem('dependency-unavailable', 503, '의존 서비스를 잠시 쓸 수 없습니다', LIVE_SNAPSHOT_RETRY_AFTER_SECONDS);
      throw e;
    }
    if (!view) throw new RtProblem('dependency-unavailable', 503, '의존 서비스를 잠시 쓸 수 없습니다', LIVE_SNAPSHOT_RETRY_AFTER_SECONDS);
    return view;
  }
}
