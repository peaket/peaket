// 연결된 로그인 수단 목록(openapi GET /v1/identity/providers, docs/features/identity.md §8 '탈퇴 화면 연결', BUILD_ORDER BOT-036, FR-017).
// 화면이 재인증할 제공자를 고른다. 마지막 로그인 시각은 아직 기록하지 않아 null이다(BOT-040이 남긴다).
import { Inject, Injectable } from '@nestjs/common';
import { SESSION_STORE, type SessionStore } from '../domain/ports.js';
import type { Provider } from '../domain/session.js';

export interface LinkedProviderView {
  provider: Provider;
  linkedAt: string;
  lastLoginAt: string | null;
}

@Injectable()
export class ListProviders {
  constructor(@Inject(SESSION_STORE) private readonly store: SessionStore) {}

  async run(accountId: string): Promise<LinkedProviderView[]> {
    const rows = await this.store.transaction((tx) => tx.providersOf(accountId.toLowerCase()));
    return rows.map((r) => ({ provider: r.provider, linkedAt: new Date(r.linkedAt).toISOString(), lastLoginAt: null }));
  }
}
