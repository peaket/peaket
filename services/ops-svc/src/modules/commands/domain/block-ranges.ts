// 명령 4(ASN·IP 대역 차단) params 해석과 2인 조건(ADR-0339 결정 1·2).
// 대역은 표준 해석기(node:net)로 주소 꼴을 본 뒤 비트로 바꾼다. IPv4를 담은 IPv6 표기(::ffff:a.b.c.d/n)는 IPv4로 바꿔 본다(접두 길이 n − 96).
// 2인: ASN 항목이 있거나, IPv4 접두 길이 < 16, IPv6 접두 길이 < 48, 보호 목록 CIDR과 겹침(어느 쪽이 품어도). /16·/48은 1인이다.
import { isIP } from 'node:net';
import type { ProtectedRange, ProtectedRangeList } from './protected-ranges.js';

/** IPv4 2인 기준: 접두 길이가 이것보다 짧으면 2인(/16은 1인) */
export const BLOCK_IPV4_TWO_PERSON_BELOW = 16;
/** IPv6 2인 기준: 접두 길이가 이것보다 짧으면 2인(/48은 1인) */
export const BLOCK_IPV6_TWO_PERSON_BELOW = 48;
/** ASN 번호 범위(32비트) */
export const ASN_MIN = 1;
export const ASN_MAX = 4_294_967_295;

export interface ParsedCidr {
  readonly family: 4 | 6;
  /** 주소 비트 수(32·128) */
  readonly bits: 32 | 128;
  readonly addr: bigint;
  readonly prefix: number;
  /** 같은 대역을 가리는 표준 글자(가족:16진 주소/접두) */
  readonly key: string;
  /** 받은 글자 그대로 */
  readonly text: string;
}

const PREFIX = /^\d{1,3}$/;

function ipv4Bits(text: string): bigint | undefined {
  if (isIP(text) !== 4) return undefined;
  let v = 0n;
  for (const part of text.split('.')) v = (v << 8n) | BigInt(Number(part));
  return v;
}

function ipv6Bits(text: string): bigint | undefined {
  if (isIP(text) !== 6) return undefined;
  let head = text;
  let tailV4: bigint | undefined;
  // 끝에 IPv4 점 표기가 붙은 꼴(::ffff:1.2.3.4)
  const lastColon = head.lastIndexOf(':');
  const last = head.slice(lastColon + 1);
  if (last.includes('.')) {
    tailV4 = ipv4Bits(last);
    if (tailV4 === undefined) return undefined;
    head = `${head.slice(0, lastColon + 1)}0:0`;
  }
  const halves = head.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] === '' ? [] : halves[0]!.split(':');
  const right = halves.length === 2 ? (halves[1] === '' ? [] : halves[1]!.split(':')) : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array.from({ length: fill }, () => '0'), ...right];
  if (groups.length !== 8) return undefined;
  let v = 0n;
  for (const g of groups) v = (v << 16n) | BigInt(Number.parseInt(g, 16));
  if (tailV4 !== undefined) v = (v & ~0xffff_ffffn) | tailV4;
  return v;
}

/** 대역 글자 하나를 읽는다. 꼴이 틀리거나 접두 길이 0, 호스트 비트가 0이 아니면 undefined(ADR-0339 결정 2) */
export function parseCidr(raw: string): ParsedCidr | undefined {
  const slash = raw.indexOf('/');
  if (slash <= 0 || raw.indexOf('/', slash + 1) !== -1) return undefined;
  const addrText = raw.slice(0, slash);
  const prefixText = raw.slice(slash + 1);
  if (!PREFIX.test(prefixText)) return undefined;
  let prefix = Number(prefixText);
  let family: 4 | 6;
  let addr: bigint | undefined;
  if (addrText.includes(':')) {
    addr = ipv6Bits(addrText);
    if (addr === undefined) return undefined;
    family = 6;
    // IPv4를 담은 IPv6(::ffff:0:0/96)는 IPv4로 바꿔 본다
    if (addr >> 32n === 0xffffn) {
      if (prefix < 96 || prefix > 128) return undefined;
      family = 4;
      addr &= 0xffff_ffffn;
      prefix -= 96;
    }
  } else {
    addr = ipv4Bits(addrText);
    if (addr === undefined) return undefined;
    family = 4;
  }
  const bits = family === 4 ? 32 : 128;
  if (prefix <= 0 || prefix > bits) return undefined;
  const hostMask = (1n << BigInt(bits - prefix)) - 1n;
  if ((addr & hostMask) !== 0n) return undefined;
  return { family, bits, addr, prefix, key: `${family}:${addr.toString(16)}/${prefix}`, text: raw };
}

/** 두 대역이 겹치는가(같은 가족에서 짧은 접두로 잘라 같으면 한쪽이 다른 쪽을 품는다) */
export function cidrsOverlap(a: ParsedCidr, b: ParsedCidr): boolean {
  if (a.family !== b.family) return false;
  const shift = BigInt(a.bits - Math.min(a.prefix, b.prefix));
  return a.addr >> shift === b.addr >> shift;
}

export interface BlockParams {
  readonly cidrs: readonly ParsedCidr[];
  readonly asns: readonly number[];
  readonly expiresAtMs: number;
}

/** 대역·ASN 목록 꼴이 틀림(받는 층이 422 invalid-command로 바꾼다) */
export class BlockListInvalid extends Error {
  constructor(readonly why: string) {
    super(`block-list:${why}`);
    this.name = 'BlockListInvalid';
  }
}

/**
 * cidrs·asns 목록만 읽는다(만료는 보지 않는다). 꼴이 틀린 대역·호스트 비트·/0·빈 목록 둘·같은 항목 두 번이면 던진다(ADR-0339 결정 2)
 * @throws BlockListInvalid
 */
export function blockListsOf(p: Record<string, unknown>): Pick<BlockParams, 'cidrs' | 'asns'> {
  const rawCidrs = p.cidrs ?? [];
  const rawAsns = p.asns ?? [];
  if (!Array.isArray(rawCidrs) || !Array.isArray(rawAsns)) throw new BlockListInvalid('lists');
  const cidrs: ParsedCidr[] = [];
  for (const raw of rawCidrs as unknown[]) {
    const c = typeof raw === 'string' ? parseCidr(raw) : undefined;
    if (!c) throw new BlockListInvalid('cidr');
    cidrs.push(c);
  }
  const asns: number[] = [];
  for (const raw of rawAsns as unknown[]) {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < ASN_MIN || raw > ASN_MAX) throw new BlockListInvalid('asn');
    asns.push(raw);
  }
  if (cidrs.length === 0 && asns.length === 0) throw new BlockListInvalid('empty');
  if (new Set(cidrs.map((c) => c.key)).size !== cidrs.length) throw new BlockListInvalid('cidr-duplicate');
  if (new Set(asns).size !== asns.length) throw new BlockListInvalid('asn-duplicate');
  return { cidrs, asns };
}

export interface ProtectedRangeHit {
  readonly kind: 'ASN' | 'CIDR';
  readonly value: string;
  readonly category: ProtectedRange['category'];
  readonly label: string;
}

export interface BlockApproval {
  readonly mode: 'ONE' | 'TWO';
  /** 2인이 된 까닭(ASN·IPV4_WIDE·IPV6_WIDE·PROTECTED). 1인이면 빈 목록 */
  readonly reasons: readonly string[];
  readonly hits: readonly ProtectedRangeHit[];
}

/** 보호 목록과 걸린 항목. ASN은 번호가 같으면, CIDR은 겹치면 걸린다 */
export function protectedRangeHits(params: Pick<BlockParams, 'cidrs' | 'asns'>, list: ProtectedRangeList): ProtectedRangeHit[] {
  const hits: ProtectedRangeHit[] = [];
  for (const r of list.ranges) {
    if (r.kind === 'ASN') {
      if (params.asns.some((a) => String(a) === r.value)) hits.push({ kind: r.kind, value: r.value, category: r.category, label: r.label });
      continue;
    }
    const range = parseCidr(r.value);
    if (range && params.cidrs.some((c) => cidrsOverlap(c, range))) hits.push({ kind: r.kind, value: r.value, category: r.category, label: r.label });
  }
  return hits;
}

/** 명령 4의 승인 방식(ADR-0339 결정 1). 하나라도 맞으면 명령 전체가 2인이다 */
export function blockApprovalOf(params: Pick<BlockParams, 'cidrs' | 'asns'>, list: ProtectedRangeList): BlockApproval {
  const reasons: string[] = [];
  if (params.asns.length > 0) reasons.push('ASN');
  if (params.cidrs.some((c) => c.family === 4 && c.prefix < BLOCK_IPV4_TWO_PERSON_BELOW)) reasons.push('IPV4_WIDE');
  if (params.cidrs.some((c) => c.family === 6 && c.prefix < BLOCK_IPV6_TWO_PERSON_BELOW)) reasons.push('IPV6_WIDE');
  const hits = protectedRangeHits(params, list);
  if (hits.some((h) => h.kind === 'CIDR')) reasons.push('PROTECTED');
  return { mode: reasons.length > 0 ? 'TWO' : 'ONE', reasons, hits };
}
