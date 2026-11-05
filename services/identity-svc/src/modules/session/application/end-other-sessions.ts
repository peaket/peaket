// 로그인 수단이 바뀌면 그 일을 한 세션 말고 그 계정의 살아 있는 세션을 모두 끝낸다(ASVS 7.4.3, docs/features/identity.md §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현',
// BUILD_ORDER BOT-044, ADR-0209 결정 5). 부르는 쪽 트랜잭션 안에서 계정을 잠근 뒤 부른다. 끝낼 세션 ID만 돌려주고, 끝내기는 부르는 쪽이 사건 쓰기와 함께
// 트랜잭션 끝에 한 번 한다(Outbox 행은 트랜잭션의 마지막 문장, ADR-0116 결정 3, 새 맥락 리뷰 낮음 3).
import type { SessionTx } from '../domain/ports.js';

/** keep: 남길 세션(그 일을 한 세션). null이면 모두다(병합에서 제안한 세션이 흡수 계정의 것일 때). 그 계정의 살아 있는 세션 가운데 끝낼 것(쓰기 잠금) */
export async function otherLiveSessions(tx: SessionTx, accountId: string, keep: string | null, now: number): Promise<string[]> {
  return (await tx.activeSessions(accountId, now)).map((s) => s.sessionId).filter((id) => id !== keep);
}
