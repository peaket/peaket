// core-svc support 포트의 시작 조립(F-06-4). PEAKET_OPS_HTTP_URL(부정 예매 소명 입구), PEAKET_REDIS_URL(화면용 사본).
// staging·prod는 둘 다 없으면 변수 이름을 말하며 던진다. local·ci·demo는 칸이 빈다.
// 시험 조립(support-main-wiring)이 5초 안에 읽도록 무거운 모듈(지원 모듈·플랫폼) 없이 어댑터만 가져온다.
import { HttpFraudAppealClient, type HttpFraudAppealOptions } from './modules/support/adapters/http-fraud-appeals.js';
import { HttpAppealCaseSink } from './modules/support/adapters/http-appeal-case-sink.js';
import { MemoryFraudAppealViewStore, MemoryRestrictionViewStore } from './modules/support/adapters/memory-support.js';
import type { AppealCaseSink, AppealStore, FanNotifier, FraudAppealClient, FraudAppealViewStore, RestrictionViewStore } from './modules/support/domain/ports.js';

export interface SupportWiring {
  readonly store?: AppealStore;
  readonly views?: { readonly restriction?: RestrictionViewStore; readonly fraud?: FraudAppealViewStore };
  readonly fraudAppeals?: FraudAppealClient | HttpFraudAppealOptions;
  readonly caseSink?: AppealCaseSink;
  readonly notifier?: FanNotifier;
}
export type SupportPortsWiring = SupportWiring & { close(): void };

const REQUIRED_IN = new Set(['staging', 'prod', 'production']);
const value = (env: Record<string, string | undefined>, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

class LogFanNotifier {
  async send(): Promise<void> {
    // 실제 이메일·푸시 문안은 notify 기능 몫이다(F-06-1·F-06-6)
  }
}

export function supportPortsFromEnv(env: Record<string, string | undefined>): SupportPortsWiring {
  const peaketEnv = value(env, 'PEAKET_ENV') ?? 'local';
  const ops = value(env, 'PEAKET_OPS_HTTP_URL');
  const redis = value(env, 'PEAKET_REDIS_URL');
  if (REQUIRED_IN.has(peaketEnv)) {
    if (!ops) throw new Error(`PEAKET_OPS_HTTP_URL이 없다(${peaketEnv}에서 core-svc가 부정 예매 소명을 ops-svc로 보내야 시작한다, http(s)://)`);
    if (!redis) throw new Error(`PEAKET_REDIS_URL이 없다(${peaketEnv}에서 core-svc가 화면용 사본 sup:rst·sup:far를 두어야 시작한다, redis://)`);
  }
  if (!ops && !redis) return { close() {} };
  const token = value(env, 'PEAKET_INTERNAL_TOKEN') ?? '';
  const fraudAppeals = ops ? new HttpFraudAppealClient({ url: ops, token, caller: 'core-svc' }) : undefined;
  const caseSink = ops ? new HttpAppealCaseSink({ url: ops, token }) : undefined;
  return {
    ...(fraudAppeals ? { fraudAppeals } : {}),
    ...(caseSink ? { caseSink } : {}),
    notifier: new LogFanNotifier(),
    // 실제 Redis 어댑터는 main.ts가 PEAKET_REDIS_URL로 연결해 덮는다(시험·기본은 메모리)
    views: { restriction: new MemoryRestrictionViewStore(), fraud: new MemoryFraudAppealViewStore() },
    close() {},
  };
}
