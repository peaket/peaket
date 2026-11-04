// 로그인 수단 연결·해제 사건의 Outbox 메시지(asyncapi identity.login-methods-changed `LoginMethodChanged`, identity §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BUILD_ORDER BOT-041, I-T34).
// 값은 공용 Avro 인코더(BUILD_ORDER BAS-030) 전까지 JSON이다. 두 저장소(메모리·PostgreSQL)가 함께 쓴다.
import type { OutboxMessage } from '@peaket/platform';
import type { Provider } from '../domain/session.js';

export const LOGIN_METHODS_CHANGED_TOPIC = 'identity.login-methods-changed';

export function loginMethodChangedMessage(i: { eventKey: string; accountId: string; change: 'LINKED' | 'UNLINKED'; provider: Provider; occurredAt: number }): OutboxMessage {
  const value = { eventKey: i.eventKey, accountId: i.accountId, change: i.change, provider: i.provider, occurredAt: new Date(i.occurredAt).toISOString() };
  // 키 = accountId(asyncapi). 같은 계정의 사건은 같은 파티션에 차례로 간다
  return { topic: LOGIN_METHODS_CHANGED_TOPIC, key: i.accountId, payload: Buffer.from(JSON.stringify(value), 'utf8') };
}
