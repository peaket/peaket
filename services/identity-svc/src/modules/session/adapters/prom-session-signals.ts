// 운영 확인 지표(docs/features/identity.md §10.1, docs/architecture.md §8.4). 이름표는 제공자·강도·까닭처럼 값이 몇 개뿐인 것만 단다(observability §8).
import { Counter, type Registry } from '@prometheus-io/client';
import type { SessionSignals } from '../domain/ports.js';

export class PromSessionSignals implements SessionSignals {
  readonly #created = new Counter({ name: 'identity_session_created_total', help: '소셜 로그인으로 만든 세션 수', labelNames: ['provider', 'new_account'] as const, registers: [] });
  readonly #replayed = new Counter({ name: 'identity_create_session_replay_total', help: '같은 멱등 키로 다시 온 CreateSession(같은 세션에 토큰을 다시 줌)', labelNames: ['provider'] as const, registers: [] });
  readonly #deviceLimit = new Counter({ name: 'identity_session_device_limit_total', help: '기기 한도(5대)를 넘어 끝낸 세션 수', registers: [] });
  readonly #reauth = new Counter({ name: 'identity_reauth_issued_total', help: '준 팬 재인증 토큰 수', labelNames: ['provider', 'strength'] as const, registers: [] });
  readonly #mismatch = new Counter({ name: 'identity_reauth_mismatch_total', help: '다른 제공자 계정으로 다시 로그인해 주지 않은 재인증', labelNames: ['provider'] as const, registers: [] });
  readonly #reverify = new Counter({ name: 'identity_reauth_reverify_required_total', help: '본인확인 재통과가 필요해 주지 않은 고위험 재인증', labelNames: ['provider'] as const, registers: [] });

  /** 서비스의 지표 모음(/metrics)에 단다 */
  register(registry: Registry): this {
    for (const m of [this.#created, this.#replayed, this.#deviceLimit, this.#reauth, this.#mismatch, this.#reverify]) registry.registerMetric(m);
    return this;
  }

  created(provider: string, newAccount: boolean): void {
    this.#created.inc({ provider, new_account: String(newAccount) });
  }

  replayed(provider: string): void {
    this.#replayed.inc({ provider });
  }

  terminated(reason: string, count: number): void {
    if (reason === 'DEVICE_LIMIT') this.#deviceLimit.inc(count);
  }

  reauthIssued(provider: string, strength: string): void {
    this.#reauth.inc({ provider, strength });
  }

  reauthMismatch(provider: string): void {
    this.#mismatch.inc({ provider });
  }

  reverifyRequired(provider: string): void {
    this.#reverify.inc({ provider });
  }
}
