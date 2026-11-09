// 쓰지 못한 EMAIL 연락처 가명을 다시 계산한다(정비 contact-ref-backfill, 하루 한 번, identity §9.1 '조사용 값의 첫 구현', BUILD_ORDER BOT-045).
// 라벨 키가 없어 가입 때 쓰지 못한 행을 account.email(원문)로 채운다. PHONE은 원문을 두지 않아 다음 본인확인 때 쓴다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { contactEmail } from '../domain/inv-ref.js';
import { INV_REFS, type InvRefs, SESSION_STORE, type SessionStore } from '../domain/ports.js';

@Injectable()
export class BackfillContactRefs {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(INV_REFS) private readonly refs: InvRefs,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * 채운 행 수. 묶음(batch)씩 ID 순으로 끝까지 돈다(묶음 수 상한 maxBatches). 맞출 수 없는 이메일은 건너뛰고(커서가 지나가 앞을 막지 않는다),
   * 라벨 키가 없으면 멈춘다(다음 정비에 다시). 탈퇴 유예·정리 중 계정에는 새 가명을 만들지 않는다(ACTIVE만, 새 맥락 리뷰 낮음 4)
   */
  async run(batch: number, maxBatches = 100): Promise<number> {
    let n = 0;
    let after = '';
    for (let round = 0; round < maxBatches; round++) {
      const rows = await this.store.accountsMissingEmailRef(after, batch);
      if (rows.length === 0) break;
      after = rows[rows.length - 1]!.accountId;
      const done = await this.#fill(rows);
      n += done.filled;
      if (done.stopped || rows.length < batch) break;
    }
    return n;
  }

  /** 그 묶음에서 채운 수와, 라벨 키가 없어 멈췄는지(멈추면 다음 묶음을 읽지 않는다) */
  async #fill(rows: { accountId: string; email: string }[]): Promise<{ filled: number; stopped: boolean }> {
    let n = 0;
    for (const r of rows) {
      const email = contactEmail(r.email);
      if (email === null) continue;
      const ref = this.refs.ref('contact', email);
      if (!ref) return { filled: n, stopped: true };
      // 읽은 뒤 탈퇴·병합했을 수 있다: 계정을 잠그고 상태를 다시 본 뒤 쓴다
      const wrote = await this.store.transaction(async (tx) => {
        await tx.lockAccount(r.accountId);
        const st = await tx.accountStatusOf(r.accountId);
        if (st !== 'ACTIVE') return false;
        // 빠졌던 행이라 옛 판 값이 없다(relay는 옛 판 키를 받지 않는다). 남은 값을 건드리지 않는다
        await tx.setContactRef({ accountId: r.accountId, kind: 'EMAIL', ref, refPrev: null, now: this.clock.now() });
        return true;
      });
      if (wrote) n += 1;
    }
    return { filled: n, stopped: false };
  }
}
