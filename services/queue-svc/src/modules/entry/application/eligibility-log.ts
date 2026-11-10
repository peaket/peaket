// 판매 자격 사본 없음·설정 틀림 경고(ADR-0265 결정 9, docs/features/queue-admission.md §3 운영 확인).
// 파드마다 회차·명단 키당 1분에 한 번 [가정]만 남긴다. 계정 ID·pid·기기 값은 싣지 않는다(회차 ID·명단 키만).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';

/** 같은 회차·명단 키의 경고를 다시 남기지 않는 시간 [가정] */
export const ELIGIBILITY_WARN_EVERY_MS = 60_000;

@Injectable()
export class EligibilityLog {
  readonly #last = new Map<string, number>();

  constructor(
    @Optional() @Inject(CLOCK) private readonly clock?: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
  ) {}

  warn(kind: 'copy_missing' | 'config_invalid', eventId: string, listKeys: readonly string[], nowMs?: number): void {
    const now = nowMs ?? this.clock?.now() ?? Date.now();
    // 설정 틀림은 명단 키가 없다(회차 하나에 한 줄)
    for (const listKey of kind === 'config_invalid' || listKeys.length === 0 ? [''] : listKeys) {
      const k = `${eventId}|${listKey}`;
      const last = this.#last.get(k);
      if (last !== undefined && now - last < ELIGIBILITY_WARN_EVERY_MS) continue;
      this.#last.set(k, now);
      this.logger?.warn(
        { kind: 'security', event: `sale_eligibility.${kind}`, eventId, ...(listKey ? { listKey } : {}) },
        kind === 'config_invalid' ? '판매 자격 설정 모양이 틀려 그 회차 로비·진입을 모두 막는다' : '판매 자격 명단 사본 표지가 없어 그 창의 로비·진입을 막는다',
      );
    }
  }
}
