// 제어 gRPC의 명령 3(SALE_PAUSE)·명령 7(LOBBY_BANNER)을 대기 화면 제어 상태에 쓴다(F-02-1 OPS-300, ADR-0365 결정 2·6).
// 바라는 상태 꼴은 domain/queue-notice.ts가 본다. 판이 지금 칸보다 클 때만 쓰고, 같거나 작으면 아무것도 바꾸지 않고 지금 판을 돌려준다.
import { noticeValueOf, QUEUE_NOTICE_PLATFORM, type QueueNoticeKind, type QueueNotices } from '../domain/queue-notice.js';

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 받은 제어가 꼴에 맞지 않음(받는 층이 INVALID_ARGUMENT로 바꾼다) */
export class QueueNoticeRejected extends Error {
  constructor(readonly why: string) {
    super(why);
    this.name = 'QueueNoticeRejected';
  }
}

export interface SetQueueNoticeInput {
  readonly kind: QueueNoticeKind;
  /** 소문자 회차 ID 또는 PLATFORM */
  readonly scope: string;
  readonly desiredStateJson: string;
  readonly commandId: string;
  /** 1 이상 안전 정수(받는 층이 먼저 본다) */
  readonly version: number;
}

export class SetQueueNotice {
  constructor(private readonly notices: QueueNotices) {}

  /**
   * @returns 쓴 뒤(또는 지금)의 그 종류 판
   * @throws QueueNoticeRejected 범위·바라는 상태 꼴이 틀림(아무것도 쓰지 않았다)
   */
  async run(input: SetQueueNoticeInput): Promise<number> {
    if (input.scope !== QUEUE_NOTICE_PLATFORM && !LOWER_UUID.test(input.scope)) throw new QueueNoticeRejected('scope');
    const parsed = noticeValueOf(input.kind, input.desiredStateJson);
    if (!parsed) throw new QueueNoticeRejected('desired_state_json');
    return this.notices.write({ scope: input.scope, kind: input.kind, value: parsed.value, revision: input.version, commandId: input.commandId });
  }
}
