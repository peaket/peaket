// 유스케이스: 관제 아티스트·공연장 찾기와 만들기(LCH-080 잔여, openapi listOpsArtists·createOpsArtist·listOpsPlaces·createOpsPlace).
// 찾기는 이름·다른 이름·초성, 만들기는 정규화 이름이 같은 대상이 있으면 409와 기존 ID를 준다(같은 대상이 둘로 갈라지지 않게).
// 만든 사람·사유는 감사 로그 한 줄로 남긴다(계좌·연락처 같은 개인정보는 없다).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PLATFORM_LOGGER, ProblemError, type PlatformLogger } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import {
  artistExists,
  decodeOpsCursor,
  invalidBody,
  invalidQuery,
  OPS_LIST_DEFAULT,
  OPS_LIST_MAX,
  OPS_NAME_MAX,
  OPS_QUERY_MAX,
  OPS_QUERY_MIN,
  OPS_REASON_MAX,
  OpsCatalogProblem,
  pageOf,
  placeExists,
  sameName,
  samePlace,
  type OpsArtistView,
  type OpsPlaceView,
} from '../domain/ops-catalog.js';
import { OPS_CATALOG_STORE, type OpsCatalogStore } from '../domain/ops-catalog-ports.js';

export interface OpsListInput {
  q: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface OpsPage<T> {
  items: T[];
  nextCursor: string | null;
}

const listLimits = (q: OpsListInput): { limit: number; cursor: ReturnType<typeof decodeOpsCursor> } => {
  const text = q.q.trim();
  if (text.length < OPS_QUERY_MIN || text.length > OPS_QUERY_MAX) throw invalidQuery(`q는 ${OPS_QUERY_MIN}~${OPS_QUERY_MAX}자여야 합니다`);
  const limit = q.limit ?? OPS_LIST_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > OPS_LIST_MAX) throw invalidQuery(`limit은 1~${OPS_LIST_MAX} 사이 정수여야 합니다`);
  const cursor = q.cursor === undefined ? undefined : decodeOpsCursor(q.cursor);
  if (q.cursor !== undefined && cursor === undefined) throw invalidQuery('커서가 올바르지 않습니다');
  return { limit, cursor };
};

const textOf = (value: string, max: number): string => {
  const v = value.trim();
  if (v.length < 1 || v.length > max) throw invalidBody(`값은 1~${max}자여야 합니다`);
  return v;
};

@Injectable()
export class OpsCatalog {
  constructor(
    @Inject(OPS_CATALOG_STORE) private readonly store: OpsCatalogStore,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info'>,
  ) {}

  async listArtists(q: OpsListInput): Promise<OpsPage<OpsArtistView>> {
    return this.mapped(async () => {
      const { limit, cursor } = listLimits(q);
      const rows = await this.store.allArtists();
      const page = pageOf(rows.map((a) => ({ ...a, id: a.artistId })), q.q.trim(), limit, cursor);
      return { items: page.rows.map(({ id: _id, ...a }) => a), nextCursor: page.nextCursor };
    });
  }

  async listPlaces(q: OpsListInput): Promise<OpsPage<OpsPlaceView>> {
    return this.mapped(async () => {
      const { limit, cursor } = listLimits(q);
      const rows = await this.store.allPlaces();
      const page = pageOf(rows.map((p) => ({ ...p, id: p.placeId })), q.q.trim(), limit, cursor);
      return { items: page.rows.map(({ id: _id, ...p }) => p), nextCursor: page.nextCursor };
    });
  }

  async createArtist(input: { name: string; reason: string; actorId: string }): Promise<{ artistId: string }> {
    return this.mapped(async () => {
      const name = textOf(input.name, OPS_NAME_MAX);
      const reason = textOf(input.reason, OPS_REASON_MAX);
      const duplicate = (await this.store.allArtists()).find((a) => sameName(a.name, name));
      if (duplicate) throw artistExists(duplicate.artistId);
      const artistId = randomUUID();
      await this.store.createArtist({ id: artistId, name, actorId: input.actorId });
      this.logger?.info({ event: 'ops_artist_created', artistId, actorId: input.actorId, reason }, '운영자가 아티스트를 만들었다');
      return { artistId };
    });
  }

  async createPlace(input: { name: string; address: string; region: string; reason: string; actorId: string }): Promise<{ placeId: string }> {
    return this.mapped(async () => {
      const name = textOf(input.name, OPS_NAME_MAX);
      const address = textOf(input.address, 200);
      const region = textOf(input.region, OPS_NAME_MAX);
      const reason = textOf(input.reason, OPS_REASON_MAX);
      const duplicate = (await this.store.allPlaces()).find((p) => samePlace(p, { name, address }));
      if (duplicate) throw placeExists(duplicate.placeId);
      const placeId = randomUUID();
      await this.store.createPlace({ id: placeId, name, address, region, actorId: input.actorId });
      this.logger?.info({ event: 'ops_place_created', placeId, actorId: input.actorId, reason }, '운영자가 공연장을 만들었다');
      return { placeId };
    });
  }

  /** 도메인 오류를 openapi problem type으로 바꾼다(유스케이스 층의 다른 파일과 같은 꼴) */
  private async mapped<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof OpsCatalogProblem) {
        throw new ProblemError({ type: err.type, status: err.status, title: err.title, ...(err.detail !== undefined ? { detail: err.detail } : {}), extensions: err.extensions });
      }
      throw err;
    }
  }

  /** 승인 연결 검사: 아티스트 ID 존재·공연장 사용 가능. 없으면 undefined */
  async linkageSupport(artistIds: readonly string[], placeId: string | undefined): Promise<{ existingArtists: Set<string>; placeUsable: boolean }> {
    const [existing, placeUsable] = await Promise.all([
      this.store.existingArtistIds(artistIds),
      placeId === undefined ? Promise.resolve(true) : this.store.placeUsable(placeId),
    ]);
    return { existingArtists: new Set(existing), placeUsable };
  }
}
