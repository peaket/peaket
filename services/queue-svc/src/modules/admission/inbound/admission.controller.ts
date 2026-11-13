// 받는 층: 입장 확정(openapi POST /v1/queues/{eventId}/admission, docs/features/queue-admission.md §6). 팬 경로라 게이트웨이가 넘긴 신원(계정·세션·pid)과
// 구매 권한(ticket:buy)을 쓴다. 사전 요청이 없도록 text/plain 본문도 받는다(ADR-0065 결정 6). 응답은 캐시하지 않는다(ASVS v5.0.0-14.3.2).
import { Controller, HttpCode, Param, Post, Res } from '@nestjs/common';
import { AcceptTextPlain, ContractBody, CurrentPrincipal, type Principal, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { QueueStoreUnavailable } from '../../entry/index.js';
import { AdmissionError } from '../application/admission-error.js';
import { ConfirmAdmission } from '../application/confirm-admission.js';

// openapi 요청 본문 모양을 여기 같은 모양으로 둔다. 계약처럼 닫는다(정하지 않은 칸은 400, docs/api/guidelines.md §1, BAS-040)
const AdmissionBody = z
  .object({
    queueTicket: z.string().min(1).max(4096).optional(),
    lobbyToken: z.string().min(1).max(4096).optional(),
    priorityGrantId: z.uuid().optional(),
    // 관측용 칸은 모양을 묻지 않는다(맞지 않으면 처리에서 버린다. 브라우저의 작은 결함이 입장을 막지 않게, ADR-0183 결정 10)
    firstEtaSec: z.unknown().optional(),
    firstEtaAtMs: z.unknown().optional(),
  })
  .strict()
  .refine((b) => [b.queueTicket, b.lobbyToken, b.priorityGrantId].filter((v) => v !== undefined).length === 1, { message: '대기표·참가 토큰·우선 구매 권리 ID 가운데 하나만 있어야 한다' });

/** Redis 키의 해시 태그 안에 들어가는 값(회차 ID·pid)의 모양 */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;

const PROBLEM: Record<AdmissionError['code'], { status: number; type: string; title: string }> = {
  NOT_FOUND: { status: 404, type: 'queue-not-found', title: '이 회차의 대기열이 열리지 않았습니다' },
  TICKET_INVALID: { status: 403, type: 'queue-ticket-invalid', title: '대기표를 확인할 수 없습니다' },
  PRIORITY_GRANT_NOT_FOUND: { status: 404, type: 'priority-grant-not-found', title: '쓸 수 있는 우선 구매 권리가 없습니다' },
  IDENTITY_VERIFICATION_REQUIRED: { status: 403, type: 'identity-verification-required', title: '휴대폰 본인확인을 먼저 해 주세요' },
  DUPLICATE_ADMISSION: { status: 409, type: 'duplicate-admission', title: '이미 다른 기기나 탭에서 입장했습니다' },
  SALE_ENDED: { status: 410, type: 'sale-ended', title: '판매 시간이 끝났습니다' },
  SOLD_OUT: { status: 410, type: 'sold-out', title: '매진되었습니다' },
  EXPIRED: { status: 410, type: 'queue-ticket-expired', title: '입장 시간이 지났습니다' },
  REMOVED: { status: 410, type: 'queue-ticket-removed', title: '이 대기표는 더 쓸 수 없습니다' },
  LOBBY_REPAIRING: { status: 503, type: 'batching', title: '순서를 정하는 중입니다. 잠시 뒤 다시 시도해 주세요' },
};

@Controller('v1/queues/:eventId')
export class AdmissionController {
  constructor(private readonly confirmAdmission: ConfirmAdmission) {}

  @Post('admission')
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @AcceptTextPlain()
  @HttpCode(200)
  async admit(@Param('eventId') eventId: string, @ContractBody(AdmissionBody) body: z.output<typeof AdmissionBody>, @CurrentPrincipal() me: Principal, @Res({ passthrough: true }) reply: FastifyReply) {
    void reply.header('cache-control', 'no-store');
    try {
      if (!KEY_PART.test(eventId)) throw new AdmissionError('NOT_FOUND', '회차 ID 모양이 틀렸다');
      if (!me.pid || !KEY_PART.test(me.pid)) throw new AdmissionError('IDENTITY_VERIFICATION_REQUIRED', 'pid가 없다(본인확인 전)');
      // pid 키 전환 기간의 옛 pid(X-User-Pid-Prev)도 같은 모양이어야 한다. pid와 같으면 버린다(queue-admission §3 'pid 키 전환 기간'의 첫 구현)
      if (me.pidPrev !== undefined && !KEY_PART.test(me.pidPrev)) throw new AdmissionError('IDENTITY_VERIFICATION_REQUIRED', '옛 pid 모양이 틀렸다');
      const pidPrev = me.pidPrev && me.pidPrev !== me.pid ? { pidPrev: me.pidPrev } : {};
      return await this.confirmAdmission.run({ accountId: me.accountId, pid: me.pid, ...pidPrev, sessionId: me.sessionId, eventId, body });
    } catch (e) {
      if (e instanceof AdmissionError) {
        // 410 확장 칸: 만료는 rejoinAllowed, 이의 기각으로 끝난 대기 참여는 removeReason BLOCKED(그 밖의 빠진 번호는 칸 없음, ADR-0259 결정 4)
        const extensions = e.code === 'EXPIRED' ? { rejoinAllowed: e.rejoinAllowed ?? false } : e.code === 'REMOVED' && e.removeReason === 'BLOCKED' ? { removeReason: 'BLOCKED' } : null;
        throw new ProblemError({ ...PROBLEM[e.code], ...(extensions ? { extensions } : {}), ...(e.code === 'LOBBY_REPAIRING' ? { retryAfterSeconds: 2 } : {}) });
      }
      // 대기열 Redis 일시 장애는 503과 짧은 Retry-After(1초 [가정])로 답한다(진입과 같다). 화면은 같은 대기표로 다시 보낸다
      if (e instanceof QueueStoreUnavailable) throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 잠시 쓸 수 없습니다', retryAfterSeconds: 1, cause: e });
      throw e;
    }
  }
}
