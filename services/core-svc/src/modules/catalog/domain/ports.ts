// 도메인 층: 카탈로그 저장소 포트(어댑터가 구현한다).
import type { SalePolicyRule } from '@peaket/validation/sale-policy';
import type { RoundRow, SellerRow } from './event-detail.js';
import type { CatalogEvent, Genre, Production } from './production.js';
import type { EventDraft, PendingEvent } from './registration.js';
import type { DescriptionDoc, KopisFields } from './description.js';
import type { LayoutDoc, PriceTier } from './seatmap-layout.js';

/** 회차 공개 요약에 쓰는 회차 칸 */
export interface EventPublicFields {
  entryOpensAt: Date | null;
  endsAt: Date;
  reentryAllowed: boolean;
  lobbyMinutes: number;
  lobbyShuffle: boolean;
  openBatch: boolean;
  seatAssignment: 'PICK' | 'AUTO';
  perPersonLimit: number;
}

/** 공연 상세 응답에 쓰는 공연 칸 */
export interface ProductionPublicFields {
  ageRating: string | null;
  runningMinutes: number | null;
  description: string | null;
  descriptionDoc: DescriptionDoc | null;
  /** 판매 정책 규칙(production.sale_policy, 마지막 승인 내용, ADR-0261 결정 1·5). 없으면 빈 목록 */
  salePolicy: SalePolicyRule[];
}

/** 회차 공개 요약·공연 상세에 쓰는 한 벌(회차·공연·판매자·공연장·아티스트·같은 공연의 회차) */
export interface EventSummaryRow {
  event: CatalogEvent & EventPublicFields;
  production: Production & ProductionPublicFields;
  sellerName: string;
  seller: SellerRow;
  /** 새 공연장 요청을 아직 잇지 않았으면 null */
  place: { id: string; name: string; address: string } | null;
  /** 보이는 순서 */
  artists: { artistId: string; name: string }[];
  /** 같은 공연의 회차(취소 포함, 시작 순이 아니어도 된다) */
  rounds: RoundRow[];
  /** 공연 이미지(포스터 하나와 상세 이미지, 차례는 정하지 않는다, ADR-0257 결정 3) */
  images: { id: string; kind: 'POSTER' | 'DETAIL'; alt: string; order: number }[];
  /** 회차 배치본의 가격 등급(행 = 마지막 승인 내용, 보이는 순서). 배치본이 없으면 빈 목록(ADR-0260 결정 12) */
  priceTiers: PriceTier[];
}

/**
 * 한 번만 처리할 쓰기 요청의 범위·키·지문(docs/api/guidelines.md §4). 받는 층이 플랫폼 멱등 모듈에서 받아 넘긴다.
 * 도메인은 플랫폼을 모르므로 같은 모양을 여기 적는다
 */
export interface RequestOnce {
  readonly accountRef: string;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: Uint8Array;
}

/** 공연 등록으로 넣을 것(ADR-0198 결정 1·4). 공연장은 placeId와 requestedPlace 가운데 하나다 */
export interface NewProduction {
  id: string;
  promoterId: string;
  title: string;
  genre: Genre;
  ageRating?: string;
  runningMinutes?: number;
  /** 구조 문서에서 만든 글자판 */
  description?: string;
  descriptionDoc?: DescriptionDoc;
  kopisFields?: KopisFields;
  placeId?: string;
  requestedPlace?: { name: string; address: string };
  /** 기존 아티스트(보이는 순서와 함께) */
  artists: { artistId: string; sortOrder: number }[];
  /** 새 아티스트 이름 요청(보이는 순서와 함께) */
  requestedArtists: { name: string; sortOrder: number }[];
  /** 공연의 다른 이름(검색에만 쓴다) */
  aliases: { id: string; alias: string }[];
  events: (EventDraft & { id: string })[];
  createdBy: string;
}

/** 게시한 판 하나의 팬 파일 출처(where: 공개 위치 public·준비 위치 staging) */
export interface LayoutFile {
  version: number;
  where: 'public' | 'staging';
  doc: LayoutDoc;
}

/** 회차 더하기가 잠금 밖에서 먼저 읽는 것(새 회차의 팬 파일을 트랜잭션 밖에서 쓰려고, 리뷰 C2·D7) */
export interface LayoutPreview {
  venueId: string | null;
  approvedBefore: boolean;
  suspended: boolean;
  files: LayoutFile[];
}

/** 회차 더하기에서 읽는 공연 한 줄 */
export interface ProductionForUpdate {
  id: string;
  promoterId: string;
  saleReview: Production['saleReview'];
  saleApprovedAt: Date | null;
  /** 그 공연 회차들의 배치본(아직 없으면 null) */
  venueId: string | null;
  pendingEvents: PendingEvent[];
  /** 지금 고치는 판매 정책 규칙(재승인 대기 변경분이 있으면 그것, 리뷰 A5) */
  rules: SalePolicyRule[];
}

/** 등록·회차 더하기 트랜잭션 안에서 쓰는 일(오픈 간격 판정과 쓰기가 같은 잠금 안에 있다) */
export interface RegistrationTx {
  /** from~to의 공개 중인 다른 공연(excludeProductionId 말고, 한 번 승인되고 판매 중지가 아님) 취소되지 않은 회차 오픈 시각 */
  otherOpenTimes(from: Date, to: Date, excludeProductionId: string): Promise<Date[]>;
  placeExists(placeId: string): Promise<boolean>;
  /** 있는 아티스트 ID만 돌려준다 */
  existingArtists(artistIds: string[]): Promise<string[]>;
  insertProduction(p: NewProduction): Promise<void>;
  /** 그 테넌트의 공연을 줄 잠금으로 읽는다(범위 인자, authz-matrix §5.2). 없거나 다른 테넌트 공연이면 undefined */
  productionForUpdate(productionId: string, tenantId: string): Promise<ProductionForUpdate | undefined>;
  insertEvent(productionId: string, promoterId: string, venueId: string | null, e: EventDraft & { id: string }): Promise<void>;
  /** 게시한 판의 팬 파일 출처(공개 위치의 행 판, 준비 위치의 대기 판). 회차 더하기가 잠금 안에서 미리 쓴 파일과 같은지 다시 본다(ADR-0260 결정 8) */
  layoutFiles(venueId: string, tenantId: string): Promise<LayoutFile[]>;
  /** 변경분의 더한 회차 목록과 판매 승인 상태를 바꾼다 */
  savePending(productionId: string, pendingEvents: PendingEvent[], saleReview: Production['saleReview']): Promise<void>;
  /** 그 공연 판매 자격 명단의 잠금·파기 시각을 지금 event 행과 규칙으로 다시 계산하고 새 사본 판을 매긴다(승인 이력이 없는 공연의 회차 더하기, ADR-0261 결정 7, 리뷰 H1) */
  refreshEligibility(productionId: string, now: Date): Promise<void>;
}

/** 팬별 판매 자격의 회차 칸(ADR-0261 결정 5) */
export interface SaleEligibilityEvent {
  eventId: string;
  productionId: string;
  openAt: Date;
  startsAt: Date;
  perPersonLimit: number;
  saleReview: Production['saleReview'];
  saleApprovedAt: Date | null;
  salePolicy: SalePolicyRule[];
  grades: string[];
}

/** 팬이 든 판매 자격 명단 하나(팬별 자격, ADR-0261 결정 5) */
export interface MemberList {
  key: string;
  name: string;
  destroyDueAt: Date;
}

/** 찾기 목록의 이름 하나(지우지 않은 다른 이름과 함께) */
export interface NameEntry {
  id: string;
  name: string;
  aliases: string[];
}

export interface PlaceNameEntry extends NameEntry {
  address: string;
}

export interface CatalogRepository {
  /** 아티스트 전체와 다른 이름(찾기 목록, ADR-0242) */
  listArtistNames(): Promise<NameEntry[]>;
  /** 고를 수 있는 공연장과 다른 이름(닫은 공연장은 뺀다) */
  listPlaceNames(): Promise<PlaceNameEntry[]>;
  /** 회차와 그 공연·판매자 상호. 없으면 undefined */
  findEventSummary(eventId: string): Promise<EventSummaryRow | undefined>;
  /**
   * 한 번만 하는 등록 쓰기. fn을 한 트랜잭션 안에서 부른다. 트랜잭션에 그 요청의 테넌트(app.tenant_id)를 건다(행 보안 2차 방어는 HOT-172가 켠다, authz-matrix §5.3).
   * fn이 던지면 되돌린다. 같은 요청이 다시 오면 fn을 부르지 않고 처음 결과(JSON 직렬화한 값)를 돌려준다
   */
  registerOnce<T>(once: RequestOnce, tenantId: string, fn: (tx: RegistrationTx) => Promise<T>): Promise<T>;
  /** 그 테넌트 공연의 배치본과 게시한 판(잠금 없이 읽는다). 없거나 남의 공연이면 undefined */
  layoutFilesFor(productionId: string, tenantId: string): Promise<LayoutPreview | undefined>;
  /** 그 계정이 든 그 공연의 판매 자격 명단(파기 시각이 지나지 않은 것, 키 차례). 팬 경로(core_app) */
  memberLists(productionId: string, accountId: string, now: Date): Promise<MemberList[]>;
  /** 팬별 판매 자격에 쓰는 칸만(회차 일정·1인 한도·공연 공개 상태·공개본 규칙·배치본 등급 ID). 쿼리 하나다(리뷰 C3) */
  findSaleEligibilityEvent(eventId: string): Promise<SaleEligibilityEvent | undefined>;
  /** 찜. 공개 공연이 아니면 'not-found', 상한을 넘으면 'limit'. 같은 찜은 처음 시각을 둔다. 계정 단위 잠금 안에서 센다 */
  putWish(accountId: string, productionId: string, now: Date, limit: number): Promise<'ok' | 'not-found' | 'limit'>;
  deleteWish(accountId: string, productionId: string): Promise<void>;
}

export const CATALOG_REPOSITORY = Symbol('CATALOG_REPOSITORY');
