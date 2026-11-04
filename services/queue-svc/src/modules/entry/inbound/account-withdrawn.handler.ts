// identity.accounts-withdrawn 사건 처리기(docs/features/queue-admission.md §3 '탈퇴 계정의 사람 키', BUILD_ORDER BOT-037, asyncapi AccountWithdrawn).
// 플랫폼 키 단위 소비자(KeyedHandler)에 꽂는 면이다. 업무 키는 계정 ID, 중복 제거 키는 eventKey다(다시 받아도 결과가 같다).
// 값 해독은 AccountWithdrawnCodec이다: Avro(Confluent 형식)는 BAS-030, Kafka 구독 실행(서비스 소비자 그룹 하나)은 HOT-010이 만든다. 지금은 JSON 대역뿐이다.
// pid는 키의 해시 태그에 들어가므로 키 조각 모양([A-Za-z0-9_-] 1~64자)만 받는다. 대기열 Redis 일시 장애는 TransientError로 다시 한다.
import { AccountWithdrawn, type AccountWithdrawnOutput } from '@peaket/contracts/asyncapi';
import { type ConsumedMessage, type KeyedHandler, TransientError } from '@peaket/platform';
import type { PurgeWithdrawnKeys } from '../application/purge-withdrawn-keys.js';
import { QueueStoreUnavailable } from '../domain/queue.js';

export const ACCOUNTS_WITHDRAWN_TOPIC = 'identity.accounts-withdrawn';
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;
/** purgeBy의 상한: 탈퇴 + 5일(표준 개인정보 보호지침 §10①). 보내는 쪽 버그로 기한이 늘면 조용히 넘기지 않고 보류한다 */
export const MAX_PURGE_AFTER_MS = 5 * 86_400_000;

/** Kafka 값 바이트 → 사건 객체(계약 모양인지는 처리기가 Zod로 본다) */
export interface AccountWithdrawnCodec {
  decode(value: Buffer): unknown;
}

/** JSON 대역(시험·로컬, identity가 BAS-030 전까지 JSON으로 낸다) */
export const jsonAccountWithdrawnCodec: AccountWithdrawnCodec = {
  decode: (value) => JSON.parse(value.toString('utf8')) as unknown,
};

export type AccountWithdrawnEvent = AccountWithdrawnOutput & { purgeByMs: number };

export class AccountWithdrawnHandler implements KeyedHandler<AccountWithdrawnEvent> {
  constructor(
    private readonly purge: PurgeWithdrawnKeys,
    private readonly codec: AccountWithdrawnCodec = jsonAccountWithdrawnCodec,
  ) {}

  /** @throws Error 값이 없거나 계약 모양(Zod)이 아니거나 pid가 1~2개의 서로 다른 키 조각이 아님 → 키 단위 소비자가 그 키를 보류한다 */
  decode(m: ConsumedMessage): AccountWithdrawnEvent {
    if (m.value === null) throw new Error('탈퇴 사건의 값이 없다');
    const v = AccountWithdrawn.parse(this.codec.decode(m.value));
    if (v.pids.length < 1 || v.pids.length > 2) throw new Error('탈퇴 사건의 pid는 1~2개다');
    if (!v.pids.every((p) => KEY_PART.test(p))) throw new Error('탈퇴 사건의 pid가 키 조각 모양이 아니다');
    if (new Set(v.pids).size !== v.pids.length) throw new Error('탈퇴 사건의 pid가 겹친다');
    const purgeByMs = Date.parse(v.purgeBy);
    const withdrawnAtMs = Date.parse(v.withdrawnAt);
    if (!Number.isFinite(purgeByMs) || !Number.isFinite(withdrawnAtMs)) throw new Error('탈퇴 사건의 시각을 읽지 못했다');
    if (purgeByMs < withdrawnAtMs || purgeByMs > withdrawnAtMs + MAX_PURGE_AFTER_MS) throw new Error('탈퇴 사건의 purgeBy가 탈퇴 시각 ~ 탈퇴 + 5일 밖이다');
    return { ...v, purgeByMs };
  }

  keyOf(e: AccountWithdrawnEvent, _m?: ConsumedMessage): string {
    return e.accountId;
  }

  eventKeyOf(e: AccountWithdrawnEvent): string {
    return e.eventKey;
  }

  /** @throws TransientError 대기열 Redis 일시 장애(원인은 cause). 그 밖의 오류는 그대로 */
  async handle(e: AccountWithdrawnEvent, _m?: ConsumedMessage): Promise<void> {
    try {
      await this.purge.run({ pids: e.pids, purgeBy: e.purgeByMs });
    } catch (err) {
      if (err instanceof QueueStoreUnavailable) throw new TransientError('대기열 Redis를 잠시 쓸 수 없어 탈퇴 사건을 다시 한다', { cause: err });
      throw err;
    }
  }
}
