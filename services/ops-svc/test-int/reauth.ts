// BAT-045 통합 시험 도우미: 위험 명령(2인 승인·멈추는 쪽 3·11)의 재인증 대역과 요청 머리 보강.
// 제품 코드는 X-Reauth-Token(act=OPS_COMMAND)을 요구한다. 통합 시험은 만든 서비스에 이 대역을 싣고
// /v1/ops/commands로 가는 POST에 그 계정의 토큰을 붙인다(비위험 명령은 controller가 무시한다).
// 접수(POST /v1/ops/commands)는 Idempotency-Key가 필요하다(ADR-0340 결정 7, BAT-355): 시험이 키를 주지 않았으면 요청마다 새 키를 붙인다.
import { randomUUID } from 'node:crypto';
import { fakeReauth, tokenFor } from '../test/event-cancellation-fixtures.js';
import { UnavailableAdminIdentity } from '../src/modules/admin-accounts/index.js';

/** 명령 재인증 확인기 대역(한 파일에 하나). AppModule의 adminAccounts.reauth로 넘긴다 */
export const commandReauth = fakeReauth();
export const adminAccountsForCommands = { identity: new UnavailableAdminIdentity(), reauth: commandReauth };

type Headers = Record<string, string>;

/** /v1/ops/commands 경로의 POST에 그 계정의 act=OPS_COMMAND 토큰을 붙이고, 접수 경로면 Idempotency-Key도 붙인다 */
export function reauthFor(url: string, headers: Headers): Headers {
  const id = headers['x-user-id'];
  if (!url.startsWith('/v1/ops/commands') || id === undefined) return headers;
  const idem: Headers = url === '/v1/ops/commands' && headers['idempotency-key'] === undefined ? { 'idempotency-key': randomUUID() } : {};
  return { ...idem, ...headers, 'x-reauth-token': tokenFor(id, { act: 'OPS_COMMAND' }) };
}
