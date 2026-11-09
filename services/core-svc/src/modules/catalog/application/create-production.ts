// 유스케이스: 공연 등록(openapi POST /v1/partner/productions, ADR-0198 결정 1·2·4, BUILD_ORDER HOT-171).
// 판정 순서: 회차마다 일정·정렬(422) → 공연장·아티스트가 있는지(404) → 회차마다 정비 창·오픈 간격(409) → 쓰기.
// 모든 판정을 한 번만 하는 쓰기 안에서 한다(같은 요청을 다시 보내면 판정 없이 처음 결과를 돌려준다. 그사이 오픈 시각이 지나도 같은 답).
// 대형 공연 30분 경고(warnings)는 공연 규모 칸이 생기는 판매 승인 단계(LCH-080)부터 나온다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, uuidv7 } from '@peaket/platform';
import { CATALOG_REPOSITORY, type CatalogRepository, type NewProduction, type RequestOnce } from '../domain/ports.js';
import { type DescriptionDoc, descriptionText, type KopisFields } from '../domain/description.js';
import type { Genre } from '../domain/production.js';
import type { EventDraft } from '../domain/registration.js';
import { notFound } from './problems.js';
import { assertDraft, assertOpenSlot } from './schedule-checks.js';

export interface ProductionInput {
  title: string;
  genre: Genre;
  ageRating?: string;
  runningMinutes?: number;
  placeId?: string;
  newPlace?: { name: string; address: string };
  /** 칸마다 artistId와 name 가운데 하나(받는 층이 확인했다) */
  artists: ({ artistId: string } | { name: string })[];
  aliases: string[];
  description?: DescriptionDoc;
  kopisFields?: KopisFields;
  events: EventDraft[];
}

export interface OpenWarning {
  eventIndex: number;
  code: 'LARGE_SHOW_NEAR';
  suggestedOpenAt: string;
}

export interface ProductionCreated {
  productionId: string;
  eventIds: string[];
  warnings: OpenWarning[];
}

@Injectable()
export class CreateProduction {
  constructor(
    @Inject(CATALOG_REPOSITORY) private readonly repo: CatalogRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(c: { tenantId: string; accountId: string; input: ProductionInput; once: RequestOnce }): Promise<ProductionCreated> {
    return this.repo.registerOnce(c.once, c.tenantId, async (tx) => {
      const now = new Date(this.clock.now());
      c.input.events.forEach((e, i) => assertDraft(e, i, now));
      if (c.input.placeId !== undefined && !(await tx.placeExists(c.input.placeId))) throw notFound();
      const wanted = c.input.artists.flatMap((a) => ('artistId' in a ? [a.artistId] : []));
      if (wanted.length > 0 && (await tx.existingArtists(wanted)).length !== new Set(wanted).size) throw notFound();
      const productionId = uuidv7(this.clock);
      // 내용 없는 문서는 설명이 없는 것이다(ADR-0244)
      const text = c.input.description ? descriptionText(c.input.description).trim() : '';
      for (const [i, e] of c.input.events.entries()) await assertOpenSlot(tx, e, i, productionId);
      const events = c.input.events.map((e) => ({ ...e, id: uuidv7(this.clock) }));
      const p: NewProduction = {
        id: productionId,
        promoterId: c.tenantId,
        title: c.input.title,
        genre: c.input.genre,
        ...(c.input.ageRating !== undefined ? { ageRating: c.input.ageRating } : {}),
        ...(c.input.runningMinutes !== undefined ? { runningMinutes: c.input.runningMinutes } : {}),
        ...(text ? { description: text, descriptionDoc: c.input.description as DescriptionDoc } : {}),
        ...(c.input.kopisFields ? { kopisFields: c.input.kopisFields } : {}),
        ...(c.input.placeId !== undefined ? { placeId: c.input.placeId } : {}),
        ...(c.input.newPlace ? { requestedPlace: c.input.newPlace } : {}),
        artists: c.input.artists.flatMap((a, i) => ('artistId' in a ? [{ artistId: a.artistId, sortOrder: i }] : [])),
        requestedArtists: c.input.artists.flatMap((a, i) => ('name' in a ? [{ name: a.name, sortOrder: i }] : [])),
        aliases: c.input.aliases.map((alias) => ({ id: uuidv7(this.clock), alias })),
        events,
        createdBy: c.accountId,
      };
      await tx.insertProduction(p);
      return { productionId, eventIds: events.map((e) => e.id), warnings: [] };
    });
  }
}
