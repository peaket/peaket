// F-07-12 파트너 홈·공연 목록 읽기 유스케이스(SCR-062·063, HOT-260).
// 정본: openapi partner 네 GET, docs/design/d5 §6.2·§6.3, docs/api/guidelines.md §3.
// 저장소가 준 행을 계약 칸으로 줄이고, 목록의 정렬·필터·커서와 진행 단계를 여기서 닫는다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, RequestValidationError } from '@peaket/platform';
import { IMAGE_ORIGIN } from '../domain/media-ports.js';
import {
  afterPartnerCursor,
  comparePartnerRows,
  decodePartnerCursor,
  encodePartnerCursor,
  matchesPartnerQuery,
  type PartnerProductionQuery,
  type PartnerProductionSummary,
  type PartnerProductionSummaryRow,
  progressStageOf,
  summarySaleStatus,
} from '../domain/partner-home.js';
import { CATALOG_REPOSITORY, type CatalogRepository } from '../domain/ports.js';
import { derivativeUrls, imageBaseUrl } from '../domain/production-image.js';
import type { EventSaleState, SaleReview } from '../domain/production.js';

export interface PartnerProductionPage {
  items: PartnerProductionSummary[];
  nextCursor: string | null;
}

export interface PartnerEventView {
  eventId: string;
  version: number;
  pending: boolean;
  openAt: string;
  lobbyMinutes: number;
  entryOpensAt: string | null;
  startsAt: string;
  endsAt: string;
  reentryAllowed: boolean;
  lobbyShuffle: boolean;
  openBatch: boolean;
  seatAssignment: 'PICK' | 'AUTO';
  perPersonLimit: number;
  status: string;
  saleStatus: EventSaleState | null;
  soldPercent: number | null;
  entryClosedAt: string | null;
}

export interface PartnerImage {
  imageId: string;
  kind: 'POSTER' | 'DETAIL';
  alt: string;
  order: number;
  width: number;
  height: number;
  version: number;
  url: string;
  derivatives: Record<string, string>;
}

export interface PartnerProductionDetail {
  productionId: string;
  version: number;
  title: string;
  genre: string;
  ageRating: string | null;
  runningMinutes: number | null;
  place: { placeId: string; name: string } | null;
  requestedPlace: { name: string; address: string } | null;
  artists: { artistId: string; name: string }[];
  aliases: string[];
  saleReview: SaleReview;
  hasApprovalHistory: boolean;
  saleApprovedAt: string | null;
  rejectionReason: string | null;
  suspensionReasonCode: string | null;
  hasPendingRevision: boolean;
  pendingRevisionFields: string[];
  progressStage: string;
  images: PartnerImage[];
  events: PartnerEventView[];
}

export interface PartnerTodoSummary {
  asOf: string;
  rejectedSaleReviewCount: number | null;
  settlementDisputeDueCount: number | null;
  settlementDisputeEarliestDueAt: string | null;
  openGateFlagCount: number | null;
  pendingStaffInvitationCount: number | null;
}

export interface PartnerSellerProfile {
  seller: {
    legalName: string;
    representative: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    businessRegNo: string | null;
    mailOrderReportNo: string | null;
    /** 정본 SellerInfo.exemptionBasis는 optional string(nullable 아님). 없으면 칸을 뺀다(RV-03). */
    exemptionBasis?: string;
  };
  verifiedAt: string | null;
  pendingChange: null;
}

@Injectable()
export class PartnerHomeRead {
  constructor(
    @Inject(CATALOG_REPOSITORY) private readonly repo: CatalogRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IMAGE_ORIGIN) private readonly imageOrigin: string,
  ) {}

  async list(tenantId: string, q: PartnerProductionQuery): Promise<PartnerProductionPage> {
    if (q.from !== undefined && q.to !== undefined && q.from > q.to) throw new RequestValidationError('from이 to보다 늦다');
    const rows = (await this.repo.partnerProductions(tenantId)).filter((r) => matchesPartnerQuery(r, q)).sort(comparePartnerRows);
    let start = 0;
    if (q.cursor !== undefined) {
      const cursor = decodePartnerCursor(q.cursor);
      if (!cursor) throw new RequestValidationError('모양이 틀린 커서');
      const first = rows.findIndex((r) => afterPartnerCursor(r, cursor));
      start = first < 0 ? rows.length : first;
    }
    const page = rows.slice(start, start + q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.#summary(r)),
      nextCursor: rows.length > start + page.length && last ? encodePartnerCursor(last) : null,
    };
  }

  async todo(tenantId: string): Promise<PartnerTodoSummary> {
    const t = await this.repo.partnerTodo(tenantId);
    return {
      asOf: new Date(this.clock.now()).toISOString(),
      rejectedSaleReviewCount: t.rejectedSaleReviewCount,
      settlementDisputeDueCount: t.settlementDisputeDueCount,
      settlementDisputeEarliestDueAt: t.settlementDisputeEarliestDueAt?.toISOString() ?? null,
      openGateFlagCount: t.openGateFlagCount,
      pendingStaffInvitationCount: t.pendingStaffInvitationCount,
    };
  }

  async detail(productionId: string, tenantId: string): Promise<PartnerProductionDetail | undefined> {
    const s = await this.repo.partnerProduction(productionId, tenantId);
    if (!s) return undefined;
    const p = s.production;
    const requestedPlace = (() => {
      const r = p.requestedPlace as { name?: unknown; address?: unknown } | null | undefined;
      return r && typeof r.name === 'string' && typeof r.address === 'string' ? { name: r.name, address: r.address } : null;
    })();
    return {
      productionId: p.id,
      version: p.version ?? 1,
      title: p.title,
      genre: p.genre,
      ageRating: s.production.ageRating ?? null,
      runningMinutes: s.production.runningMinutes ?? null,
      place: s.place ? { placeId: s.place.id, name: s.place.name } : null,
      requestedPlace,
      artists: s.artists,
      aliases: s.aliases,
      saleReview: p.saleReview,
      hasApprovalHistory: p.saleApprovedAt !== null,
      saleApprovedAt: p.saleApprovedAt?.toISOString() ?? null,
      rejectionReason: p.rejectionReason ?? null,
      suspensionReasonCode: p.suspensionReasonCode ?? null,
      hasPendingRevision: s.hasPendingRevision,
      pendingRevisionFields: s.pendingRevisionFields,
      progressStage: progressStageOf({ saleReview: p.saleReview, saleApprovedAt: p.saleApprovedAt, events: s.events }, new Date(this.clock.now())),
      images: s.images.map((i) => ({
        imageId: i.id,
        kind: i.kind,
        alt: i.alt,
        order: i.order,
        width: i.width,
        height: i.height,
        version: i.version,
        url: imageBaseUrl(this.imageOrigin, i.id),
        derivatives: derivativeUrls(this.imageOrigin, i.id),
      })),
      events: s.events.map((e) => ({
        eventId: e.eventId,
        version: e.version,
        pending: e.pending,
        openAt: e.openAt.toISOString(),
        lobbyMinutes: e.lobbyMinutes,
        entryOpensAt: e.entryOpensAt?.toISOString() ?? null,
        startsAt: e.startsAt.toISOString(),
        endsAt: e.endsAt.toISOString(),
        reentryAllowed: e.reentryAllowed,
        lobbyShuffle: e.lobbyShuffle,
        openBatch: e.openBatch,
        seatAssignment: e.seatAssignment,
        perPersonLimit: e.perPersonLimit,
        status: e.status,
        saleStatus: e.saleStatus,
        soldPercent: e.soldPercent,
        entryClosedAt: e.entryClosedAt?.toISOString() ?? null,
      })),
    };
  }

  async seller(tenantId: string): Promise<PartnerSellerProfile | undefined> {
    const s = await this.repo.partnerSeller(tenantId);
    if (!s) return undefined;
    // null·빈 문자열은 '면제 근거 미기재'로 보고 칸을 뺀다. ''를 실으면 '면제 근거 없음'과 섞인다(RV-03).
    const exemptionBasis = s.seller.exemptionBasis?.trim();
    return {
      seller: {
        legalName: s.seller.legalName,
        representative: s.seller.representative,
        address: s.seller.address,
        phone: s.seller.phone,
        email: s.seller.email,
        businessRegNo: s.seller.businessRegNo,
        mailOrderReportNo: s.seller.mailOrderReportNo,
        ...(exemptionBasis ? { exemptionBasis } : {}),
      },
      verifiedAt: s.verifiedAt?.toISOString() ?? null,
      pendingChange: null,
    };
  }

  #summary(r: PartnerProductionSummaryRow): PartnerProductionSummary {
    const saleStatus = summarySaleStatus(
      { saleReview: r.saleReview, saleApprovedAt: r.hasApprovalHistory ? new Date(0) : null },
      r.saleStates,
    );
    return {
      productionId: r.productionId,
      title: r.title,
      eventCount: r.eventCount,
      saleReview: r.saleReview,
      hasApprovalHistory: r.hasApprovalHistory,
      rejectionReason: r.rejectionReason,
      suspensionReasonCode: r.suspensionReasonCode,
      ...(r.firstOpenAt !== null ? { firstOpenAt: r.firstOpenAt.toISOString() } : {}),
      saleStatus,
      pgPrimary: null,
      payoutHoldReason: null,
    };
  }
}
