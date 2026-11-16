// 요청의 클라이언트 IP(접속지 정보, W7-audit 리뷰 R2, docs/features/settlement.md §9 '접속지').
// identity-svc admin-login.controller의 clientIpOf와 같은 규칙: 입구가 하나로 다시 쓴 x-forwarded-for(배열이면 첫 값)를 다듬어 IP 모양이면 그것,
// 아니면 연결 상대 주소(socket.remoteAddress), 둘 다 없으면 ''(docs/infra.md §3 입구 규칙 2).
// 값은 접속기록에만 쓰고 응답·이력에는 싣지 않는다. 로그에서는 플랫폼 가림 키 clientIp로 가린다.
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

export function clientIpOf(req: Pick<FastifyRequest, 'headers' | 'socket'>): string {
  const h = req.headers['x-forwarded-for'];
  const v = (Array.isArray(h) ? h[0] : h)?.trim();
  if (v && isIP(v)) return v;
  return req.socket?.remoteAddress ?? '';
}
