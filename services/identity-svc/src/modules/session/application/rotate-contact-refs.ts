// 키 회전 뒤 EMAIL 연락처 가명을 새 판으로 다시 계산한다(정비 contact-ref-rotate, 하루 한 번, docs/security/secrets-and-keys.md 회전 절차 ④,
// docs/features/identity.md §9.1 '조사용 가명 키 회전 이음의 첫 구현', BUILD_ORDER BOT-046). 새 판 키만 쓰고 옛 값은 DB의 지금 값으로 ref_prev에 둔다(이음 기간에만).
// 이음 설정이 남아 있는 동안은 이음 끝 뒤에도 돈다(탈퇴 유예에서 돌아온 계정 등 남은 옛 판 행을 바꾸되, 옛 판 값은 더 두지 않는다). PHONE은 원문이 없어 다음 본인확인 때 바꾼다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { contactEmail, invRefPrefix } from '../domain/inv-ref.js';
import { INV_REFS, type InvRefBridges, SESSION_STORE, type SessionStore } from '../domain/ports.js';

@Injectable()
export class RotateContactRefs {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(INV_REFS) private readonly ring: { ref(label: 'contact', value: string): string | undefined; writeVersion(label: 'contact'): number | null },
    private readonly bridges: InvRefBridges,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 바꾼 행 수. 이음 설정이 없거나 라벨 키가 없으면 0(다음 정비에 다시) */
  async run(batch: number, maxBatches = 1_000): Promise<number> {
    const bridge = this.bridges.bridgeOf('contact');
    const v = bridge?.writeVersion ?? this.ring.writeVersion('contact');
    if (!bridge || v === null) return 0;
    const inBridge = this.clock.now() < bridge.until;
    const prefix = invRefPrefix(v);
    let n = 0;
    let after = '';
    for (let round = 0; round < maxBatches; round++) {
      const rows = await this.store.contactRefsToRotate(after, prefix, batch);
      if (rows.length === 0) break;
      after = rows[rows.length - 1]!.accountId;
      for (const r of rows) {
        const email = contactEmail(r.email);
        if (email === null) continue;
        const ref = this.ring.ref('contact', email);
        if (!ref) return n;
        // 읽은 뒤 탈퇴·병합했을 수 있다: 계정을 잠그고 상태를 다시 본 뒤 쓴다
        const wrote = await this.store.transaction(async (tx) => {
          await tx.lockAccount(r.accountId);
          if ((await tx.accountStatusOf(r.accountId)) !== 'ACTIVE') return false;
          await tx.setContactRef({ accountId: r.accountId, kind: 'EMAIL', ref, refPrev: inBridge ? r.ref : null, now: this.clock.now() });
          return true;
        });
        if (wrote) n += 1;
      }
      if (rows.length < batch) break;
    }
    return n;
  }
}
