// SCR-020 파트너 로그인(/login). 셸 없이 가운데 카드(d5 §6.1, 보드 SCR-020-m·t·d).
// 로그인 카드(1·2단계·실패·잠김·세션 종료 안내)와 '비밀번호를 바꿔 주세요' 카드를 ?state=로 고른다.
import { routes } from '@/shared/config/routes';
import { LOGIN_STATES } from '@/shared/config/states/scr020-auth';
import { readPreview, type RouteProps } from '@/shared/lib/preview';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { AuthFrame } from './AuthFrame';
import { LoginCard, type LoginCardState } from './LoginCard';
import { MustChangeCard, type MustChangeState } from './MustChangeCard';

type LoginState = (typeof LOGIN_STATES)[number];

const MUST_CHANGE: readonly LoginState[] = [
  '비밀번호를 바꿔야 하는 세션',
  '비밀번호 바꾸기 · 지금 비밀번호 틀림',
  '비밀번호 거절 · 유출',
  '비밀번호 거절 · 금칙어',
  '비밀번호 거절 · 흔한 비밀번호',
  '비밀번호 거절 · 길이',
  '비밀번호 확인 불가',
];

export default async function LoginPage({ searchParams }: RouteProps) {
  const pv = readPreview(await searchParams, LOGIN_STATES, '로그인 1단계');
  const must = MUST_CHANGE.includes(pv.state);
  return (
    <AuthFrame
      dark={pv.theme === 'dark'}
      titleId={must ? 'mc-title' : 'lg-title'}
      after={<PreviewStateSwitcher path={routes.login()} states={LOGIN_STATES} current={pv.state} keep={pv.keep} />}
    >
      {must ? <MustChangeCard state={pv.state as MustChangeState} /> : <LoginCard state={pv.state as LoginCardState} keep={pv.keep} />}
    </AuthFrame>
  );
}
