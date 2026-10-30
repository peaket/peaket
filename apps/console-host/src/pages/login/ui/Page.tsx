// SCR-028 운영자 로그인·계정(d5 §7.1). 보드 하나(SCR-028-d·t·m)에 로그인(셸 없음)과 내 계정(관제 셸)이 함께 있어 경로 둘로 나눴다.
// - /login: 비밀번호 → 인증 앱 코드(TOTP) 두 단계, 잠금·초대 수락·잠금 해제·비밀번호 바꾸기·세션 종료 카드. 셸 없이 가운데 카드.
// - /me: 계정·보안 설정(재인증)·로그인한 기기·화면 설정(한 글자 단축키 스위치, 화면 테마 자동·다크·라이트).
// 퍼블리싱 동작: 로그인 1단계 [다음] → TOTP 단계, TOTP [로그인] → /dashboard. 서버·인증은 붙이지 않는다.
import type { FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useBoardPage } from '@/shared/lib/board';
import { useLayout } from '@/shared/lib/layout';
import { useBodyTheme, useResolvedTheme, useUiPrefs } from '@/shared/lib/theme';
import { usePreviewHost } from '@/features/preview-host';
import { useMainStyle } from '@/shared/model/shell';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { LOGIN_DEFAULT, LOGIN_STATES, ME_DEFAULT, ME_STATES } from '../states';
import { AuthD, MeD, ME_MAIN_STYLE_D, valsD } from './board-d';
import { AuthM, MeM, ME_MAIN_STYLE_M, valsM } from './board-m';
import { AuthT, MeT, ME_MAIN_STYLE_T, valsT } from './board-t';

export function LoginPage() {
  const { state, layout, close, go } = useBoardPage('운영자 로그인', LOGIN_STATES, LOGIN_DEFAULT);
  const [params] = useSearchParams();
  const theme = useResolvedTheme(useLayout(), params.get('theme'));
  useBodyTheme(theme);
  const navigate = useNavigate();
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (state === '로그인') go('TOTP 단계');
    else if (state === 'TOTP 단계') navigate('/dashboard');
  };
  return (
    // 보드 루트: <div class="pk dark cs" style="display:block"> > <div class="col" style="min-height:…">
    <div className="cs" style={{ display: 'block', minHeight: '100vh' }} onSubmit={onSubmit}>
      <div className="col" style={{ minHeight: '100vh', background: layout === 'phone' ? 'var(--surface)' : undefined }}>
        <SkipToLogin />
        {layout === 'desktop' ? <AuthD v={valsD(state)} close={close} /> : null}
        {layout === 'tablet' ? <AuthT v={valsT(state)} close={close} /> : null}
        {layout === 'phone' ? <AuthM v={valsM(state)} close={close} /> : null}
      </div>
      <PreviewSwitcher states={LOGIN_STATES} current={state} />
    </div>
  );
}

export function MePage() {
  const { state, layout, close } = useBoardPage('내 계정', ME_STATES, ME_DEFAULT);
  const prefs = useUiPrefs();
  usePreviewHost({ scope: { stage: 'T=0' }, control: { kind: 'paused', remaining: '13:12' }, clock: '20:04:12 KST' }, [state]);
  useMainStyle(layout === 'desktop' ? ME_MAIN_STYLE_D : layout === 'tablet' ? ME_MAIN_STYLE_T : ME_MAIN_STYLE_M, `me-${layout}`);
  return (
    <>
      {layout === 'desktop' ? <MeD v={valsD(state)} close={close} prefs={prefs} /> : null}
      {layout === 'tablet' ? <MeT v={valsT(state)} close={close} prefs={prefs} /> : null}
      {layout === 'phone' ? <MeM v={valsM(state)} close={close} prefs={prefs} /> : null}
      <PreviewSwitcher states={ME_STATES} current={state} />
    </>
  );
}

/** 보드의 sr-only '본문 바로가기'를 초점을 받으면 보이게 한다 */
function SkipToLogin() {
  return (
    <a
      className="sr-only"
      href="#main-login"
      onFocus={(e) => e.currentTarget.classList.replace('sr-only', 'btn')}
      onBlur={(e) => e.currentTarget.classList.replace('btn', 'sr-only')}
      style={{ position: 'absolute', left: 8, top: 8, zIndex: 200 }}
    >
      본문 바로가기
    </a>
  );
}
