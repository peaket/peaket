// 운영 명령 저장소 포트(GAT-110 첫 몫). 도메인은 DB·HTTP를 모른다.
import type { Command, CommandState, CommandType, NewCommand } from './command.js';

export interface CommandListQuery {
  readonly eventId?: string;
  readonly type?: CommandType;
  readonly states?: readonly CommandState[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface CommandPage {
  readonly items: readonly Command[];
  readonly nextCursor?: string;
}

export type CommandDecision =
  | { readonly status: 'APPLIED'; readonly command: Command }
  | { readonly status: 'NOT_FOUND' }
  | { readonly status: 'NOT_PENDING' }
  | { readonly status: 'SAME_ACTOR' };

export interface CommandStore {
  /** 명령과 첫 사건(들), 감사 기록을 한 트랜잭션에 쓴다 */
  create(input: NewCommand): Promise<Command>;
  find(commandId: string): Promise<Command | undefined>;
  list(query: CommandListQuery): Promise<CommandPage>;
  /** PENDING_APPROVAL만 승인한다. 요청자와 같은 계정은 SAME_ACTOR다 */
  approve(commandId: string, approverRef: string, approverRole: string, nowMs: number): Promise<CommandDecision>;
  /** PENDING_APPROVAL만 거부한다. 요청자와 같은 계정은 SAME_ACTOR다 */
  reject(commandId: string, approverRef: string, approverRole: string, reason: string, nowMs: number): Promise<CommandDecision>;
}
