// 입금 대기 쓰기의 값을 만든다(docs/features/payment.md §6 '입금 확인의 첫 구현', BUILD_ORDER HOT-151). 승인 실행기와 조회 실행기가 트랜잭션에 들어가기 전에 부른다.
// 이 층은 어댑터를 가져오지 않는다(포트로만 쓴다, architecture §3.1). 계좌번호와 secret은 로그·지표에 싣지 않는다.
import type { ConfirmVirtualAccount } from '../domain/payment-gateway.js';
import type { PaymentDepositLog, PaymentDepositSignals } from '../domain/ports.js';
import { type DepositWrite, depositSecretHashOf, type VirtualAccountCipher } from '../domain/virtual-account.js';

/** 입금 대기 쓰기가 쓰는 포트 */
export interface DepositWriteDeps {
  cipher: VirtualAccountCipher;
  log: PaymentDepositLog;
  signals: PaymentDepositSignals;
}

/**
 * 답의 발급 정보 → 저장할 값. 던지지 않는다.
 * @param va 답의 발급 정보. 없으면 SEV2 로그 뒤 undefined
 */
export async function depositWriteOf(deps: DepositWriteDeps, ids: { readonly paymentId: string; readonly orderId: string }, va: ConfirmVirtualAccount | undefined): Promise<DepositWrite | undefined> {
  const { log } = deps;
  if (va === undefined) {
    quietly(() => log.infoMissing({ orderId: ids.orderId }));
    return undefined;
  }
  const dueAtMs = va.dueAt === undefined ? Number.NaN : Date.parse(va.dueAt);
  // 빠진 칸이 몇이든 이 쓰기에서 한 줄이다. 입금 대기를 쓸 때 한 번만 지나므로 1시간 간격 조회가 이어져도 다시 내지 않는다
  if (Number.isNaN(dueAtMs) || va.bank === undefined || va.accountNumber === undefined) quietly(() => log.infoMissing({ orderId: ids.orderId }));
  const accountNoSealed = va.accountNumber === undefined ? undefined : await sealedOf(deps, ids, va.accountNumber);
  return {
    ...(Number.isNaN(dueAtMs) ? {} : { dueAtMs }),
    ...(va.bank === undefined ? {} : { bank: va.bank }),
    ...(accountNoSealed === undefined ? {} : { accountNoSealed }),
    ...(va.secret === undefined ? {} : { secretHash: depositSecretHashOf(va.secret) }),
  };
}

/** 계좌번호를 암호화한다. 키가 없거나 실패하면 지표·SEV2 뒤 undefined(평문을 저장하지 않는다). 던지지 않는다 */
async function sealedOf({ cipher, log, signals }: DepositWriteDeps, ids: { readonly paymentId: string; readonly orderId: string }, accountNumber: string): Promise<string | undefined> {
  if (!cipher.ready) {
    quietly(() => signals.fieldFailure('seal', 'NO_KEY'));
    quietly(() => log.accountUnsaved({ orderId: ids.orderId, reason: 'NO_KEY' }));
    return undefined;
  }
  try {
    return await cipher.seal(ids.paymentId, accountNumber);
  } catch {
    quietly(() => signals.fieldFailure('seal', 'ERROR'));
    quietly(() => log.accountUnsaved({ orderId: ids.orderId, reason: 'ERROR' }));
    return undefined;
  }
}

/** 로그·지표는 던지지 않기로 했지만, 던져도 결제 처리를 막지 않는다 */
function quietly(write: () => void): void {
  try {
    write();
  } catch {
    // 삼킨다
  }
}
