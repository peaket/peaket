// 만료 임대 값으로 쓰는 파드 ID(추천 적용 2026-11-04 L5, docs/data.md §3 s:{event:E}:sweep). main.ts가 부르는 순수 함수다(무작위는 주입).
import { POD_ID_HOST_CHARS } from '../domain/expiry.js';
import { KEY_PART } from '../domain/hold.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/**
 * 파드 ID를 만든다. 결과는 늘 KEY_PART 모양(64자 이하)이다.
 * - HOSTNAME의 앞 POD_ID_HOST_CHARS(57)자가 KEY_PART 모양이면 `{그 57자 이하}-{random(3)의 16진 6자리}`(같은 HOSTNAME의 두 파드도 무작위로 갈린다).
 *   모양은 자른 뒤에 본다(58자째부터의 '.'·글자 수 초과는 잘려 나간다).
 * - HOSTNAME이 없거나 빈 글이거나 자른 결과가 KEY_PART 모양이 아니면 random(16)으로 만든 UUID(판 4 꼴, 소문자 16진)
 * @param env 환경 변수(HOSTNAME만 본다)
 * @param random n바이트 무작위(crypto.randomBytes 꼴)
 */
export function podIdFrom(env: Readonly<Record<string, string | undefined>>, random: (n: number) => Uint8Array): string {
  const host = (env.HOSTNAME ?? '').slice(0, POD_ID_HOST_CHARS);
  if (KEY_PART.test(host)) return `${host}-${hex(random(3)).slice(0, 6)}`;
  const b = Uint8Array.from(random(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
