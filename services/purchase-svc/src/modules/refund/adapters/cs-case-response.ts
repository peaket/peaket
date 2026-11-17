// ops-svc CS 처리함 내부 HTTP(POST /internal/v1/cs-cases)의 답 판정(웨이브 끝 리뷰 S1, guidelines §8.1 'ops-svc CS 처리함 내부 HTTP').
// 2xx만 연 것으로 본다. 그 밖(401 내부 토큰 없음·틀림, 5xx 등)은 던져 부른 쪽이 다시 연다. 본문은 읽어 버린다(연결을 붙잡지 않게).

/** CS 건을 열지 못했다(ops-svc 답이 2xx가 아님). 상태 코드만 싣는다(본문·개인정보 없음) */
export class CsCaseRejected extends Error {
  constructor(
    readonly kind: string,
    readonly status: number,
  ) {
    super(`ops-svc CS 처리함이 ${kind} 건을 받지 않았다(status ${status})`);
    this.name = 'CsCaseRejected';
  }
}

export async function requireAccepted(res: Response, kind: string): Promise<void> {
  await res.text().catch(() => undefined);
  if (res.status < 200 || res.status > 299) throw new CsCaseRejected(kind, res.status);
}
