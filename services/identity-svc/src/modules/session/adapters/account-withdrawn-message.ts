// 탈퇴 사건의 Outbox 메시지(asyncapi identity.accounts-withdrawn `AccountWithdrawn`, docs/features/identity.md §8 '탈퇴 계정의 대기열 키 지우기', BUILD_ORDER BOT-037, I-T27).
// 계정을 탈퇴 처리하는 트랜잭션(첫 트랜잭션)이 세션 종료 사건 뒤에 적는다. queue-svc가 받아 그 pid의 q:dup·q:adm 만료를 purgeBy로 당긴다.
// 값은 공용 Avro 인코더(BUILD_ORDER BAS-030) 전까지 JSON이다(세션 종료 사건과 같다). 두 저장소(메모리·PostgreSQL)가 함께 쓴다.
import type { OutboxMessage } from '@peaket/platform';
import { QUEUE_KEYS_PURGE_MS } from '../domain/session.js';

export const ACCOUNTS_WITHDRAWN_TOPIC = 'identity.accounts-withdrawn';

/**
 * pids: 지금 pid가 먼저, pid 키 전환 기간이면 옛 pid가 뒤(액세스 토큰과 같은 base64url 글자). 비면 부르지 않는다.
 * withdrawnAt: 계정을 탈퇴 처리한 시각(account.deleted_at). purgeBy = withdrawnAt + 5일
 */
export function accountWithdrawnMessage(i: { eventKey: string; accountId: string; pids: readonly string[]; withdrawnAt: number }): OutboxMessage {
  const value = {
    eventKey: i.eventKey,
    accountId: i.accountId,
    pids: [...i.pids],
    withdrawnAt: new Date(i.withdrawnAt).toISOString(),
    purgeBy: new Date(i.withdrawnAt + QUEUE_KEYS_PURGE_MS).toISOString(),
  };
  // 키 = accountId(asyncapi). 같은 계정의 사건은 같은 파티션에 차례로 간다
  return { topic: ACCOUNTS_WITHDRAWN_TOPIC, key: i.accountId, payload: Buffer.from(JSON.stringify(value), 'utf8') };
}
