// SCR-005 가입 완료·동의(d5 §5.5, d3 SCR-005 행, 캔버스 보드 SCR-005-m·t·d를 한 페이지 반응형으로 합쳤다).
// 한 열 폼(최대 560): ① 만 14세 확인 → ② 필수 동의 → ③ 선택 동의(휴대폰 번호) → ④ 닉네임 → ⑤ 본인확인 권유 → [가입 완료].
// 휴대폰·태블릿은 [가입 완료]가 화면 아래 고정 띠(.bottom-bar), 데스크톱(lg)은 폼 맨 끝. 셸은 로그인 전 모양(머리만인 보드와 달리 셸이 바닥글을 그린다).
// 상태는 ?state=(보드 state 값), 다크는 ?theme=dark.
import Link from 'next/link';
import { ConsentCheckbox } from '@peaket/ds/ConsentCheckbox';
import { FormErrorSummary } from '@peaket/ds/FormErrorSummary';
import { PermissionDenied } from '@peaket/ds/PermissionDenied';
import { previewHref, resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { TextField } from '@peaket/ds/TextField';
import { VerifyIdentityButton } from '@/features/identity-verify';
import { SCR005_STATES } from '@/shared/config/screens.account';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { signupView, type NickStatus } from '../model/state';
import { PhoneOptIn } from './PhoneOptIn';

const AGE_ERROR = '만 14세 이상인지 확인해 주세요';
const NICK_ERROR = '이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해 주세요';

function Chevron() {
  return <i className="ic ic-chevron-right" aria-hidden="true" />;
}

export async function SignupConsentPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR005_STATES, '기본');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = signupView(state);
  const keep = { theme: dark ? 'dark' : undefined };

  return (
    <AppShell
      dark={dark}
      guest
      bottomBar={
        v.form ? (
          <div className="bottom-bar sticky bottom-0 z-10 md:px-6 md:pt-3 md:pb-5 lg:hidden">
            <button className="btn btn-primary btn-lg btn-block md:mx-auto md:max-w-[560px]" type="button">
              가입 완료
            </button>
          </div>
        ) : null
      }
    >
      <main className="page-main" id="main" tabIndex={-1}>
        {v.form ? (
          <div className="px-4 pt-7 pb-10 md:px-6 md:pt-10 md:pb-12 lg:px-8 lg:pt-14 lg:pb-[72px]">
            <form className="col mx-auto w-full max-w-[560px] gap-7 md:gap-8" aria-labelledby="h-signup">
              <h1 className="t-xl lg:text-[32px] lg:leading-[42px]" id="h-signup">
                피켓 가입을 마무리합니다
              </h1>

              {v.error ? (
                <FormErrorSummary
                  focusFirst
                  errors={[
                    { fieldId: 'c-age', message: AGE_ERROR },
                    { fieldId: 'f-nick', message: NICK_ERROR },
                  ]}
                />
              ) : null}

              {/* ① 만 14세 확인. 미만이면 계정을 만들지 않고 안내 화면(CMP-046)으로 간다 — 지금은 같은 경로의 '만 14세 미만' 상태로 잇는다 */}
              <div className="col" style={{ gap: 6 }}>
                <ConsentCheckbox
                  id="c-age"
                  label="만 14세 이상입니다"
                  defaultChecked={v.ageChecked}
                  showFocus={v.error}
                  error={v.error ? AGE_ERROR : undefined}
                  hint="만 14세 미만은 가입할 수 없습니다. 예매 전 휴대폰 본인확인 때 생년월일로 한 번 더 확인합니다"
                />
                <Link className="link-more" href={previewHref('/signup/consent', '만 14세 미만', keep)} style={{ marginLeft: 32, alignSelf: 'flex-start' }}>
                  만 14세 미만입니다
                  <Chevron />
                </Link>
              </div>

              {/* ② 필수 동의 */}
              <fieldset className="col" style={{ gap: 12 }}>
                <legend className="eyebrow" style={{ marginBottom: 12 }}>
                  필수 동의
                </legend>
                <ConsentCheckbox id="c-terms" label="이용약관 동의" defaultChecked detailHref="/policy/terms" detailLabel="이용약관 보기" />
                <ConsentCheckbox
                  id="c-privacy"
                  label="개인정보 수집·이용 동의"
                  defaultChecked
                  detailHref="/policy/privacy"
                  detailLabel="개인정보 수집·이용 동의 내용 보기"
                />
                <div className="col" style={{ gap: 8, paddingLeft: 32 }}>
                  <Link className="link-more" href="/policy/privacy">
                    개인정보 처리방침
                    <Chevron />
                  </Link>
                  <p className="t-sm muted">
                    예매 때 파트너에게 제공하는 항목을 미리 알립니다{' '}
                    <Link className="link-more" href="/policy/privacy" aria-label="예매 때 파트너에게 제공하는 항목 보기">
                      보기
                      <Chevron />
                    </Link>
                  </p>
                </div>
              </fieldset>

              {/* ③ 선택 동의 */}
              <fieldset className="col" style={{ gap: 12 }}>
                <legend className="eyebrow" style={{ marginBottom: 12 }}>
                  선택 동의
                </legend>
                <ConsentCheckbox id="c-mkt" requirement="optional" label="마케팅 알림 받기" />
                <PhoneOptIn />
              </fieldset>

              {/* ④ 닉네임: 300ms 뒤 중복 검사 */}
              <NickField status={v.nick} focus={state === '닉네임 확인 중'} />

              {/* ⑤ 본인확인 권유(CMP-017 info). [지금 본인확인]은 이 화면 위에 기관 창을 연다(SCR-006, @/features/identity-verify) */}
              <div className="banner banner-info" role="status">
                <i className="ic ic-shield" aria-hidden="true" />
                <div className="banner-body col" style={{ gap: 12 }}>
                  <p>
                    <strong>입장권을 사려면 휴대폰 본인확인이 필요합니다.</strong> 지금 해 두면 오픈 때 바로 들어갑니다
                  </p>
                  <div className="row wrap" style={{ gap: '8px 16px' }}>
                    <VerifyIdentityButton className="btn btn-secondary">지금 본인확인</VerifyIdentityButton>
                    <Link className="link-more" href="/">
                      나중에 하기
                      <Chevron />
                    </Link>
                  </div>
                </div>
              </div>

              <button className="btn btn-primary btn-lg btn-block hidden lg:flex" type="button">
                가입 완료
              </button>
            </form>
          </div>
        ) : null}

        {v.under14 ? (
          <PermissionDenied
            variant="inline"
            icon="ban"
            tone="danger"
            headingLevel={1}
            title="만 14세 미만은 가입할 수 없습니다"
            description="피켓은 법정대리인 동의 절차를 두지 않아 만 14세 미만은 가입할 수 없습니다. 계정을 만들지 않았고 소셜 로그인으로 받은 정보도 지웠습니다."
            style={{ padding: '88px 24px 40px' }}
            actions={
              <Link className="link-more" href="/">
                홈으로
                <Chevron />
              </Link>
            }
          />
        ) : null}
      </main>
      <PreviewSwitcher path="/signup/consent" states={SCR005_STATES} current={state} keep={keep} />
    </AppShell>
  );
}

/** ④ 닉네임 칸(CMP-004): 뒤에 검사 결과 배지(role=status)를 붙이고 칸의 aria-describedby로 잇는다 */
function NickField({ status, focus }: { status: NickStatus; focus: boolean }) {
  const badgeId = 'f-nick-s';
  const trailing =
    status === 'checking' ? (
      <span className="row" id={badgeId} role="status" style={{ gap: 6 }}>
        <span className="spinner" aria-hidden="true" />
        <span className="badge">확인 중</span>
      </span>
    ) : status === 'taken' ? (
      <span className="badge badge-danger" id={badgeId} role="status">
        이미 사용 중
      </span>
    ) : (
      <span className="badge badge-success" id={badgeId} role="status">
        사용 가능
      </span>
    );
  return (
    <TextField
      id="f-nick"
      label="닉네임"
      requiredMark
      autoComplete="nickname"
      defaultValue={status === 'taken' ? '지민' : '새 사용자'}
      hint="이모지는 쓸 수 없습니다"
      error={status === 'taken' ? NICK_ERROR : undefined}
      showFocus={focus}
      aria-describedby={badgeId}
      trailing={trailing}
    />
  );
}
