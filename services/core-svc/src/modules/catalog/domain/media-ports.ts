// 도메인 층: 공연 이미지·좌석맵 가져오기가 쓰는 바깥 포트(ADR-0257 결정 1·5·8). 어댑터가 구현한다.
import type { ImageKind, ProductionImageRow } from './production-image.js';
import type { CheckedLayout, SeatmapFormat, SeatmapIssue, TooMany } from './seatmap-import.js';

/** image-worker ProcessImage의 최종 결과(SCAN_PENDING은 최종 결과가 아니다, ADR-0257 결정 1) */
export type ProcessOutcome =
  | { status: 'ACCEPTED'; width: number; height: number; derivativeKeys: string[] }
  | { status: 'REJECTED'; reason: 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'TOO_SMALL' | 'MALWARE' | 'UNKNOWN' }
  | { status: 'SCAN_PENDING' }
  | { status: 'UNKNOWN' };

/** 처리 작업이 답하지 않았다(데드라인 초과·연결 실패·그 밖의 gRPC 오류). fail-closed로 503이다 */
export class ImageProcessingUnavailable extends Error {}

/** 디코딩·다시 인코딩 포트(HOT-190은 ImageService.ProcessImage를 요청 안에서 바로 부르는 어댑터, HOT-200이 작업 원장 어댑터로 바꾼다) */
export interface ImageProcessing {
  /** timeoutMs는 이 호출의 데드라인(요청의 남은 시간에서 계산한다, ADR-0257 결정 2) */
  process(q: { sourceKey: string; kind: ImageKind; timeoutMs: number }): Promise<ProcessOutcome>;
}

/** 원본과 파생본을 두는 곳(격리 원본 쓰기·지우기, 준비 위치 읽기·지우기, 공개 위치 쓰기·지우기). 키는 서버가 만든 이미지 ID로만 만든다 */
export interface ImageObjectStore {
  putQuarantine(key: string, bytes: Uint8Array): Promise<void>;
  deleteQuarantine(key: string): Promise<void>;
  /** 없으면 undefined */
  readStaging(key: string): Promise<Uint8Array | undefined>;
  /** 준비 위치 객체의 크기(바이트, 읽지 않고 본다). 없으면 undefined */
  stagingSize(key: string): Promise<number | undefined>;
  deleteStaging(key: string): Promise<void>;
  putPublic(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  deletePublic(key: string): Promise<void>;
}

/** CDN 무효화(태그 단위, 실제 CDN 어댑터는 배포 단계) */
export interface CdnInvalidation {
  invalidate(tags: string[]): Promise<void>;
}

/** 공연 이미지 저장소(파트너 경로, 행 보안 대상 사용자로 접속하고 트랜잭션에 테넌트를 건다) */
export interface PartnerProductionMedia {
  /** 그 테넌트의 공연인가(없는 공연과 남의 공연은 같은 false) */
  owns(productionId: string, tenantId: string): Promise<boolean>;
  /** 상세 이미지 장수(처리 전에 미리 본다. 잠금 안에서 다시 본다) */
  detailCount(productionId: string, tenantId: string): Promise<number>;
  /** 공연 행을 잠근 트랜잭션에서 fn을 부른다. 공연이 없거나 남의 것이면 'not-found'이고 fn을 부르지 않는다 */
  withLockedProduction<T>(productionId: string, tenantId: string, fn: (tx: ProductionImageTx) => Promise<T>): Promise<T | 'not-found'>;
}

export interface ProductionImageTx {
  /** 그 공연의 이미지 전부 */
  images(): Promise<ProductionImageRow[]>;
  insert(row: ProductionImageRow): Promise<void>;
  remove(imageId: string): Promise<void>;
  update(imageId: string, patch: { alt?: string; order?: number; version: number; updatedAt: Date }): Promise<void>;
}

/** 해석 작업의 답(PARSED면 core-svc가 계약 스키마로 이미 본 배치, 스키마에 맞지 않으면 'invalid') */
/**
 * 해석 작업의 답. PARSED면 core-svc가 먼저 개수 상한을 보고(tooMany, 스키마보다 먼저) 그다음 계약 스키마로 본 배치다(맞지 않으면 'invalid')
 */
export type SeatmapParse =
  | { status: 'PARSED'; layout: CheckedLayout | 'invalid'; tooMany?: TooMany; errors: SeatmapIssue[]; ignored: string[] }
  | { status: 'REJECTED'; errors: SeatmapIssue[] };

/** seatmap-worker가 답하지 않았거나 쓸 수 없다(UNAVAILABLE·RESOURCE_EXHAUSTED·DEADLINE_EXCEEDED 등) */
export class SeatmapWorkerUnavailable extends Error {
  constructor(readonly grpcCode: string) {
    super(`seatmap-worker를 쓸 수 없다: ${grpcCode}`);
  }
}

export interface SeatmapParser {
  parse(file: Uint8Array, format: SeatmapFormat): Promise<SeatmapParse>;
}

export const IMAGE_PROCESSING = Symbol('IMAGE_PROCESSING');
export const IMAGE_OBJECT_STORE = Symbol('IMAGE_OBJECT_STORE');
export const CDN_INVALIDATION = Symbol('CDN_INVALIDATION');
export const PARTNER_PRODUCTION_MEDIA = Symbol('PARTNER_PRODUCTION_MEDIA');
export const SEATMAP_PARSER = Symbol('SEATMAP_PARSER');
/** 이미지 출처(PEAKET_IMAGE_BASE_URL, 운영 https://img.peaket.example) */
export const IMAGE_ORIGIN = Symbol('IMAGE_ORIGIN');
