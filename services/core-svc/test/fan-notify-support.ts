// BAT-455 시험 공용: 메모리 카탈로그 시드, 푸시 키·VAPID 키 만들기(N-T17~N-T24).
import { createECDH, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { MemoryCatalogRepository, Production } from '../src/modules/catalog/index.js';

export const b64url = (b: Buffer): string => b.toString('base64url');

export function seedEvent(
  repo: MemoryCatalogRepository,
  o: { openAt?: Date; startsAt?: Date; saleReview?: Production['saleReview']; promoterId?: string } = {},
): { productionId: string; eventId: string } {
  const promoterId = o.promoterId ?? randomUUID();
  const productionId = randomUUID();
  const p: Production = {
    id: productionId,
    promoterId,
    placeId: randomUUID(),
    title: '겨울 콘서트',
    genre: '콘서트',
    saleReview: o.saleReview ?? 'APPROVED',
    saleApprovedAt: new Date('2026-11-01T00:00:00Z'),
  };
  repo.productions.set(productionId, p);
  const eventId = randomUUID();
  repo.events.set(eventId, {
    id: eventId,
    productionId,
    venueId: randomUUID(),
    openAt: o.openAt ?? new Date('2026-12-01T03:00:00Z'),
    startsAt: o.startsAt ?? new Date('2026-12-24T10:00:00Z'),
    status: 'SCHEDULED',
  });
  return { productionId, eventId };
}

/** 브라우저 PushSubscription과 같은 P-256 키 쌍. p256dh는 65바이트 비압축 점이다 */
export function pushKeyPair(): { p256dh: string; auth: string; privateKey: ReturnType<typeof createECDH> } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(randomBytes(16)), privateKey: ecdh };
}

export function vapidKeys(): { privateKey: string; publicKey: string; subject: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const raw = publicKey.export({ format: 'jwk' });
  if (typeof raw.x !== 'string' || typeof raw.y !== 'string') throw new Error('P-256 공개키를 꺼내지 못했다');
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(raw.x, 'base64url'), Buffer.from(raw.y, 'base64url')]);
  return { privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey: b64url(point), subject: 'mailto:notify@peaket.test' };
}

/** 시험용 수신 거부 키(32바이트) */
export const OPTOUT_KEY = b64url(randomBytes(32));
