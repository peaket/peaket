// 뿌리 모듈: 컨텍스트 모듈을 모은다. 진입(사전 검증·진입), 대기 상태 파일, 입장 확정, 추가 검증(제출·이의, BOT-090)이 있다.
import { type DynamicModule, Module } from '@nestjs/common';
import type { HotRedis } from '@peaket/platform';
import { AdmissionModule, type AdmissionSignals, type AdmissionStore, type AdmissionTokens } from './modules/admission/index.js';
import { type ArrivalCookies, type ArrivalSignals, type DegradedLimits, EntryModule, type EventSchedules, type FirstVisitCookies, type FirstVisitSignals, type LeaveSignals, type LobbySignals, type QueueTokens, type RiskPort, type SeedSealer } from './modules/entry/index.js';
import { type ShuffleProofSource, StateModule, type StateSnapshots } from './modules/state/index.js';
import { VerificationModule, type VerificationModuleOptions, type VerificationStore } from './modules/verification/index.js';

@Module({})
export class AppModule {
  /** 운영은 redis, 시험은 memory를 고른다(저장소가 없을 때 조용히 메모리로 가지 않게 둘 중 하나를 꼭 적는다) */
  static register(
    o: ({ redis: HotRedis; waitRedis?: HotRedis } | { memory: true; schedules?: EventSchedules; snapshots?: StateSnapshots }) & {
      tokens: QueueTokens;
      risk: RiskPort;
      /** 대기 상태 파일: 교차 출처 허용과 매초 다시 만들기(시험은 끈다) */
      state?: { webOrigin?: string; autoTick?: boolean; proofSource?: ShuffleProofSource; resultDir?: string };
      /** 진입 Degraded의 도착 시각 쿠키 읽기와 그 지표(ADR-0223) */
      arrivals?: ArrivalCookies;
      arrivalSignals?: ArrivalSignals;
      /** 최초 방문 쿠키 읽기와 그 지표(ADR-0249) */
      firstVisit?: FirstVisitCookies;
      firstVisitSignals?: FirstVisitSignals;
      /** 시드 봉인(운영 KMS는 BUILD_ORDER HOT-041)과 로비 지표 */
      sealer?: SeedSealer;
      lobbySignals?: LobbySignals;
      leaveSignals?: LeaveSignals;
      /** 위험 판정을 받지 못할 때의 파드 메모리 한도(docs/features/bot-defense.md §11.2) */
      degradedLimits?: DegradedLimits;
      /** 입장 확정: 운영은 입장 토큰 서명기를 꼭 넘긴다(시험은 저장소·서명기를 넘기지 않으면 새로 만든다) */
      admission?: { signer?: AdmissionTokens; signals?: AdmissionSignals; store?: AdmissionStore };
      /** 추가 검증 제출·이의(BOT-090): identity·trust 클라이언트, 건 요청 생산자. 넘기지 않은 것은 늘 503이다(시험은 메모리 저장소를 넘길 수 있다) */
      verification?: Omit<VerificationModuleOptions, 'storage' | 'redis' | 'store' | 'schedules'> & { store?: VerificationStore };
    },
  ): DynamicModule {
    const entry = 'redis' in o ? EntryModule.register({ storage: 'redis', redis: o.redis, ...(o.waitRedis ? { waitRedis: o.waitRedis } : {}), tokens: o.tokens, risk: o.risk, ...(o.sealer ? { sealer: o.sealer } : {}), ...(o.lobbySignals ? { lobbySignals: o.lobbySignals } : {}), ...(o.leaveSignals ? { leaveSignals: o.leaveSignals } : {}), ...(o.arrivals ? { arrivals: o.arrivals } : {}), ...(o.arrivalSignals ? { arrivalSignals: o.arrivalSignals } : {}), ...(o.firstVisit ? { firstVisit: o.firstVisit } : {}), ...(o.firstVisitSignals ? { firstVisitSignals: o.firstVisitSignals } : {}), ...(o.degradedLimits ? { degradedLimits: o.degradedLimits } : {}) }) : EntryModule.register({ storage: 'memory', schedules: o.schedules, tokens: o.tokens, risk: o.risk, ...(o.sealer ? { sealer: o.sealer } : {}), ...(o.lobbySignals ? { lobbySignals: o.lobbySignals } : {}), ...(o.leaveSignals ? { leaveSignals: o.leaveSignals } : {}), ...(o.arrivals ? { arrivals: o.arrivals } : {}), ...(o.arrivalSignals ? { arrivalSignals: o.arrivalSignals } : {}), ...(o.firstVisit ? { firstVisit: o.firstVisit } : {}), ...(o.firstVisitSignals ? { firstVisitSignals: o.firstVisitSignals } : {}), ...(o.degradedLimits ? { degradedLimits: o.degradedLimits } : {}) });
    const options = { ...(o.state?.webOrigin ? { webOrigin: o.state.webOrigin } : {}), ...(o.state?.autoTick !== undefined ? { autoTick: o.state.autoTick } : {}) };
    const resultDir = o.state?.resultDir ? { resultDir: o.state.resultDir } : {};
    const state = 'redis' in o ? StateModule.register({ storage: 'redis', redis: o.redis, options, ...resultDir }) : StateModule.register({ storage: 'memory', schedules: o.schedules, snapshots: o.snapshots, ...(o.state?.proofSource ? { proofSource: o.state.proofSource } : {}), options, ...resultDir });
    const a = o.admission ?? {};
    const admission =
      'redis' in o
        ? AdmissionModule.register({ storage: 'redis', redis: o.redis, tokens: o.tokens, signer: requireSigner(a.signer), ...(a.signals ? { signals: a.signals } : {}) })
        : AdmissionModule.register({ storage: 'memory', schedules: o.schedules, tokens: o.tokens, ...(a.store ? { store: a.store } : {}), ...(a.signer ? { signer: a.signer } : {}), ...(a.signals ? { signals: a.signals } : {}) });
    const { store: verificationStore, ...v } = o.verification ?? {};
    const verification = 'redis' in o ? VerificationModule.register({ storage: 'redis', redis: o.redis, ...v }) : VerificationModule.register({ storage: 'memory', schedules: o.schedules, ...(verificationStore ? { store: verificationStore } : {}), ...v });
    return { module: AppModule, imports: [entry, state, admission, verification] };
  }
}

function requireSigner(s: AdmissionTokens | undefined): AdmissionTokens {
  if (!s) throw new Error('입장 토큰 서명기가 없다(운영 조립은 Es256AdmissionTokens.fromEnv를 넘긴다)');
  return s;
}
