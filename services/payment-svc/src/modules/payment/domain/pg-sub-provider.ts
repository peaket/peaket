// 포트원 채널의 하위 결제사 규칙(docs/features/payment.md §2.2 '대체 채널의 하위 결제사'·'하위 결제사 검사의 첫 구현', ADR-0093 결정 2, open-items 47, BUILD_ORDER PRF-203).
// 프레임워크·저장소를 모른다(순수 값과 함수). 회차 지정 쓰임새·시작 설정 검사·대체 후보 빼기가 같은 함수를 쓴다.
import { PAY_METHODS, type PayMethod, type PgName } from './payment-gateway.js';
import type { PgPlatformDefaults } from './pg-selection.js';

/**
 * 포트원 V2 하위 결제사 값(공식 스키마 v2.openapi.json 1.16.0 components.schemas.PgProvider, 2026-11-10 확인).
 * 사본은 test/fixtures/portone/pg-provider-enum.json이고 시험이 이 목록과 맞는지 본다(손으로 고치지 않는다)
 */
export const PORTONE_PG_PROVIDERS = [
  'HTML5_INICIS', 'PAYPAL', 'PAYPAL_V2', 'INICIS', 'DANAL', 'NICE', 'DANAL_TPAY', 'JTNET', 'UPLUS', 'NAVERPAY', 'KAKAO', 'SETTLE', 'KCP', 'MOBILIANS', 'KAKAOPAY', 'NAVERCO', 'SYRUP', 'KICC', 'EXIMBAY', 'SMILEPAY',
  'PAYCO', 'KCP_BILLING', 'ALIPAY', 'PAYPLE', 'CHAI', 'BLUEWALNUT', 'SMARTRO', 'SMARTRO_V2', 'PAYMENTWALL', 'TOSSPAYMENTS', 'KCP_QUICK', 'DAOU', 'GALAXIA', 'TOSSPAY', 'KCP_DIRECT', 'SETTLE_ACC', 'SETTLE_FIRM', 'INICIS_UNIFIED', 'KSNET', 'PINPAY',
  'NICE_V2', 'TOSS_BRANDPAY', 'WELCOME', 'TOSSPAY_V2', 'INICIS_V2', 'KPN', 'KCP_V2', 'HYPHEN', 'EXIMBAY_V2', 'INICIS_JP', 'PAYLETTER_GLOBAL', 'MOBILIANS_V2', 'TRIPLE_A', 'KICC_V2', 'INNOPAY', 'HECTO_GLOBAL', 'PAYLETTER',
] as const;

/** 토스페이먼츠와 같은 결제사(토스페이먼츠, 토스페이먼츠 브랜드페이) */
export const TOSS_SAME_PG_PROVIDERS: ReadonlySet<string> = new Set(['TOSSPAYMENTS', 'TOSS_BRANDPAY']);
/** 토스페이먼츠 장애 때 함께 멈추는지 확인 전(토스페이, open-items 47). 확인하기 전에는 같은 결제사처럼 막는다 */
export const UNCONFIRMED_PG_PROVIDERS: ReadonlySet<string> = new Set(['TOSSPAY', 'TOSSPAY_V2']);

const PROVIDERS: ReadonlySet<string> = new Set(PORTONE_PG_PROVIDERS);
export const isPortonePgProvider = (value: string): boolean => PROVIDERS.has(value);

/** 설정의 포트원 채널 표: 수단 → 채널 키, 채널 키 → 하위 결제사(값이 없는 채널은 local·ci뿐이다) */
export interface PortoneChannelMap {
  readonly byMethod: ReadonlyMap<PayMethod, string>;
  readonly providers: ReadonlyMap<string, string>;
}

/** 어댑터 설정(채널 키 하나 또는 수단별 표)과 하위 결제사 표로 채널 표를 만든다. 수단별 표가 없으면 채널 키 하나가 다섯 수단을 모두 받는다 */
export function portoneChannelMapOf(o: { readonly channelKey: string; readonly channelKeys?: Readonly<Partial<Record<PayMethod, string>>> }, providers: Readonly<Record<string, string>> | undefined): PortoneChannelMap {
  const byMethod = new Map<PayMethod, string>();
  for (const method of PAY_METHODS) {
    const key = o.channelKeys === undefined ? o.channelKey : o.channelKeys[method];
    if (key !== undefined) byMethod.set(method, key);
  }
  return { byMethod, providers: new Map(Object.entries(providers ?? {})) };
}

/** 쓰는 채널 키(겹치지 않게) */
export const channelKeysInUse = (portone: PortoneChannelMap): ReadonlySet<string> => new Set(portone.byMethod.values());

export type SubProviderConflictReason = 'SAME_PROVIDER' | 'UNCONFIRMED';

export interface SubProviderConflict {
  readonly provider: string;
  readonly reason: SubProviderConflictReason;
}

/**
 * 한 회차의 기본과 대체가 토스페이먼츠와 포트원의 짝이면(어느 쪽이 기본이든), 쓰는 포트원 채널 가운데 하나라도 같은 결제사이거나 확인 전이면 걸린다.
 * 같은 결제사를 확인 전보다 먼저 보고한다. 값이 없는 채널은 보지 못한다
 */
export function subProviderConflict(primary: PgName, fallback: PgName | undefined, portone: PortoneChannelMap | undefined): SubProviderConflict | undefined {
  if (fallback === undefined || portone === undefined) return undefined;
  const pair = new Set<PgName>([primary, fallback]);
  if (!(pair.has('TOSS') && pair.has('PORTONE'))) return undefined;
  const providers = [...channelKeysInUse(portone)].map((key) => portone.providers.get(key)).filter((p): p is string => p !== undefined);
  const same = providers.find((p) => TOSS_SAME_PG_PROVIDERS.has(p));
  if (same !== undefined) return { provider: same, reason: 'SAME_PROVIDER' };
  const unconfirmed = providers.find((p) => UNCONFIRMED_PG_PROVIDERS.has(p));
  return unconfirmed === undefined ? undefined : { provider: unconfirmed, reason: 'UNCONFIRMED' };
}

/** 대체 결제사가 하위 결제사까지 기본과 같거나 확인 전이다(이름 붙은 오류 pg-fallback-same-provider, REST 422). 표는 바꾸지 않는다 */
export class PgFallbackSameProviderError extends Error {
  readonly code = 'FAILED_PRECONDITION' as const;
  readonly problem = 'pg-fallback-same-provider' as const;
  readonly status = 422 as const;
  constructor(readonly conflict: SubProviderConflict) {
    super('pg-fallback-same-provider');
    this.name = 'PgFallbackSameProviderError';
  }
}

/**
 * 플랫폼 기본값(PEAKET_PG_DEFAULT·PEAKET_PG_FALLBACK)이 규칙에 걸리면 시작을 멈춘다(배포 검사, P-T46 ③).
 * @throws Error 걸림(글에 하위 결제사 이름과 까닭만 싣는다)
 */
export function assertPlatformSubProviders(defaults: PgPlatformDefaults, portone: PortoneChannelMap | undefined): void {
  const conflict = subProviderConflict(defaults.primary, defaults.fallback, portone);
  if (conflict !== undefined) throw new Error(`pg-fallback-same-provider: 플랫폼 기본 결제사(${defaults.primary})와 대체(${defaults.fallback})가 하위 결제사 ${conflict.provider}(${conflict.reason === 'SAME_PROVIDER' ? '같은 결제사' : '확인 전'})를 함께 거친다`);
}

/** 하위 결제사 하나가 기준 결제사와 규칙에 걸리는가(기준이 토스페이먼츠이고 같은 결제사이거나 확인 전) */
function conflictsWithBase(base: PgName, provider: string | undefined): boolean {
  return base === 'TOSS' && provider !== undefined && (TOSS_SAME_PG_PROVIDERS.has(provider) || UNCONFIRMED_PG_PROVIDERS.has(provider));
}

/**
 * 전환이 포트원을 고를 때 대체 후보에서 뺄 수단(docs/features/payment.md §2.2 '대체 후보에서 빼기'). 그 수단의 채널이
 * ① 관측 값이 있고 설정 값과 다르거나 ② 실제 하위 결제사(관측 값이 있으면 관측 값, 없으면 설정 값)가 기준 결제사와 규칙에 걸리면 뺀다(코드 리뷰 F1).
 * 설정 값도 관측 값도 없는 채널(local·ci)은 빼지 않는다
 */
export function excludedFallbackMethods(portone: PortoneChannelMap, observed: ReadonlyMap<string, string>, base: PgName): ReadonlySet<PayMethod> {
  const out = new Set<PayMethod>();
  for (const [method, key] of portone.byMethod) {
    const configured = portone.providers.get(key);
    const seen = observed.get(key);
    const mismatch = configured !== undefined && seen !== undefined && seen !== configured;
    if (mismatch || conflictsWithBase(base, seen ?? configured)) out.add(method);
  }
  return out;
}
