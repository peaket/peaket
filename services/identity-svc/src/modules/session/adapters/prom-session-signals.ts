// 운영 확인 지표(docs/features/identity.md §10.1, docs/architecture.md §8.4). 이름표는 제공자·강도·까닭처럼 값이 몇 개뿐인 것만 단다(observability §8).
import { Counter, type Registry } from '@prometheus-io/client';
import type { SessionSignals } from '../domain/ports.js';

export class PromSessionSignals implements SessionSignals {
  readonly #created = new Counter({ name: 'identity_session_created_total', help: '소셜 로그인으로 만든 세션 수', labelNames: ['provider', 'new_account'] as const, registers: [] });
  readonly #replayed = new Counter({ name: 'identity_create_session_replay_total', help: '같은 멱등 키로 다시 온 CreateSession(같은 세션에 토큰을 다시 줌)', labelNames: ['provider'] as const, registers: [] });
  readonly #deviceLimit = new Counter({ name: 'identity_session_device_limit_total', help: '기기 한도(5대)를 넘어 끝낸 세션 수', registers: [] });
  readonly #reauth = new Counter({ name: 'identity_reauth_issued_total', help: '준 팬 재인증 토큰 수', labelNames: ['provider', 'strength'] as const, registers: [] });
  readonly #mismatch = new Counter({ name: 'identity_reauth_mismatch_total', help: '다른 제공자 계정으로 다시 로그인해 주지 않은 재인증', labelNames: ['provider'] as const, registers: [] });
  readonly #refresh = new Counter({ name: 'identity_refresh_total', help: '토큰 갱신 결과(rotated·retried·reused·invalid)', labelNames: ['aud', 'result'] as const, registers: [] });
  readonly #retry = new Counter({ name: 'identity_refresh_retry_reuse_total', help: '응답을 잃은 재시도로 받아 준 바로 앞 리프레시 토큰', labelNames: ['aud'] as const, registers: [] });
  readonly #reuse = new Counter({ name: 'identity_refresh_reuse_detected_total', help: '탈취로 본 리프레시 토큰 재사용', labelNames: ['aud'] as const, registers: [] });
  readonly #reverify = new Counter({ name: 'identity_reauth_reverify_required_total', help: '본인확인 재통과가 필요해 주지 않은 고위험 재인증', labelNames: ['provider'] as const, registers: [] });

  /** 서비스의 지표 모음(/metrics)에 단다 */
  register(registry: Registry): this {
    const all: Array<Parameters<Registry['registerMetric']>[0]> = [this.#created, this.#replayed, this.#deviceLimit, this.#reauth, this.#mismatch, this.#reverify, this.#refresh, this.#retry, this.#reuse];
    for (const m of all) registry.registerMetric(m);
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

  refreshed(aud: string, result: string): void {
    this.#refresh.inc({ aud, result });
    if (result === 'retried') this.#retry.inc({ aud });
    if (result === 'reused') this.#reuse.inc({ aud });
  }
}
