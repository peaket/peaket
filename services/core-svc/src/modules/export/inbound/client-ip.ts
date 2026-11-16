// 요청의 클라이언트 IP(접속지 정보, W7-audit 리뷰 R2, docs/features/settlement.md §9 '접속지').
// identity-svc admin-login.controller의 clientIpOf와 같은 규칙: 입구가 하나로 다시 쓴 x-forwarded-for(배열이면 첫 값)를 다듬어 IP 모양이면 그것,
// 아니면 연결 상대 주소(socket.remoteAddress), 둘 다 없으면 ''(docs/infra.md §3 입구 규칙 2).
// 뼈대(W7-audit 리뷰 반영 시험 단계): 동작은 구현 담당이 채운다.
import type { FastifyRequest } from 'fastify';

export function clientIpOf(_req: Pick<FastifyRequest, 'headers' | 'socket'>): string {
  throw new Error('아직 없음');
}
