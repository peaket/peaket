// 시험 공용: identity GetAdminAuthz 대역, 팬·파트너 신원 머리, 등록 본문(BUILD_ORDER HOT-171)
import type { AdminAuthz, AdminAuthzPort } from '@peaket/platform';
import { MemoryCdnInvalidation, MemoryImageObjectStore, MemoryPublicFileStore, type MediaWiring } from '../src/modules/catalog/index.js';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

/** identity GetAdminAuthz 대역: (계정, 세션)마다 답을 정한다. 없으면 끝난 세션(valid false) */
export class FakeIdentity implements AdminAuthzPort {
  readonly answers = new Map<string, AdminAuthz>();
  async getAdminAuthz(q: { adminAccountId: string; sessionId: string }): Promise<AdminAuthz> {
    return this.answers.get(`${q.adminAccountId}/${q.sessionId}`) ?? { valid: false, role: '' };
  }

  /** 파트너 계정 하나를 만들고 그 신원 머리를 돌려준다 */
  partner(tenantId: string, role: 'partner_admin' | 'partner_member' = 'partner_admin'): Record<string, string> {
    const accountId = randomUUID();
    const sessionId = randomUUID();
    this.answers.set(`${accountId}/${sessionId}`, { valid: true, role, tenantId });
    return { 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': 'partner', 'x-user-scope': '' };
  }
}

export const fan = (accountId: string = randomUUID()): Record<string, string> => ({ 'x-user-id': accountId, 'x-session-id': randomUUID(), 'x-user-aud': 'fan', 'x-user-scope': 'openid' });

export const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

/** 기본 시계(2026-11-05 00:00 UTC) 뒤의 정상 회차 하나. 2026-11-20(금) 20:00 KST 오픈 */
export function eventBody(o: Record<string, unknown> = {}): Record<string, unknown> {
  return { openAt: '2026-11-20T11:00:00Z', startsAt: '2026-12-24T10:00:00Z', endsAt: '2026-12-24T12:30:00Z', ...o };
}

export function productionBody(placeId: string, o: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: '겨울 콘서트', genre: '콘서트', placeId, artists: [], aliases: ['WINTER CONCERT'], events: [eventBody()], ...o };
}

export const NOW_MS = Date.parse('2026-11-05T00:00:00.000Z');

export const IMAGE_ORIGIN_TEST = 'https://img.peaket.test';

/** DB 모드 시험의 이미지·좌석맵 잇기 기본값(처리·해석 작업은 잇지 않아 늘 503이다) */
export function testMedia(o: Partial<MediaWiring> = {}): MediaWiring {
  return {
    imageOrigin: IMAGE_ORIGIN_TEST,
    processing: { process: () => Promise.reject(new Error('잇지 않았다')) },
    seatmap: { parse: () => Promise.reject(new Error('잇지 않았다')) },
    store: new MemoryImageObjectStore(),
    cdn: new MemoryCdnInvalidation(),
    publicFiles: new MemoryPublicFileStore(),
    ...o,
  };
}
