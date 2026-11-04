// 연결하지 않고 새 계정 만들기(POST /v1/identity/link-proposals/{proposalId}/separate-account → SessionService.SeparateAccount,
// identity §2.1 '가입 때 연결 제안의 첫 구현', FR-048). 묶음 값이 맞으면 제안의 새 제공자 (제공자, sub)·이메일로 로그인하고(계정이 없으면 새 계정) 제안을 지운다.
// 그 사이 그 (제공자, sub) 계정이 생겼으면 그 계정으로 간다(CreateSession의 같은 길).
import { Inject, Injectable } from '@nestjs/common';
import { LINK_PROPOSALS, type LinkProposals, LinkStoreUnavailable } from '../domain/ports.js';
import { bindingMatches, CreateSession, type CreateSessionResult, proposalIdOk } from './create-session.js';
import { SessionError } from './session-error.js';

export interface SeparateAccountInput {
  proposalId: string;
  binding: string;
  idempotencyKey: string;
  deviceId: string | null;
}

@Injectable()
export class SeparateAccount {
  constructor(
    @Inject(CreateSession) private readonly create: Pick<CreateSession, 'withoutProposal'>,
    @Inject(LINK_PROPOSALS) private readonly links: LinkProposals,
  ) {}

  /** @throws SessionError NOT_FOUND 없음·만료·묶음 값이 다름, UNAVAILABLE 저장소 장애 */
  async run(i: SeparateAccountInput): Promise<CreateSessionResult> {
    if (!proposalIdOk(i.proposalId)) throw new SessionError('NOT_FOUND', '연결 제안이 없다');
    const p = await this.links.get(i.proposalId).catch(unavailable);
    if (!p || !bindingMatches(p, i.binding)) throw new SessionError('NOT_FOUND', '연결 제안이 없거나 만료됐다');
    const s = await this.create.withoutProposal({
      idempotencyKey: i.idempotencyKey,
      provider: p.newProvider,
      providerUserId: p.newProviderUserId,
      email: p.email,
      emailVerified: true,
      deviceId: i.deviceId,
    });
    // 한 번만 쓴다. 지우지 못해도 10분 뒤 사라지고, 다시 와도 그 제공자 계정으로 로그인할 뿐이다
    await this.links.remove(i.proposalId).catch(() => undefined);
    return s;
  }
}

function unavailable(err: unknown): never {
  if (err instanceof LinkStoreUnavailable) throw new SessionError('UNAVAILABLE', '연결 제안 저장소에 닿지 못했다');
  throw err;
}
