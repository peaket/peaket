// ops-svc Kafka 소비자: ops.command-events(명령 요청·결과 사건, asyncapi OpsCommandRequested·OpsCommandResult).
// HTTP POST /internal/v1/ops/command-events와 같은 처리기(HandleCommandEvent)를 부른다. eventKey가 중복 제거 키이고,
// COMMAND_REQUESTED는 eventKey로 명령 ID를 결정하며, COMMAND_RESULT는 DISPATCHED 명령만 끝낸다.
// 처리 못 하는 사건은 ops DB held_event로 보류한다(플랫폼 키 단위 소비자, ADR-0142). 이 파일은 Kafka 클라이언트를 싣지 않는다(start.ts가 싣는다).
import { OpsCommandRequested, OpsCommandResult } from '@peaket/contracts/asyncapi';
import { type Clock, type ConsumedMessage, type KeyedHandler } from '@peaket/platform';
import { CommandEventBody, commandIdOfEventKey, type CommandEvent, type HandleCommandEvent } from '../modules/commands/index.js';

export const OPS_COMMAND_EVENTS_TOPIC = 'ops.command-events';

/** 읽은 값: 계약 모양의 사건, 또는 모양이 틀린 메시지(보류한다) */
export type OpsCommandRecord = { kind: 'event'; event: CommandEvent } | { kind: 'bad'; key: string; error: string };

export class OpsCommandEventsHandler implements KeyedHandler<OpsCommandRecord> {
  constructor(
    private readonly handler: HandleCommandEvent,
    private readonly clock: Clock,
  ) {}

  decode(m: ConsumedMessage): OpsCommandRecord {
    const msgKey = m.key ?? '';
    const bad = (error: string): OpsCommandRecord => ({ kind: 'bad', key: `bad:${m.topic}:${msgKey}`, error });
    if (m.value === null) return bad('명령 사건의 값이 없다');
    let v: unknown;
    try {
      v = JSON.parse(m.value.toString('utf8')) as unknown;
    } catch {
      return bad('명령 사건의 값을 읽지 못했다');
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return bad('명령 사건의 값이 객체가 아니다');
    const o = v as Record<string, unknown>;
    // 계약(asyncapi) 모양을 먼저 보고, 처리기가 쓰는 좁은 합집합(명령 유형 enum·strict)을 다시 본다.
    const contract = o.kind === 'COMMAND_REQUESTED' ? OpsCommandRequested.safeParse(o) : o.kind === 'COMMAND_RESULT' ? OpsCommandResult.safeParse(o) : undefined;
    if (!contract) return bad('모르는 명령 사건 종류다');
    if (!contract.success) return bad('명령 사건이 계약 모양이 아니다');
    const strict = CommandEventBody.safeParse(o);
    if (!strict.success) return bad('명령 사건이 처리기 모양이 아니다');
    return { kind: 'event', event: strict.data };
  }

  /** 업무 키: 요청은 결정적 명령 ID, 결과는 명령 ID다(같은 명령의 사건이 한 줄로 처리된다) */
  keyOf(e: OpsCommandRecord): string {
    if (e.kind === 'bad') return e.key;
    return e.event.kind === 'COMMAND_REQUESTED' ? commandIdOfEventKey(e.event.eventKey) : e.event.commandId;
  }

  eventKeyOf(e: OpsCommandRecord): string | undefined {
    return e.kind === 'event' ? e.event.eventKey : undefined;
  }

  /**
   * @throws RangeError 모양이 틀린 메시지, 또는 처리기가 받지 않은 사건(같은 eventKey에 다른 내용, DISPATCHED가 아닌 명령의 결과).
   *   둘 다 다시 해도 같으므로 5회 [가정] 뒤 보류 표로 간다(운영자가 보고 다시 처리한다).
   */
  async handle(e: OpsCommandRecord): Promise<void> {
    if (e.kind === 'bad') throw new RangeError(e.error);
    const r = await this.handler.run(e.event, this.clock.now());
    if (!r.accepted) throw new RangeError('명령 사건을 받지 않았다(command-event-not-applicable)');
  }
}
