// identity.accounts-withdrawn 사건 처리기: 탈퇴한 계정의 후기를 파기하고 탈퇴 시각 + 16분의 다시 정리 예약을 쓴다(소유자 결정 2026-11-16 OPEN[42]·[44], ADR-0278,
// docs/features/identity.md §8 '후기 파기'·'다시 정리', docs/streaming.md §2.6 'core-svc 소비자', asyncapi consumeAccountWithdrawn). 플랫폼 키 단위 소비자(KeyedHandler)에 꽂는 면이다.
// 업무 키는 계정 ID, 중복 제거 키는 eventKey다. core는 eventKey·accountId·withdrawnAt만 읽고 pid·purgeBy는 읽지 않는다(data-classification '탈퇴 사건의 pid 사본').
// 값 해독은 AccountWithdrawnCodec이다: Avro(Confluent 형식)는 BAS-030이 만든다. 지금은 JSON 대역뿐이다. Kafka 구독 실행은 src/consumers다.
import { AccountWithdrawn } from '@peaket/contracts/asyncapi';
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

/** JSON 대역(시험·로컬, identity가 BAS-030 전까지 JSON으로 낸다) */
export const jsonAccountWithdrawnCodec: AccountWithdrawnCodec = {
  decode: (value) => JSON.parse(value.toString('utf8')) as unknown,
};

/** 계약(asyncapi AccountWithdrawn)에서 core가 읽는 세 칸. 나머지 칸(pids·purgeBy)은 읽지 않고 버린다(Zod object는 모르는 칸을 뺀다) */
const ReviewWithdrawn = AccountWithdrawn.pick({ eventKey: true, accountId: true, withdrawnAt: true });

/**
 * 값 객체에서 core가 읽는 세 칸만 꺼낸다(처리기와 보류 감싸기가 같이 쓴다). 맞지 않으면 undefined.
 * 오류 글에 값을 싣지 않으려고 Zod 오류를 밖으로 내지 않는다
 */
export function readReviewWithdrawn(value: unknown): ReviewWithdrawnEvent | undefined {
  const parsed = ReviewWithdrawn.safeParse(value);
  if (!parsed.success) return undefined;
  return { eventKey: parsed.data.eventKey, accountId: parsed.data.accountId, withdrawnAt: parsed.data.withdrawnAt };
}

export class ReviewAccountWithdrawnHandler implements KeyedHandler<ReviewWithdrawnEvent> {
  constructor(
    private readonly reviews: Pick<Reviews, 'purgeWithdrawn'>,
    private readonly codec: AccountWithdrawnCodec = jsonAccountWithdrawnCodec,
    private readonly o: { logger?: { info(o: object, msg?: string): void } } = {},
  ) {}

  /** @throws Error 값이 null, 또는 계약 Zod AccountWithdrawn.pick({ eventKey, accountId, withdrawnAt })에 맞지 않음 → 플랫폼이 5회 뒤 보류 */
  decode(m: ConsumedMessage): ReviewWithdrawnEvent {
    if (m.value === null) throw new Error('탈퇴 사건의 값이 없다');
    // 해독 실패(JSON 아님 등)의 오류 글에도 값 조각이 섞일 수 있어 원래 오류는 싣지 않는다
    let raw: unknown;
    try {
      raw = this.codec.decode(m.value);
    } catch {
      throw new Error('탈퇴 사건의 값을 해독하지 못했다');
    }
    const e = readReviewWithdrawn(raw);
    if (!e) throw new Error('탈퇴 사건이 계약 모양(eventKey·accountId·withdrawnAt)이 아니다');
    // 저장된 계정 ID는 소문자다(UUID 글자 크기만 다른 같은 계정을 놓치지 않는다)
    return { ...e, accountId: e.accountId.toLowerCase() };
  }

  /** 계정 ID */
  keyOf(e: ReviewWithdrawnEvent): string {
    return e.accountId;
  }

  /** eventKey */
  eventKeyOf(e: ReviewWithdrawnEvent): string {
    return e.eventKey;
  }

  /**
   * reviews.purgeWithdrawn({ accountId, withdrawnAt })를 기다린다(예약 시각은 처리 시각이 아니라 사건의 탈퇴 시각 기준). 로그에는 eventKey와 purged 수만(계정 ID 없음).
   * 저장소 일시 장애는 그대로 던져 파티션을 멈춘다(조용히 넘기면 플랫폼이 처리한 것으로 커밋한다)
   */
  async handle(e: ReviewWithdrawnEvent): Promise<void> {
    const { purged } = await this.reviews.purgeWithdrawn({ accountId: e.accountId, withdrawnAt: e.withdrawnAt });
    this.o.logger?.info({ kind: 'review-withdrawn-purge', eventKey: e.eventKey, purged }, '탈퇴 계정 후기를 파기하고 다시 정리를 예약했다');
  }
}
