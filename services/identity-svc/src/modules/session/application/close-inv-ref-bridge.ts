// 키 회전의 이음을 닫는다(정비 inv-ref-bridge-close, 하루 한 번, docs/security/secrets-and-keys.md 회전 절차 ③⑧, docs/features/identity.md §9.1 '조사용 가명 키 회전 이음의 첫 구현',
// BUILD_ORDER BOT-046). 이음 끝 + 7일 [가정](조사 적재의 잇기 작업이 돌 여유)이 지나면 옛 판 값을 지우고, 옛 판으로 남은 기기 행(이음 기간에 다시 로그인하지 않은 기기)을 지운다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { invRefPrefix } from '../domain/inv-ref.js';
import { INV_REFS, type InvRefBridge, type InvRefBridges, SESSION_STORE, type SessionStore } from '../domain/ports.js';

/** 이음 끝 뒤 옛 판 값을 지우기까지 기다리는 시간 [가정] */
export const INV_REF_BRIDGE_GRACE_MS = 7 * 86_400_000;


@Injectable()
export class CloseInvRefBridge {
  constructor(
    @Inject(SESSION_STORE) private readonly store: Pick<SessionStore, 'closeInvRefBridge'>,
    @Inject(INV_REFS) private readonly ring: InvRefBridges,
    @Inject(CLOCK) private readonly clock: Clock,
    /** 한 번에 지우는 행 수 [가정] */
    private readonly chunk = 1_000,
  ) {}

  /** 라벨마다 닫았으면 그 수, 아직이거나 이음이 없으면 null */
  async run(): Promise<{ device: { cleared: number; removed: number } | null; contact: { cleared: number } | null }> {
    const ready = (b: InvRefBridge | null) => b !== null && b.until + INV_REF_BRIDGE_GRACE_MS <= this.clock.now();
    const d = this.ring.bridgeOf('device');
    const c = this.ring.bridgeOf('contact');
    return {
      device: d && ready(d) ? await this.store.closeInvRefBridge('device', invRefPrefix(d.prevVersion), this.chunk) : null,
      contact: c && ready(c) ? { cleared: (await this.store.closeInvRefBridge('contact', invRefPrefix(c.prevVersion), this.chunk)).cleared } : null,
    };
  }
}
