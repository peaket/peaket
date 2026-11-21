// 명령 4(IP 대역 차단)의 만료 정리 판정(ADR-0349 결정 9·10, docs/features/control-tower.md §5 'AWS WAF API' 행·'만료 차단 정리의 첫 구현', C-T61).
// WAF IP 집합은 주소 판 하나만 담아 IPv4·IPv6 둘이다. 대역은 block-ranges.ts의 해석기로 같은 키(가족:16진 주소/접두)로 견준다.
// - 정리 작업(waf-block-expirer): 뺄 대역 = 만료가 지난(만료 시각 ≤ 지금) ACKED 명령 4의 대역 가운데, 만료 전 ACKED 명령 4에 같은 대역이 없고, IP 집합에 있는 것.
//   IP 집합의 다른 항목(명령 기록에 없는 대역, 읽지 못하는 꼴)은 그대로 둔다.
// - ops-svc 정비 바퀴: 만료가 지난 ACKED 명령 4의 대역마다 IP 집합에 없거나 만료 전 다른 ACKED 명령 4가 같은 대역을 막으면 AUTO_EXPIRED(SYSTEM)다.
//   ASN 항목이 있는 명령은 IP 집합이 아니라 규칙의 만료라 이 판정 밖이다(명령 4 전송, OPS-310). 그대로 ACKED로 둔다.
import { parseCidr, type ParsedCidr } from './block-ranges.js';

/** 보기 waf_block_expiry_v 한 행(명령 4의 대역 하나) */
export interface BlockExpiryRow {
  readonly commandId: string;
  /** 정규화한 CIDR 글자 */
  readonly cidr: string;
  readonly expiresAtMs: number;
  readonly state: string;
}

/** 보기 waf_block_expiry_v 읽기 포트(작업 역할 waf_block_expirer는 이 보기만 읽는다) */
export interface BlockExpiryView {
  rows(): Promise<readonly BlockExpiryRow[]>;
}

/** IP 집합 하나의 지금 내용과 잠금 토큰 */
export interface IpSetSnapshot {
  readonly addresses: readonly string[];
  readonly lockToken: string;
}

export type IpFamily = 4 | 6;

/** 잠금 토큰이 낡았다(그사이 다른 쪽이 IP 집합을 바꿨다, WAFOptimisticLockException) */
export class WafLockConflict extends Error {
  constructor() {
    super('waf-optimistic-lock');
    this.name = 'WafLockConflict';
  }
}

/** IP 집합 둘(가족별)의 읽기·통째 바꾸기 포트(어댑터 adapters/waf-ip-sets.ts) */
export interface WafIpSets {
  get(family: IpFamily): Promise<IpSetSnapshot>;
  /** 가족별 대역 글자(정비 바퀴의 읽기) */
  read(family: IpFamily): Promise<readonly string[]>;
  /**
   * 읽은 잠금 토큰으로 전체 목록을 바꾼다.
   * @throws WafLockConflict 잠금 토큰이 낡음
   */
  replace(family: IpFamily, addresses: readonly string[], lockToken: string): Promise<void>;
}

/** 만료가 지났는가(정각 포함. 만료 − 1ms는 아직이다) */
export const blockExpired = (expiresAtMs: number, nowMs: number): boolean => nowMs >= expiresAtMs;

const keyOf = (text: string): ParsedCidr | undefined => parseCidr(text.trim());

/** 만료 전 ACKED 명령 4가 막는 대역 키 */
export function liveBlockKeys(rows: readonly BlockExpiryRow[], nowMs: number): Set<string> {
  const live = new Set<string>();
  for (const r of rows) {
    if (r.state !== 'ACKED' || blockExpired(r.expiresAtMs, nowMs)) continue;
    const p = keyOf(r.cidr);
    if (p) live.add(p.key);
  }
  return live;
}

export interface BlockRemoval {
  readonly family: IpFamily;
  /** IP 집합에서 뺄 항목(집합에 있던 글자 그대로) */
  readonly addresses: readonly string[];
  /** 뺀 대역 키 → 그 대역을 낸 만료 명령 ID들 */
  readonly commandIds: readonly string[];
  /** IP 집합에 남길 항목(그 차례 그대로) */
  readonly keep: readonly string[];
}

/**
 * IP 집합 하나에서 뺄 항목을 고른다. 읽지 못하는 항목·명령 기록에 없는 항목·만료 전 명령이 막는 항목은 남긴다.
 * @returns 뺄 것이 없으면 addresses가 빈 목록
 */
export function blockRemovalOf(family: IpFamily, set: readonly string[], rows: readonly BlockExpiryRow[], nowMs: number): BlockRemoval {
  const live = liveBlockKeys(rows, nowMs);
  const expired = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.state !== 'ACKED' || !blockExpired(r.expiresAtMs, nowMs)) continue;
    const p = keyOf(r.cidr);
    if (!p || p.family !== family || live.has(p.key)) continue;
    const ids = expired.get(p.key) ?? new Set<string>();
    ids.add(r.commandId);
    expired.set(p.key, ids);
  }
  const addresses: string[] = [];
  const keep: string[] = [];
  const commandIds = new Set<string>();
  for (const entry of set) {
    const p = keyOf(entry);
    const ids = p && p.family === family ? expired.get(p.key) : undefined;
    if (ids) {
      addresses.push(entry);
      for (const id of ids) commandIds.add(id);
    } else {
      keep.push(entry);
    }
  }
  return { family, addresses, commandIds: [...commandIds].sort(), keep };
}

/** IP 집합 항목의 대역 키(가족별). 읽지 못하는 항목은 빠진다 */
export function ipSetKeys(addresses: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const a of addresses) {
    const p = keyOf(a);
    if (p) out.add(p.key);
  }
  return out;
}

/** 정비 바퀴가 보는 명령 4 하나(params의 대역·ASN과 만료) */
export interface ExpiredBlockCommand {
  readonly commandId: string;
  readonly cidrs: readonly string[];
  readonly asnCount: number;
  readonly expiresAtMs: number;
}

export type BlockExpiryVerdict =
  /** 대역이 모두 IP 집합에 없거나 만료 전 다른 명령 4가 같은 대역을 막는다: AUTO_EXPIRED */
  | { readonly expire: true; readonly reason: 'waf-removed' | 'superseded' }
  /** 아직(만료 전, 집합에 남은 대역, ASN 항목, 그 가족의 집합을 읽지 못함) */
  | { readonly expire: false; readonly why: 'not-expired' | 'still-blocked' | 'asn' | 'ip-set-unread' };

/**
 * 명령 4 하나의 AUTO_EXPIRED 판정(ADR-0349 결정 10).
 * @param sets 가족별 IP 집합의 대역 키(읽지 못한 가족은 없다)
 * @param liveOthers 만료 전 다른 ACKED 명령 4의 대역 키
 */
export function blockExpiryVerdict(c: ExpiredBlockCommand, nowMs: number, sets: Partial<Record<IpFamily, ReadonlySet<string>>>, liveOthers: ReadonlySet<string>): BlockExpiryVerdict {
  if (!blockExpired(c.expiresAtMs, nowMs)) return { expire: false, why: 'not-expired' };
  if (c.asnCount > 0) return { expire: false, why: 'asn' };
  let superseded = false;
  for (const raw of c.cidrs) {
    const p = keyOf(raw);
    if (!p) continue;
    const set = sets[p.family];
    if (!set) return { expire: false, why: 'ip-set-unread' };
    if (!set.has(p.key)) continue;
    if (liveOthers.has(p.key)) {
      superseded = true;
      continue;
    }
    return { expire: false, why: 'still-blocked' };
  }
  return { expire: true, reason: superseded ? 'superseded' : 'waf-removed' };
}

/** params(명령 4)에서 대역 글자와 ASN 수를 읽는다(접수 때 검사를 지난 값) */
export function blockCommandOf(commandId: string, params: Record<string, unknown>, expiresAtMs: number): ExpiredBlockCommand {
  const cidrs = Array.isArray(params.cidrs) ? params.cidrs.filter((v): v is string => typeof v === 'string') : [];
  const asnCount = Array.isArray(params.asns) ? params.asns.length : 0;
  return { commandId, cidrs, asnCount, expiresAtMs };
}
