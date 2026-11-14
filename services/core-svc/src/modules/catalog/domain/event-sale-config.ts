// 회차 판매 설정 사본(판매 승인 LCH-080, docs/data.md `q:{event:E}:cfg`, docs/features/seat-hold.md §4 '판매 정책 규칙의 한도').
// 판매 승인은 이 값을 대기열 Redis와 core DB `event_sale_config`에 쓴다. queue-svc는 대기열 Redis를, purchase-svc(BAT-051)는
// core DB 사본을 읽어 홀드 때 같은 판매 정책 규칙을 평가한다. 순수 함수라 저장소를 모른다.
import { salePhases, type SalePolicyRule } from '@peaket/validation/sale-policy';
import type { Condition } from '@peaket/validation/sale-policy';
import { saleEndsAt } from './production.js';
import type { SaleEventRow, SaleState } from './sale-ports.js';

/** 대기열 일정 사본 `eligGates`의 창 하나(docs/data.md) */
export interface SaleEligibilityGate {
  fromMs: number;
  toMs: number;
  lists: string[];
}

/** 회차 하나의 판매 설정 사본. 선택 칸은 값이 있을 때만 쓴다 */
export interface EventSaleConfig {
  eventId: string;
  productionId: string;
  promoterId: string;
  /** 판매 승인·설정 고치기의 판. queue-svc는 이 값이 지금보다 클 때만 바꾼다 */
  rev: number;
  opensAtMs: number;
  startsAtMs: number;
  lobbyMinutes: number;
  lobbyShuffle: boolean;
  openBatch: boolean;
  perPersonLimit: number;
  saleEndsAtMs: number;
  /** 재입장 허용 여부(POL-018). 스캐너 근무 준비·배치 판정이 읽는다(GAT-170 잔여) */
  reentryAllowed?: boolean;
  /** 입장 시작 시각(없으면 비운다). 스캐너 근무 준비 응답에 싣는다 */
  entryOpensAtMs?: number | null;
  /** 공연 종료 예정 시각(event.ends_at) */
  endsAtMs?: number;
  /** 입장 기록 마감 시각. 아직 마감 전이면 null */
  entryClosedAtMs?: number | null;
  /** 게시한 좌석맵 판. 자동 배정 회차는 없다 */
  layoutVersion?: number;
  /** 결제사 묶음 이름과 승인 상한(초당 건수). 없으면 결제사 상한을 걸지 않는다 */
  pgKey?: string;
  pgTps?: number;
  /** 승인한 판매 정책 규칙(공개본) */
  salePolicy: SalePolicyRule[];
  /** 진입 자격 창(단계 요약의 PRESALE 조각) */
  eligGates: SaleEligibilityGate[];
  /** 그 회차에 걸리는 규칙이 쓰는 명단 키 모두(입장 토큰 lst의 후보) */
  eligLists: string[];
}

/** 판매 설정에 곁들이는 값(좌석맵 판·결제사 상한). 저장소가 채운다 */
export interface EventSaleConfigFacts {
  layoutVersion?: number;
  pgKey?: string;
  pgTps?: number;
}

/** 조건 나무에서 `buyer.lists`의 `has` 키를 모은다(규칙의 명단 후보) */
function collectListKeys(c: Condition | undefined, out: Set<string>): void {
  if (!c) return;
  if ('all' in c) for (const x of c.all) collectListKeys(x, out);
  else if ('any' in c) for (const x of c.any) collectListKeys(x, out);
  else if ('not' in c) collectListKeys(c.not, out);
  else if (c.fact === 'buyer.lists' && typeof c.has === 'string') out.add(c.has);
}

/** 그 회차에 걸리는 규칙이 쓰는 명단 키(규칙 차례, 중복 없음) */
export function eligibleListKeys(rules: readonly SalePolicyRule[], eventId: string): string[] {
  const out = new Set<string>();
  for (const r of rules) {
    if (!r.rule || (r.rounds !== 'ALL' && !r.rounds.includes(eventId))) continue;
    collectListKeys(r.rule.if, out);
  }
  return [...out];
}

/**
 * 승인된 공연 상태에서 회차마다 판매 설정 사본을 만든다.
 * - `rev`는 판매 정책 판과 회차 판 가운데 큰 값이다. 어느 쪽이 바뀌어도 queue-svc가 새 값을 받는다.
 * - `eligGates`는 `salePhases`의 PRESALE 조각만 쓴다(일반 판매 구간은 창이 아니다).
 * - `eligLists`는 그 회차에 걸리는 규칙이 쓰는 명단 키 모두다.
 * - 취소된 회차는 쓰지 않는다.
 */
export function buildEventSaleConfigs(st: SaleState, facts: ReadonlyMap<string, EventSaleConfigFacts>, _now: Date): EventSaleConfig[] {
  const rules = st.production.rules;
  return st.events
    .filter((e) => e.status !== 'CANCELLED')
    .map((e) => configOf(st.production.id, st.production.promoterId, e, rules, st.production.salePolicyVersion, facts.get(e.eventId) ?? {}));
}

function configOf(productionId: string, promoterId: string, e: SaleEventRow, rules: SalePolicyRule[], policyVersion: number, facts: EventSaleConfigFacts): EventSaleConfig {
  const end = saleEndsAt(e);
  const phases = salePhases(rules, e.eventId, { openAt: e.openAt, saleEndsAt: end, perPersonLimit: e.perPersonLimit });
  const eligGates = phases
    .filter((p) => p.kind === 'PRESALE')
    .map((p) => ({ fromMs: p.startsAt.getTime(), toMs: p.endsAt.getTime(), lists: [...p.lists] }));
  const rev = Math.max(policyVersion, e.version);
  return {
    eventId: e.eventId,
    productionId,
    promoterId,
    rev,
    opensAtMs: e.openAt.getTime(),
    startsAtMs: e.startsAt.getTime(),
    lobbyMinutes: e.lobbyMinutes,
    lobbyShuffle: e.lobbyShuffle,
    openBatch: e.openBatch,
    perPersonLimit: e.perPersonLimit,
    saleEndsAtMs: end.getTime(),
    reentryAllowed: e.reentryAllowed,
    entryOpensAtMs: e.entryOpensAt?.getTime() ?? null,
    endsAtMs: e.endsAt.getTime(),
    entryClosedAtMs: e.entryClosedAt?.getTime() ?? null,
    ...(facts.layoutVersion !== undefined ? { layoutVersion: facts.layoutVersion } : {}),
    ...(facts.pgKey !== undefined ? { pgKey: facts.pgKey } : {}),
    ...(facts.pgTps !== undefined ? { pgTps: facts.pgTps } : {}),
    salePolicy: rules,
    eligGates,
    eligLists: eligibleListKeys(rules, e.eventId),
  };
}
