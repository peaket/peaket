// identity.accounts-withdrawn 사건 처리기: 탈퇴한 계정의 후기에서 계정·주문 참조를 끊는다(W7-audit COV2-06, docs/features/identity.md §8 '후기 익명화',
// docs/streaming.md §2.6 'core-svc 소비자', asyncapi consumeAccountWithdrawn). 플랫폼 키 단위 소비자(KeyedHandler)에 꽂는 면이다.
// 업무 키는 계정 ID, 중복 제거 키는 eventKey다. core는 eventKey·accountId·withdrawnAt만 읽고 pid·purgeBy는 읽지 않는다(data-classification '탈퇴 사건의 pid 사본').
// 뼈대(W7-audit 시험 단계): 모양만 두었고 동작은 구현 담당이 채운다.
import type { ConsumedMessage, KeyedHandler } from '@peaket/platform';
import type { Reviews } from '../application/reviews.js';

export const ACCOUNTS_WITHDRAWN_TOPIC = 'identity.accounts-withdrawn';

/** core가 읽는 칸만. pid·purgeBy는 읽지 않는다 */
export interface ReviewWithdrawnEvent {
  eventKey: string;
  accountId: string;
  withdrawnAt: string;
}

/** Kafka 값 바이트 → 사건 객체(계약 모양인지는 처리기가 Zod로 본다) */
export interface AccountWithdrawnCodec {
  decode(value: Buffer): unknown;
}

/** JSON 대역(Avro는 BAS-030). 뼈대: 구현 담당이 채운다 */
export const jsonAccountWithdrawnCodec: AccountWithdrawnCodec = {
  decode: () => {
    throw new Error('아직 없음');
  },
};

export class ReviewAccountWithdrawnHandler implements KeyedHandler<ReviewWithdrawnEvent> {
  constructor(
    private readonly reviews: Pick<Reviews, 'anonymizeAccount'>,
    private readonly codec: AccountWithdrawnCodec = jsonAccountWithdrawnCodec,
    private readonly o: { logger?: { info(o: object, msg?: string): void } } = {},
  ) {}

  /** @throws Error 값이 null, 또는 계약 Zod AccountWithdrawn.pick({ eventKey, accountId, withdrawnAt })에 맞지 않음 → 플랫폼이 5회 뒤 보류 */
  decode(_m: ConsumedMessage): ReviewWithdrawnEvent {
    throw new Error('아직 없음');
  }

  /** 계정 ID */
  keyOf(_e: ReviewWithdrawnEvent): string {
    throw new Error('아직 없음');
  }

  /** eventKey */
  eventKeyOf(_e: ReviewWithdrawnEvent): string {
    throw new Error('아직 없음');
  }

  /** reviews.anonymizeAccount(accountId)를 기다린다. 로그에는 eventKey와 바꾼 건수만(계정 ID 없음). 저장소 일시 장애는 그대로 던져 파티션을 멈춘다 */
  async handle(_e: ReviewWithdrawnEvent): Promise<void> {
    throw new Error('아직 없음');
  }
}
