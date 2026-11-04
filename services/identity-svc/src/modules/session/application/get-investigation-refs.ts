// 조사 적재의 연결 값 조회(InvestigationRefService.BatchGetInvestigationRefs, inv-ingest만, identity §9.1 '조사용 값의 첫 구현', BUILD_ORDER BOT-045, I-T67 ①).
// 계정마다 연락처 가명·기기 가명·지난 1년 [가정]의 같은 본인확인 시도 기록. 원문 번호·이메일·연계정보는 돌려주지 않는다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { IDENTITY_CONFLICT_WINDOW_MS, INV_REF_BATCH_MAX } from '../domain/inv-ref.js';
import { type InvestigationRefsRow, SESSION_STORE, type SessionStore } from '../domain/ports.js';
import { InvRefError } from './inv-ref-error.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class GetInvestigationRefs {
  constructor(
    @Inject(SESSION_STORE) private readonly store: Pick<SessionStore, 'investigationRefsOf'>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** @throws InvRefError INVALID(500개를 넘거나 계정 ID 모양이 틀림) */
  async run(accountIds: readonly string[]): Promise<InvestigationRefsRow[]> {
    if (accountIds.length > INV_REF_BATCH_MAX) throw new InvRefError('INVALID', `계정은 한 번에 ${INV_REF_BATCH_MAX}개까지다`);
    if (!accountIds.every((x) => typeof x === 'string' && UUID.test(x))) throw new InvRefError('INVALID', '계정 ID 모양이 틀렸다');
    // 저장소는 소문자 UUID로 묻고, 응답의 account_id는 물은 모양 그대로 돌려준다(부르는 쪽이 문자열로 짝을 맞추게)
    const asked = [...new Set(accountIds)];
    const rows = await this.store.investigationRefsOf([...new Set(asked.map((x) => x.toLowerCase()))], this.clock.now() - IDENTITY_CONFLICT_WINDOW_MS);
    const byId = new Map(rows.map((r) => [r.accountId, r]));
    return asked.flatMap((x) => {
      const r = byId.get(x.toLowerCase());
      return r ? [{ ...r, accountId: x }] : [];
    });
  }
}
