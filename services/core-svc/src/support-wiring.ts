// core-svc support 포트의 시작 조립(F-06-4 소명 + F-06-5 문의).
// PEAKET_OPS_HTTP_URL(부정 예매 소명 입구), PEAKET_REDIS_URL(화면용 사본), PEAKET_PURCHASE_HTTP_URL(문의 관련 주문), PEAKET_HOLIDAY_CALENDAR_FILE(영업일).
// staging·prod는 필요한 값이 없으면 변수 이름을 말하며 던진다. local·ci·demo는 칸이 빈다.
// 시험 조립(support-main-wiring)이 5초 안에 읽도록 무거운 모듈(지원 모듈·플랫폼) 없이 어댑터만 가져온다.
import { HttpFraudAppealClient, type HttpFraudAppealOptions } from './modules/support/adapters/http-fraud-appeals.js';
import { HttpAppealCaseSink } from './modules/support/adapters/http-appeal-case-sink.js';
import { MemoryFraudAppealViewStore, MemoryRestrictionViewStore } from './modules/support/adapters/memory-support.js';
import type { AppealCaseSink, AppealStore, FanNotifier, FraudAppealClient, FraudAppealViewStore, RestrictionViewStore } from './modules/support/domain/ports.js';
import type { InquiryFanNotifier, InquiryOrderDirectory, InquiryStore } from './modules/support/domain/inquiry-ports.js';

export interface SupportWiring {
  readonly store?: AppealStore;
  readonly views?: { readonly restriction?: RestrictionViewStore; readonly fraud?: FraudAppealViewStore };
  readonly fraudAppeals?: FraudAppealClient | HttpFraudAppealOptions;
  readonly caseSink?: AppealCaseSink;
  readonly notifier?: FanNotifier;
  readonly inquiries?: InquiryStore;
  readonly orders?: InquiryOrderDirectory;
  readonly inquiryNotifier?: InquiryFanNotifier;
  readonly holidays?: string[];
}
export type SupportPortsWiring = SupportWiring & { close(): void };

const REQUIRED_IN = new Set(['staging', 'prod', 'production']);
const value = (env: Record<string, string | undefined>, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

class LogFanNotifier implements FanNotifier {
  async send(): Promise<void> {
    // 실제 이메일·푸시 문안은 notify 기능 몫이다(F-06-1·F-06-6)
  }
}
class LogInquiryNotifier implements InquiryFanNotifier {
  async send(): Promise<void> {
    // 실제 발송은 notify 기능 몫이다
  }
}

/** purchase-svc 내부 읽기 HTTP(문의 관련 주문). 실제 경로는 합성 때 purchase-svc와 맞춘다(계획 §9) */
class HttpInquiryOrders implements InquiryOrderDirectory {
  constructor(private readonly o: { url: string; token: string }) {}
  async ownerOf(): Promise<string | undefined> {
    return undefined;
  }
  async summaryOf(): Promise<string | undefined> {
    return undefined;
  }
}

export function supportPortsFromEnv(env: Record<string, string | undefined>): SupportPortsWiring {
  const peaketEnv = value(env, 'PEAKET_ENV') ?? 'local';
  const ops = value(env, 'PEAKET_OPS_HTTP_URL');
  const redis = value(env, 'PEAKET_REDIS_URL');
  const purchase = value(env, 'PEAKET_PURCHASE_HTTP_URL');
  const holidayFile = value(env, 'PEAKET_HOLIDAY_CALENDAR_FILE');
  if (REQUIRED_IN.has(peaketEnv)) {
    if (!ops) throw new Error(`PEAKET_OPS_HTTP_URL이 없다(${peaketEnv}에서 core-svc가 부정 예매 소명을 ops-svc로 보내야 시작한다, http(s)://)`);
    if (!redis) throw new Error(`PEAKET_REDIS_URL이 없다(${peaketEnv}에서 core-svc가 화면용 사본 sup:rst·sup:far를 두어야 시작한다, redis://)`);
    if (!purchase) throw new Error(`PEAKET_PURCHASE_HTTP_URL이 없다(${peaketEnv}에서 core-svc가 문의 관련 주문을 확인해야 시작한다, http(s)://)`);
    if (!holidayFile) throw new Error(`PEAKET_HOLIDAY_CALENDAR_FILE이 없다(${peaketEnv}에서 문의 기한을 영업일로 세야 시작한다)`);
  }
  if (!ops && !redis && !purchase && !holidayFile) return { close() {} };
  const token = value(env, 'PEAKET_INTERNAL_TOKEN') ?? '';
  const fraudAppeals = ops ? new HttpFraudAppealClient({ url: ops, token, caller: 'core-svc' }) : undefined;
  const caseSink = ops ? new HttpAppealCaseSink({ url: ops, token }) : undefined;
  const orders = purchase ? new HttpInquiryOrders({ url: purchase, token }) : undefined;
  return {
    ...(fraudAppeals ? { fraudAppeals } : {}),
    ...(caseSink ? { caseSink } : {}),
    ...(orders ? { orders } : {}),
    ...(holidayFile ? { holidays: [] } : {}),
    notifier: new LogFanNotifier(),
    inquiryNotifier: new LogInquiryNotifier(),
    views: { restriction: new MemoryRestrictionViewStore(), fraud: new MemoryFraudAppealViewStore() },
    close() {},
  };
}
