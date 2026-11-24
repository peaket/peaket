// 관제 아티스트·공연장 찾기/만들기 저장소(core_ops, LCH-080 잔여).
// 찾기는 이름·다른 이름을 모두 읽어 유스케이스가 거르고, 만들기는 artist·place 행 하나를 넣는다.
// 계좌·연락처는 이 경로에 없다. 감사 로그는 유스케이스가 남긴다.
import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@peaket/platform';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { OpsArtistView, OpsPlaceView } from '../../domain/ops-catalog.js';
import type { OpsCatalogStore } from '../../domain/ops-catalog-ports.js';
import { artist, place, searchAlias } from './schema.js';
import { OPS_DATABASE } from '../../domain/sale-config-ports.js';

@Injectable()
export class DrizzleOpsCatalog implements OpsCatalogStore {
  constructor(@Inject(OPS_DATABASE) private readonly db: Database) {}

  async allArtists(): Promise<OpsArtistView[]> {
    const [rows, aliases] = await Promise.all([
      this.db.db.select({ id: artist.id, name: artist.name }).from(artist).orderBy(asc(artist.name), asc(artist.id)),
      this.db.db
        .select({ targetId: searchAlias.targetId, alias: searchAlias.alias })
        .from(searchAlias)
        .where(and(eq(searchAlias.targetKind, 'ARTIST'), isNull(searchAlias.removedAt)))
        .orderBy(asc(searchAlias.alias)),
    ]);
    const byTarget = new Map<string, string[]>();
    for (const a of aliases) byTarget.set(a.targetId, [...(byTarget.get(a.targetId) ?? []), a.alias]);
    return rows.map((r) => ({ artistId: r.id, name: r.name, aliases: byTarget.get(r.id) ?? [] }));
  }

  async allPlaces(): Promise<OpsPlaceView[]> {
    const [rows, aliases] = await Promise.all([
      this.db.db.select({ id: place.id, name: place.name, address: place.address, region: place.region, status: place.status }).from(place).orderBy(asc(place.name), asc(place.id)),
      this.db.db
        .select({ targetId: searchAlias.targetId, alias: searchAlias.alias })
        .from(searchAlias)
        .where(and(eq(searchAlias.targetKind, 'PLACE'), isNull(searchAlias.removedAt)))
        .orderBy(asc(searchAlias.alias)),
    ]);
    const byTarget = new Map<string, string[]>();
    for (const a of aliases) byTarget.set(a.targetId, [...(byTarget.get(a.targetId) ?? []), a.alias]);
    return rows.map((r) => ({ placeId: r.id, name: r.name, address: r.address, region: r.region, status: r.status as 'ACTIVE' | 'CLOSED', aliases: byTarget.get(r.id) ?? [] }));
  }

  async createArtist(input: { id: string; name: string; actorId: string }): Promise<void> {
    await this.db.db.insert(artist).values({ id: input.id, name: input.name, createdBy: input.actorId });
  }

  async createPlace(input: { id: string; name: string; address: string; region: string; actorId: string }): Promise<void> {
    await this.db.db.insert(place).values({ id: input.id, name: input.name, address: input.address, region: input.region, status: 'ACTIVE', createdBy: input.actorId });
  }

  async existingArtistIds(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.db.select({ id: artist.id }).from(artist).where(inArray(artist.id, [...ids]));
    return rows.map((r) => r.id);
  }

  async placeUsable(placeId: string): Promise<boolean> {
    const [row] = await this.db.db.select({ id: place.id }).from(place).where(and(eq(place.id, placeId), eq(place.status, 'ACTIVE'))).limit(1);
    return row !== undefined;
  }
}
