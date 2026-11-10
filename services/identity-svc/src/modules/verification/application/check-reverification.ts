// 본인확인 재통과 확인(gRPC ReverificationCheckService.CheckReverification, docs/api/proto identity.proto, docs/features/bot-defense.md §5.2 3단계,
// docs/features/identity.md I-T56, BUILD_ORDER BOT-090, ADR-0259). 추가 검증 제출(POST /v1/queues/{eventId}/verification)에서 queue-svc가 부른다.
// 읽기만 한다(멱등 키 없음). 판정 규칙은 domain/reverification.ts다.
// - 요청 pid가 그 계정의 pid(pid 키 전환 기간이면 옛 pid 포함)가 아니면 재확인 기록을 읽지 않고 NOT_FOUND다(정본에 없는 경우라 재통과가 아닌 쪽으로 정함).
//   대기 참여의 사람(pid)과 계정의 사람이 같은지 대조하지 않으면, 남의 대기 참여를 이 계정의 재확인으로 풀 수 있다
// - not_before_ms가 없거나(0) 음수면 받지 않는다. 0을 받으면 지난 모든 재확인을 세게 된다
import { Inject, Injectable } from '@nestjs/common';
import { VERIFICATION_STORE, type VerificationStore } from '../domain/ports.js';
import { judgeReverification, type ReverificationResult } from '../domain/reverification.js';

export type { ReverificationResult } from '../domain/reverification.js';

/** 요청 모양이 틀렸다(gRPC INVALID_ARGUMENT). 문구에는 받은 값을 싣지 않는다 */
export class ReverificationCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReverificationCheckError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 토큰·게이트웨이 머리(X-User-Pid)에 싣는 pid 모양: 32바이트 base64url(패딩 없음) */
const PID = /^[A-Za-z0-9_-]{43}$/;

@Injectable()
export class CheckReverification {
  constructor(@Inject(VERIFICATION_STORE) private readonly store: Pick<VerificationStore, 'claimsOf' | 'reverificationSince'>) {}

  async run(i: { accountId: string; pid: string; notBeforeMs: number }): Promise<ReverificationResult> {
    if (!UUID.test(i.accountId)) throw new ReverificationCheckError('account_id는 UUID다');
    if (!PID.test(i.pid)) throw new ReverificationCheckError('pid 모양이 틀렸다');
    if (!Number.isSafeInteger(i.notBeforeMs) || i.notBeforeMs <= 0) throw new ReverificationCheckError('not_before_ms는 1 이상의 epoch 밀리초다');
    const accountId = i.accountId.toLowerCase();
    const claims = await this.store.claimsOf(accountId);
    if (!claims || (claims.pid !== i.pid && claims.pidPrev !== i.pid)) return { result: 'NOT_FOUND' };
    return judgeReverification(await this.store.reverificationSince(accountId, i.notBeforeMs));
  }
}
