// 명령 4(ASN·IP 대역 차단)의 보호 대역 목록(ADR-0339 결정 3·4, docs/features/control-tower.md §3 '명령 4의 2인 조건과 보호 대역 목록의 첫 구현').
// 목록은 코드 안의 정적 데이터다. 운영 명령으로 바꾸지 못한다(운영자가 목록을 줄여 2인을 피하지 못하게). 바꾸면 ADR-0339 '목록 판' 줄에 판과 까닭을 더한다.

export type ProtectedRangeCategory = 'KR_CARRIER' | 'CLOUD';

export interface ProtectedRange {
  readonly kind: 'ASN' | 'CIDR';
  /** ASN은 10진 번호 글자, CIDR은 표준 표기 */
  readonly value: string;
  readonly category: ProtectedRangeCategory;
  readonly label: string;
  readonly source: string;
}

/** 목록 판(날짜). dry-run 결과에 함께 싣는다 */
export const PROTECTED_RANGES_VERSION = '2026-11-21';

const ADR = 'ADR-0339 결정 4';

/** 첫 목록(판 2026-11-21) [가정]: ASN 11개, CIDR 없음 */
export const PROTECTED_RANGES: readonly ProtectedRange[] = Object.freeze([
  { kind: 'ASN', value: '4766', category: 'KR_CARRIER', label: 'KT', source: ADR },
  { kind: 'ASN', value: '9318', category: 'KR_CARRIER', label: 'SK브로드밴드', source: ADR },
  { kind: 'ASN', value: '3786', category: 'KR_CARRIER', label: 'LG유플러스', source: ADR },
  { kind: 'ASN', value: '17858', category: 'KR_CARRIER', label: 'LG유플러스', source: ADR },
  { kind: 'ASN', value: '9644', category: 'KR_CARRIER', label: 'SK텔레콤', source: ADR },
  { kind: 'ASN', value: '16509', category: 'CLOUD', label: 'AWS', source: ADR },
  { kind: 'ASN', value: '14618', category: 'CLOUD', label: 'AWS', source: ADR },
  { kind: 'ASN', value: '15169', category: 'CLOUD', label: 'Google', source: ADR },
  { kind: 'ASN', value: '396982', category: 'CLOUD', label: 'Google', source: ADR },
  { kind: 'ASN', value: '8075', category: 'CLOUD', label: 'Microsoft', source: ADR },
  { kind: 'ASN', value: '13335', category: 'CLOUD', label: 'Cloudflare', source: ADR },
] satisfies ProtectedRange[]);

/** 시험·조립이 다른 목록을 넣을 때의 꼴(판과 항목) */
export interface ProtectedRangeList {
  readonly version: string;
  readonly ranges: readonly ProtectedRange[];
}

export const DEFAULT_PROTECTED_RANGES: ProtectedRangeList = Object.freeze({ version: PROTECTED_RANGES_VERSION, ranges: PROTECTED_RANGES });
