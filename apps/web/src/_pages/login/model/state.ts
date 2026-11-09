// SCR-004 로그인 화면이 주소에서 읽는 상태(d5 §5.4 상태 표·§3.5 세션 종료 사유, ADR-0202 결정 4·5).
// - error=failed: 카드 위 '에러' 안내. 로그인 경로가 실패를 돌려보낼 때 붙인다(공급자 동시 상한도 이것이다)
// - error=down&provider=: 그 제공자 버튼만 이유 있는 비활성 + '지금은 … 로그인을 쓸 수 없습니다'(끊긴 공급자·발견 문서 실패)
// - ended=: 세션 종료 사유 안내(팬 사유 일곱만, LOGIN_METHOD_CHANGED는 2026-11-05 BOT-044). 값은 토큰 갱신 401의 ended를 화면이 실어 보낸다(shared/lib/token-refresh, ADR-0235)
// - next=: 로그인 뒤 돌아갈 주소(safeNext). '진행 중'은 폼을 보낼 때 화면 스크립트가 그린다(LoginProviders)
// 퍼블리싱 상태 미리보기(?state=)는 HOT-321에서 걷었다. 순수 함수라 상대 경로로 가져온다(node --test가 바로 돌린다)
import { LOGIN_PROVIDERS, SESSION_END_TEXT, type ProviderId, type SessionEndReason } from '../../../entities/provider/model.ts';
import { safeNext } from '../../../shared/lib/safe-next.ts';

export interface LoginView {
  /** 카드 위 에러 안내(제공자 오류·취소·처음부터 다시) */
  error: boolean;
  /** 장애가 난 제공자(그 버튼만 이유 있는 비활성) */
  down: ProviderId | null;
  /** 세션이 끝나서 왔을 때 사유 */
  sessionEnd: SessionEndReason | null;
  /** 로그인 뒤 돌아갈 주소(같은 출처 경로) */
  next: string;
}

type Query = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const isProvider = (v: string | undefined): v is ProviderId => v !== undefined && (LOGIN_PROVIDERS as readonly string[]).includes(v);
const isReason = (v: string | undefined): v is SessionEndReason => v !== undefined && Object.hasOwn(SESSION_END_TEXT, v);

export function loginView(q: Query): LoginView {
  const error = first(q.error);
  const provider = first(q.provider);
  const ended = first(q.ended);
  const down = error === 'down' && isProvider(provider) ? provider : null;
  return {
    // 장애 제공자를 모르면(없거나 모르는 값) 어느 버튼도 막지 않고 일반 에러로 알린다
    error: error === 'failed' || (error === 'down' && down === null),
    down,
    sessionEnd: isReason(ended) ? ended : null,
    next: safeNext(first(q.next)),
  };
}
