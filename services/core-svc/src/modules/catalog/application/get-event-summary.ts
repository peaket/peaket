// 유스케이스: 회차 공개 요약(openapi GET /v1/events/{eventId}, EventPublicSummary, BUILD_ORDER HOT-170 ①).
// 판매 승인되고 판매 중지가 아닌 공연의 회차만 답한다. 승인 이력이 없는 회차와 없는 회차는 같은 '없음'이고, 한 번 공개된 뒤 판매 중지된 회차는
// '판매 중지'다(사유는 싣지 않는다, docs/security/authz-matrix.md §3.5, ADR-0200 결정 3).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { lobbyOpensAt, MAX_ARTISTS, MAX_DESCRIPTION_TEXT, publicRounds, queueOrder, sellerInfo, type PublicRound, type QueueOrder, type SellerInfo } from '../domain/event-detail.js';
import type { DescriptionDoc } from '../domain/description.js';
import { IMAGE_ORIGIN } from '../domain/media-ports.js';
import { CATALOG_REPOSITORY, type CatalogRepository } from '../domain/ports.js';
import { DETAIL_MAX, imageBaseUrl } from '../domain/production-image.js';
import { type EventStatus, type Genre, isPublic, saleEndsAt } from '../domain/production.js';

export interface EventPublicSummary {
  eventId: string;
  productionId: string;
  title: string;
  startsAt: string;
  sellerName: string;
  genre: Genre;
  ageRating?: string;
  runningMinutes?: number;
  posterUrl?: string;
  posterAlt?: string;
  descriptionText?: string;
  description?: DescriptionDoc;
  detailImages: { url: string; alt: string }[];
  artists: { artistId: string; name: string }[];
  placeId?: string;
  placeName?: string;
  placeAddress?: string;
  openAt: string;
  lobbyOpensAt: string | null;
  entryOpensAt: string | null;
  endsAt: string;
  saleEndsAt: string;
  status: EventStatus;
  queueOrder: QueueOrder;
  seatAssignment: 'PICK' | 'AUTO';
  perPersonLimit: number;
  reentryAllowed: boolean;
  badges: (QueueOrder | 'AUTO_SEAT')[];
  rounds: PublicRound[];
  /** 등급별 정가(보이는 순서, 마지막 승인 내용, ADR-0200 결정 4·ADR-0260 결정 12). 배치본이 없으면 빈 목록 */
  priceTiers: { tierId: string; name: string; price: number }[];
  seller?: SellerInfo;
}

@Injectable()
export class GetEventSummary {
  constructor(
    @Inject(CATALOG_REPOSITORY) private readonly repo: CatalogRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(IMAGE_ORIGIN) private readonly imageOrigin: string,
  ) {}

  async run(eventId: string): Promise<EventPublicSummary | 'suspended' | undefined> {
    const row = await this.repo.findEventSummary(eventId);
    if (!row) return undefined;
    if (!isPublic(row.production)) return row.production.saleReview === 'SUSPENDED' && row.production.saleApprovedAt !== null ? 'suspended' : undefined;
    const { event: e, production: p, place } = row;
    const order = queueOrder(e.lobbyShuffle, e.openBatch);
    const lobby = lobbyOpensAt(e.openAt, e.lobbyMinutes, e.lobbyShuffle);
    const seller = sellerInfo(row.seller);
    // 포스터와 상세 이미지(순서대로)는 production_image 표에서 채운다. 주소는 파생본 묶음의 기준 주소다(ADR-0257 결정 3)
    const poster = row.images.find((i) => i.kind === 'POSTER');
    const details = row.images
      .filter((i) => i.kind === 'DETAIL')
      .sort((a, b) => a.order - b.order)
      .slice(0, DETAIL_MAX)
      .map((i) => ({ url: imageBaseUrl(this.imageOrigin, i.id), alt: i.alt }));
    return {
      eventId: e.id,
      productionId: p.id,
      title: p.title,
      startsAt: e.startsAt.toISOString(),
      sellerName: row.sellerName,
      genre: p.genre,
      ...(p.ageRating ? { ageRating: p.ageRating } : {}),
      ...(p.runningMinutes ? { runningMinutes: p.runningMinutes } : {}),
      ...(poster ? { posterUrl: imageBaseUrl(this.imageOrigin, poster.id), posterAlt: poster.alt } : {}),
      ...(p.description ? { descriptionText: p.description.slice(0, MAX_DESCRIPTION_TEXT) } : {}),
      ...(p.descriptionDoc ? { description: p.descriptionDoc } : {}),
      detailImages: details,
      artists: row.artists.slice(0, MAX_ARTISTS),
      ...(place ? { placeId: place.id, placeName: place.name, placeAddress: place.address } : {}),
      openAt: e.openAt.toISOString(),
      lobbyOpensAt: lobby ? lobby.toISOString() : null,
      entryOpensAt: e.entryOpensAt ? e.entryOpensAt.toISOString() : null,
      endsAt: e.endsAt.toISOString(),
      saleEndsAt: saleEndsAt(e).toISOString(),
      status: e.status,
      queueOrder: order,
      seatAssignment: e.seatAssignment,
      perPersonLimit: e.perPersonLimit,
      reentryAllowed: e.reentryAllowed,
      badges: [order, ...(e.seatAssignment === 'AUTO' ? (['AUTO_SEAT'] as const) : [])],
      rounds: publicRounds(row.rounds, e.id, new Date(this.clock.now())),
      priceTiers: row.priceTiers.map((t) => ({ tierId: t.tierId, name: t.name, price: t.price })),
      ...(seller ? { seller } : {}),
    };
  }
}
