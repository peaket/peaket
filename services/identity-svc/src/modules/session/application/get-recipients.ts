// BAT-455 identity-svc 받는 사람 묶음 조회(RecipientQueryService.BatchGetRecipients, notify §2.1 E6, N-T24).
// 최대 500명, 요청 순서 그대로. 없거나 탈퇴한 계정도 한 줄로 답한다(계정이 없다고 호출 전체를 실패시키지 않는다).
import type { RecipientRow, SessionStore } from '../domain/ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RecipientsProblem extends Error {
  constructor(
    readonly code: 'INVALID_ARGUMENT',
    message: string,
  ) {
    super(message);
    this.name = 'RecipientsProblem';
  }
}

export class GetRecipients {
  constructor(private readonly store: Pick<SessionStore, 'recipientsOf'>) {}

  async run(input: { accountIds: readonly string[]; includeEmail: boolean; includePhone?: boolean }): Promise<RecipientRow[]> {
    if (input.accountIds.length > 500) throw new RecipientsProblem('INVALID_ARGUMENT', '받는 사람은 500명까지입니다');
    if (input.accountIds.some((id) => !UUID.test(id))) throw new RecipientsProblem('INVALID_ARGUMENT', '계정 ID 모양이 올바르지 않습니다');
    const unique = [...new Set(input.accountIds.map((id) => id.toLowerCase()))];
    const rows = await this.store.recipientsOf(unique, input.includeEmail, input.includePhone);
    const byId = new Map(rows.map((r) => [r.accountId, r]));
    return input.accountIds.map((id) => byId.get(id.toLowerCase()) ?? { accountId: id, status: 'NOT_FOUND', verified: false, locale: 'ko', ...(input.includeEmail ? { email: null } : {}) });
  }
}
