// 도메인 층: 배치본 저장·불러오기와 팬 좌석맵 파일 게시가 쓰는 포트(ADR-0260 결정 5·6·9·10). 어댑터가 구현한다.
import type { Production } from './production.js';
import type { LayoutDoc, LayoutRound } from './seatmap-layout.js';

/**
 * 공개 파일을 두는 곳(팬 좌석맵 파일, ADR-0260 결정 6). 키는 `v1/events/{회차 ID}/seatmap-layouts/{판}.json` 꼴만 받는다(그 밖은 던진다).
 * 이 단계는 메모리(시험)와 로컬 폴더(개발, PEAKET_PUBLIC_FILE_DIR) 어댑터만 있다. S3 어댑터는 HOT-200
 */
export interface PublicFileStore {
  put(key: string, bytes: Uint8Array, meta: { contentType: string; cacheControl: string }): Promise<void>;
  /** 없으면 아무것도 하지 않는다 */
  delete(key: string): Promise<void>;
}

/** 게시의 동시 쓰기 수와 전체 시한(ms). 기본은 8개·20초 [가정](domain/seatmap-layout.ts) */
export interface PublishLimits {
  concurrency: number;
  totalMs: number;
}

/** 잠근 공연에서 읽은 배치본 상태 */
export interface LayoutState {
  production: Pick<Production, 'id' | 'promoterId' | 'saleReview' | 'saleApprovedAt'>;
  /** 배치본 행(아직 없으면 null). 판 0이고 대기 판이 없으면 저장한 배치가 없다 */
  venue: {
    id: string;
    layoutVersion: number;
    versionSeq: number;
    /** 행 판을 공개 위치에 게시했으면 그 판 */
    publishedVersion: number | null;
    /** staged: 대기 판의 팬 파일을 준비 위치에 썼는지 */
    pending: { version: number; doc: LayoutDoc; staged: boolean } | null;
    templateVenueId: string | null;
  } | null;
  /** 그 공연의 회차(event 행과 변경분의 더한 회차) */
  rounds: (LayoutRound & { pending: boolean })[];
}

/** 공연 행을 잠근 트랜잭션 안의 일(등록·회차 더하기·이미지와 같은 FOR NO KEY UPDATE, docs/data.md §5) */
export interface LayoutTx {
  state(): Promise<LayoutState>;
  /** 행에 있는 배치(판 0이면 undefined) */
  rowLayout(): Promise<LayoutDoc | undefined>;
  /** 행에 있는 좌석 ID(서버가 매긴 소문자 UUID) */
  rowSeatIds(): Promise<Set<string>>;
  /** version_seq + 1을 새 판으로 잡는다. 배치본 행이 없으면 판 0으로 만든다(회차에는 아직 잇지 않는다) */
  reserveVersion(): Promise<number>;
  /** 승인 이력이 없는 공연: 구역·좌석·가격 등급 행을 바꿔 넣고 캔버스·무대·판을 고친다. 대기 판은 비운다. published면 게시 판(published_version)도 그 판이다 */
  saveRows(doc: LayoutDoc, version: number, published: boolean): Promise<void>;
  /** 승인 이력이 있는 공연: 행은 그대로 두고 대기 판에 쓰며(staged: 준비 위치에 팬 파일을 썼는지) 판매 승인 상태를 바꾼다 */
  savePending(doc: LayoutDoc, version: number, saleReview: Production['saleReview'], staged: boolean): Promise<void>;
  /** 그 공연의 모든 event 행과 변경분의 더한 회차에 이 배치본을 잇는다(ADR-0260 결정 8) */
  linkRounds(): Promise<void>;
  /** 공개된 TEMPLATE 행인가(LAYOUT·공개되지 않은 틀·없는 ID는 false) */
  templateOk(templateVenueId: string): Promise<boolean>;
}

/** 배치본 저장소(파트너 경로, 행 보안 대상 사용자로 접속하고 트랜잭션에 테넌트를 건다. 조회에도 테넌트 조건을 넣는다) */
export interface SeatmapLayoutStore {
  /** 그 테넌트의 공연인가(없는 공연과 남의 공연은 같은 false) */
  owns(productionId: string, tenantId: string): Promise<boolean>;
  /** 그 테넌트의 공연이면 승인 이력, 아니면 undefined(잠금 밖에서 먼저 본다. 잠금 안에서 다시 본다) */
  ownerView(productionId: string, tenantId: string): Promise<{ approvedBefore: boolean } | undefined>;
  /** 지금 판(대기 판이 있으면 그 판)과 그 배치. 저장한 배치가 없으면 undefined, 공연이 없거나 남의 것이면 'not-found' */
  current(productionId: string, tenantId: string): Promise<{ version: number; doc: LayoutDoc } | undefined | 'not-found'>;
  /**
   * 오픈 뒤 잠금 판정에 쓰는 값(승인 시각과 그 공연의 회차: event 행과 변경분의 더한 회차). 불러오기 응답 geometryLocked(ADR-0264 결정 13)가 쓴다.
   * 공연이 없거나 남의 것이면 undefined
   */
  lockFacts(productionId: string, tenantId: string): Promise<{ saleApprovedAt: Date | null; rounds: LayoutRound[] } | undefined>;
  /** 공개된 TEMPLATE 행의 캔버스·무대·구역(좌석 없음)을 판 0 초안으로. 없거나 공개되지 않았거나 LAYOUT이면 undefined */
  templateDraft(templateVenueId: string, tenantId: string): Promise<LayoutDoc | undefined>;
  /** 공연 행을 잠근 트랜잭션에서 fn을 부른다. 공연이 없거나 남의 것이면 'not-found'이고 fn을 부르지 않는다 */
  withLockedProduction<T>(productionId: string, tenantId: string, fn: (tx: LayoutTx) => Promise<T>): Promise<T | 'not-found'>;
}

export const PUBLIC_FILE_STORE = Symbol('PUBLIC_FILE_STORE');
export const PUBLISH_LIMITS = Symbol('PUBLISH_LIMITS');
export const SEATMAP_LAYOUT_STORE = Symbol('SEATMAP_LAYOUT_STORE');
