// 뿌리 모듈: 컨텍스트 모듈을 모은다. 진입(사전 검증·진입), 대기 상태 파일, 입장 확정이 있다.
import { type DynamicModule, Module } from '@nestjs/common';
import type { HotRedis } from '@peaket/platform';
import { AdmissionModule, type AdmissionSignals, type AdmissionStore, type AdmissionTokens } from './modules/admission/index.js';
import { type ArrivalCookies, type ArrivalSignals, EntryModule, type EventSchedules, type QueueTokens, type RiskPort } from './modules/entry/index.js';
import { StateModule, type StateSnapshots } from './modules/state/index.js';

@Module({})
export class AppModule {
  /** 운영은 redis, 시험은 memory를 고른다(저장소가 없을 때 조용히 메모리로 가지 않게 둘 중 하나를 꼭 적는다) */
  static register(
    o: ({ redis: HotRedis; waitRedis?: HotRedis } | { memory: true; schedules?: EventSchedules; snapshots?: StateSnapshots }) & {
      tokens: QueueTokens;
      risk: RiskPort;
      /** 대기 상태 파일: 교차 출처 허용과 매초 다시 만들기(시험은 끈다) */
      state?: { webOrigin?: string; autoTick?: boolean };
      /** 진입 Degraded의 도착 시각 쿠키 읽기와 그 지표(ADR-0223) */
      arrivals?: ArrivalCookies;
      arrivalSignals?: ArrivalSignals;
      /** 입장 확정: 운영은 입장 토큰 서명기를 꼭 넘긴다(시험은 저장소·서명기를 넘기지 않으면 새로 만든다) */
      admission?: { signer?: AdmissionTokens; signals?: AdmissionSignals; store?: AdmissionStore };
    },
  ): DynamicModule {
    const entry = 'redis' in o ? EntryModule.register({ storage: 'redis', redis: o.redis, ...(o.waitRedis ? { waitRedis: o.waitRedis } : {}), tokens: o.tokens, risk: o.risk, ...(o.arrivals ? { arrivals: o.arrivals } : {}), ...(o.arrivalSignals ? { arrivalSignals: o.arrivalSignals } : {}) }) : EntryModule.register({ storage: 'memory', schedules: o.schedules, tokens: o.tokens, risk: o.risk, ...(o.arrivals ? { arrivals: o.arrivals } : {}), ...(o.arrivalSignals ? { arrivalSignals: o.arrivalSignals } : {}) });
    const options = { ...(o.state?.webOrigin ? { webOrigin: o.state.webOrigin } : {}), ...(o.state?.autoTick !== undefined ? { autoTick: o.state.autoTick } : {}) };
    const state = 'redis' in o ? StateModule.register({ storage: 'redis', redis: o.redis, options }) : StateModule.register({ storage: 'memory', schedules: o.schedules, snapshots: o.snapshots, options });
    const a = o.admission ?? {};
    const admission =
      'redis' in o
        ? AdmissionModule.register({ storage: 'redis', redis: o.redis, tokens: o.tokens, signer: requireSigner(a.signer), ...(a.signals ? { signals: a.signals } : {}) })
        : AdmissionModule.register({ storage: 'memory', schedules: o.schedules, tokens: o.tokens, ...(a.store ? { store: a.store } : {}), ...(a.signer ? { signer: a.signer } : {}), ...(a.signals ? { signals: a.signals } : {}) });
    return { module: AppModule, imports: [entry, state, admission] };
  }
}

function requireSigner(s: AdmissionTokens | undefined): AdmissionTokens {
  if (!s) throw new Error('입장 토큰 서명기가 없다(운영 조립은 Es256AdmissionTokens.fromEnv를 넘긴다)');
  return s;
}
