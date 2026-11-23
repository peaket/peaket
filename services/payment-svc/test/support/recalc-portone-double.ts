// F-07-8 다시 계산 시험의 포트원 플랫폼 전송 짝 대역. F-07-7 계획 §5.1(나)의 `PortonePlatformTransport`를 `implements`한다.
// 이 대역은 수기 정산건 취소(cancelManualTransfer) 호출 기록과 실패 주입만 한다. 나머지 메서드는 이 시험에서 부르면 안 되므로 던진다.
// HTTP 짝 시험(대역 서버 portone-platform-fake.ts)은 F-07-7 시험이 맡는다. 실제 포트원은 부르지 않는다.
import type { PortonePlatformTransport } from '../../src/modules/settlement/domain/ports.js';

const unused = (name: string): never => {
  throw new Error(`F-07-8 시험은 포트원 ${name}를 부르지 않는다`);
};

export class RecalcPortonePlatform implements PortonePlatformTransport {
  readonly cancels: string[] = [];
  readonly #failures = new Map<string, number>();

  failCancel(transferId: string, times = 1): void {
    this.#failures.set(transferId, times);
  }

  async cancelManualTransfer(transferId: string): Promise<void> {
    this.cancels.push(transferId);
    const left = this.#failures.get(transferId) ?? 0;
    if (left > 0) {
      this.#failures.set(transferId, left - 1);
      throw Object.assign(new Error('portone 502'), { status: 502 });
    }
  }

  async lookupHolder(): Promise<{ holderName: string } | null> {
    return unused('lookupHolder');
  }
  async registerPartner(): Promise<{ partnerId: string }> {
    return unused('registerPartner');
  }
  async updatePartnerAccount(): Promise<void> {
    unused('updatePartnerAccount');
  }
  async getPartner(): Promise<{ partnerId: string; bankCode: string; accountLast4: string; holderName: string; scheduled: { bankCode: string; accountLast4: string; holderName: string } | null }> {
    return unused('getPartner');
  }
  async createManualTransfer(): Promise<{ transferId: string; created: boolean }> {
    return unused('createManualTransfer');
  }
  async getManualTransfer(): Promise<{ transferId: string; amount: number; settlementDate: string; status: string } | null> {
    return unused('getManualTransfer');
  }
  async listPayouts(): Promise<readonly { payoutId: string; transferId: string; status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'STOPPED' | 'CANCELLED'; completedAt: Date | null; failureCode: string | null }[]> {
    return unused('listPayouts');
  }
  async listAccountTransfers(): Promise<
    readonly { transferId: string; type: 'WITHDRAWAL' | 'DEPOSIT'; withdrawalType: string | null; payoutId: string | null; amount: number; bankCode: string | null; accountLast4: string | null; holderName: string | null; balance: number | null; transferredAt: Date }[]
  > {
    return unused('listAccountTransfers');
  }
  async listPartnerSettlements(): Promise<readonly { partnerId: string; transferId: string; amount: number }[]> {
    return unused('listPartnerSettlements');
  }
}
