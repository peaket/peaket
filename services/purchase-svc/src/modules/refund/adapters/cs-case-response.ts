// ops-svc CS 처리함 내부 HTTP(POST /internal/v1/cs-cases)의 답 판정(웨이브 끝 리뷰 S1, guidelines §8.1 'ops-svc CS 처리함 내부 HTTP').
// 2xx이고 본문이 JSON 객체이며 accepted === true일 때만 연 것으로 본다(BAT-420-rest 리뷰 반영 RV-01, docs/features/transfer-refund.md §3.1 ⑥ '실패 기록').
// 2xx라도 accepted: false(받지 않는 종류)·칸 없음·JSON 아님은 연 것이 아니다. 그 밖(401 내부 토큰 없음·틀림, 5xx 등)과 함께 던져 부른 쪽이 다시 연다.

/** CS 건을 열지 못했다(ops-svc 답이 2xx·accepted: true가 아님). 상태 코드만 싣는다(본문·개인정보 없음) */
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
  const text = await res.text().catch(() => undefined);
  if (res.status < 200 || res.status > 299) throw new CsCaseRejected(kind, res.status);
  let body: unknown;
  try {
    body = text === undefined ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (typeof body !== 'object' || body === null || (body as { accepted?: unknown }).accepted !== true) throw new CsCaseRejected(kind, res.status);
}
