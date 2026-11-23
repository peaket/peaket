// 명령 요청의 문제 응답 → 우리 글(F-03-4). 서버 title·detail 원문은 보이지 않는다(docs/frontend.md §4.1 '오류 모양').
// 예외: 422 command-out-of-range는 걸린 안전 한계 이름(detail, 영문 식별자)만 덧붙인다(openapi createOpsCommand 설명).
// 공통 403·500 글은 d5 §9.2, 재인증 글은 d5 §9.2 403 reauth-required.

export interface CommandProblem {
  status: number;
  type: string;
  title?: string;
  detail?: string;
}

/** 한계 이름으로 볼 수 있는 detail(영문 식별자)만 화면에 싣는다 */
const LIMIT_NAME = /^[A-Za-z][A-Za-z0-9:._-]{0,63}$/;

export function commandProblemMessage(p: CommandProblem): string {
  const { status, type } = p;
  if (status === 0) return '연결이 끊겨 보내지 못했습니다. 연결을 확인하고 다시 시도해 주세요';
  if (status === 403 && type === 'reauth-required') return '다시 로그인한 확인이 만료되었거나 이미 쓰였습니다. 다시 인증해 주세요';
  if (status === 503 && type === 'reauth-unavailable') return '지금은 다시 로그인한 확인을 하지 못했습니다. 잠시 뒤 다시 시도해 주세요';
  if (status === 403 && type === 'command-requester-cannot-approve') return '요청자 본인은 승인할 수 없습니다';
  if (status === 403) return '이 작업을 할 권한이 없습니다. 역할과 명령 종류를 확인해 주세요';
  if (status === 401) return '로그인이 만료되었습니다. 다시 로그인해 주세요';
  if (status === 404) return '명령을 찾을 수 없습니다. 목록을 새로 고쳐 주세요';
  if (status === 422 && type === 'command-out-of-range') {
    const limit = p.detail && LIMIT_NAME.test(p.detail) ? `(${p.detail})` : '';
    return `이 값은 안전 한계 밖입니다${limit}`;
  }
  if (status === 422 || status === 400) return '명령 값이 맞지 않습니다. 칸을 다시 확인해 주세요';
  if (status === 409 && type === 'command-not-pending') return '이미 처리되었거나 승인 기한이 지났습니다. 명령 상태를 다시 확인해 주세요';
  if (status === 409 && type === 'command-not-failed') return '실패한 명령이 아니어서 다시 시도할 수 없습니다';
  if (status === 409 && type === 'event-cancelled') return '취소된 회차에는 명령을 낼 수 없습니다';
  if (status === 409) return '명령 상태가 바뀌었습니다. 다시 확인해 주세요';
  if (status === 502 && type === 'command-dispatch-failed') return '받는 서버에 전하지 못했습니다. 잠시 뒤 다시 시도해 주세요';
  if (status === 503) return '지금은 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요';
  return '일시적인 오류입니다. 잠시 후 다시 시도해 주세요';
}
