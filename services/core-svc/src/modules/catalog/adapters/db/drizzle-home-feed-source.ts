// 어댑터: core_app 읽기 전용(DATABASE)으로 search_document와 home_banner·home_theme·home_theme_item을 읽는다(HOT-305).
// search_document는 0023에서 core_app·core_search에 SELECT가 열려 있고, 0051 배너·테마 표는 core_app에만 SELECT가 열려 있다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, gt, inArray, lte, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '@peaket/platform';
import type { HomeBannerRow, HomeThemeRow } from '../../domain/home-feed.js';
import type { HomeFeedSource } from '../../domain/home-ports.js';
import { IMAGE_ORIGIN } from '../../domain/media-ports.js';
import type { SearchDocument } from '../../domain/search.js';
import { homeBanner, homeTheme, homeThemeItem } from './schema.js';
import { documentOfRow, rowsOf, type DocumentRow } from './search-rows.js';

export const HOME_STATEMENT_TIMEOUT_MS = 300;

@Injectable()
export class DrizzleHomeFeedSource implements HomeFeedSource {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Optional() @Inject(IMAGE_ORIGIN) private readonly origin: string = 'https://img.peaket.example',
  ) {}

  async documents(now: Date): Promise<SearchDocument[]> {
    const rows = await this.db.transaction(
      async (tx) => {
        const upcomingRows = rowsOf<DocumentRow>(
          await tx.execute(sql`
            select * from search_document
            where sale_status = 'UPCOMING' and next_open_at > ${now}
            order by next_open_at asc, production_id asc
          `),
        );
        const onSaleRows = rowsOf<DocumentRow>(
          await tx.execute(sql`
            select * from search_document
            where sale_status = 'ON_SALE'
            order by sale_ends_at asc nulls last, production_id asc
          `),
        );
        const otherRows = rowsOf<DocumentRow>(
          await tx.execute(sql`
            select * from search_document
            where sale_status in ('SOLD_OUT', 'ENDED')
               or (sale_status = 'UPCOMING' and (next_open_at is null or next_open_at <= ${now}))
          `),
        );
        return [...upcomingRows, ...onSaleRows, ...otherRows];
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only', statementTimeoutMs: HOME_STATEMENT_TIMEOUT_MS },
    );

    const byId = new Map<string, SearchDocument>();
    for (const row of rows) {
      if (!byId.has(row.production_id)) {
        byId.set(row.production_id, documentOfRow(row, this.origin));
      }
    }
    return [...byId.values()];
  }

  async banners(now: Date): Promise<HomeBannerRow[]> {
    const rows = await this.db.transaction(
      (tx) =>
        tx
          .select()
          .from(homeBanner)
          .where(and(lte(homeBanner.displayFrom, now), gt(homeBanner.displayUntil, now)))
          .orderBy(asc(homeBanner.sortOrder), asc(homeBanner.id)),
      { accessMode: 'read only', statementTimeoutMs: HOME_STATEMENT_TIMEOUT_MS },
    );
    return rows.map((r) => ({
      bannerId: r.id,
      productionId: r.productionId,
      imageUrl: bannerImageUrl(this.origin, r.imageKey),
      alt: r.altText,
      ...(r.title !== null ? { title: r.title } : {}),
      ...(r.subtitle !== null ? { subtitle: r.subtitle } : {}),
      sortOrder: r.sortOrder,
      displayFrom: r.displayFrom,
      displayUntil: r.displayUntil,
    }));
  }

  async themes(now: Date): Promise<HomeThemeRow[]> {
    const { themeRows, itemRows } = await this.db.transaction(
      async (tx) => {
        const themes = await tx
          .select()
          .from(homeTheme)
          .where(and(lte(homeTheme.displayFrom, now), gt(homeTheme.displayUntil, now)))
          .orderBy(asc(homeTheme.sortOrder), asc(homeTheme.id));
        if (themes.length === 0) return { themeRows: themes, itemRows: [] };
        const items = await tx
          .select()
          .from(homeThemeItem)
          .where(inArray(homeThemeItem.themeId, themes.map((t) => t.id)))
          .orderBy(asc(homeThemeItem.themeId), asc(homeThemeItem.sortOrder), asc(homeThemeItem.productionId));
        return { themeRows: themes, itemRows: items };
      },
      { accessMode: 'read only', statementTimeoutMs: HOME_STATEMENT_TIMEOUT_MS },
    );

    const itemsByTheme = new Map<string, string[]>();
    for (const item of itemRows) {
      const list = itemsByTheme.get(item.themeId);
      if (list) list.push(item.productionId);
      else itemsByTheme.set(item.themeId, [item.productionId]);
    }
    return themeRows.map((t) => ({
      themeId: t.id,
      name: t.name,
      productionIds: itemsByTheme.get(t.id) ?? [],
      sortOrder: t.sortOrder,
      displayFrom: t.displayFrom,
      displayUntil: t.displayUntil,
    }));
  }
}

function bannerImageUrl(origin: string, imageKey: string): string {
  if (/^https?:\/\//.test(imageKey)) return imageKey;
  const base = origin.replace(/\/+$/, '');
  const key = imageKey.replace(/^\/+/, '');
  return `${base}/${key}`;
}
