// 관제 아티스트·공연장 저장소 포트(LCH-080 잔여). core_ops가 읽고 만든다.
// 승인 연결 검사도 이 포트로 아티스트 존재·공연장 사용 가능을 본다(판매 승인 I-03).
import type { OpsArtistView, OpsPlaceView } from './ops-catalog.js';

export interface OpsCatalogStore {
  /** 모든 아티스트(이름·다른 이름). 찾기·중복 검사는 유스케이스가 한다 */
  allArtists(): Promise<OpsArtistView[]>;
  /** 모든 공연장(닫힌 곳 포함, 상태를 실어 보낸다) */
  allPlaces(): Promise<OpsPlaceView[]>;
  createArtist(input: { id: string; name: string; actorId: string }): Promise<void>;
  createPlace(input: { id: string; name: string; address: string; region: string; actorId: string }): Promise<void>;
  /** 존재하는 아티스트 ID만 돌려준다(요청 순서는 유스케이스가 지킨다) */
  existingArtistIds(ids: readonly string[]): Promise<string[]>;
  /** 지금 승인에 쓸 수 있는 공연장인지(있고 ACTIVE) */
  placeUsable(placeId: string): Promise<boolean>;
}

export const OPS_CATALOG_STORE = Symbol('OPS_CATALOG_STORE');
