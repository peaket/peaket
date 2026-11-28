// F-02-6(동결 로컬) 명령 4·6의 바깥 세계 포트. 실제 AWS(WAF·CloudFront KeyValueStore)는 미실행이고,
// 시험·local은 Memory* 가짜를 쓴다. 이 파일은 프레임워크를 모른다.
// 정본: control-tower §5 'AWS WAF API'·'CDN 설정 API', ADR-0234 결정 5, ADR-0078 결정 2, ADR-0349 결정 9·10.

export type WafBlockPart = 'cidr' | 'asn';

/** WAF 적용이 어느 쪽에서 실패했는지 실행기가 `waf-unavailable:<part>`로 바꾼다 */
export class WafBlockApplyError extends Error {
  constructor(readonly part: WafBlockPart) {
    super(`waf-${part}`);
    this.name = 'WafBlockApplyError';
  }
}

export interface WafBlockInput {
  readonly cidrs: readonly string[];
  readonly asns: readonly number[];
  readonly expiresAtMs: number;
}

export interface WafBlockRemaining {
  readonly cidrs: readonly string[];
  readonly asns: readonly number[];
}

/**
 * 명령 4의 관제용 IP 집합·ASN 목록 포트. apply는 멱등이고, release는 그 명령이 소유한 항목 가운데
 * 다른 살아 있는 명령이 막지 않는 것만 뺀다(가짜는 명령 ID별 소유를 기억한다).
 */
export interface WafBlocks {
  apply(commandId: string, block: WafBlockInput): Promise<void>;
  release(commandId: string): Promise<void>;
  remaining(commandId: string): Promise<WafBlockRemaining>;
}

/** 엣지 저장소 mode:entry 값(엣지 함수가 읽는 꼴 그대로) */
export interface EntryModeValue {
  readonly on: boolean;
  readonly expireAtMs: number;
}

/** 엣지 저장소 쓰기 포트(ADR-0234의 쓰기 전용 작은 함수 자리) */
export interface EntryModeStore {
  write(value: EntryModeValue): Promise<void>;
  read(): Promise<EntryModeValue | undefined>;
}

/** CloudFront 설정 가짜·실제 어댑터가 함께 쓰는 상태. 실제 CloudFront는 미실행 */
export interface CdnOriginGroup {
  readonly failoverCodes: readonly number[];
  readonly connectionTimeoutMs: number;
  readonly attempts: number;
}

export interface CdnEdgeState {
  readonly queueFilesOrigin: 'ORIGIN_GROUP' | 'S3_FALLBACK';
  readonly queueEntryResponse: 'ORIGIN' | 'SOLD_OUT_STATIC';
  readonly originGroup: CdnOriginGroup;
}

export interface CdnEdgeChange {
  readonly stateMirrorFixed?: boolean;
  readonly soldOutStatic?: boolean;
}

/** CloudFront 설정 포트(명령 6 S3 사본 고정·매진 정적 응답) */
export interface CdnEdgeSettings {
  read(): Promise<CdnEdgeState>;
  apply(change: CdnEdgeChange): Promise<CdnEdgeState>;
}
