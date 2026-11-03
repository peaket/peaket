// SCR-050 현장 스태프 초대 수락(d5 §5.26, d3 SCR-050 행, 캔버스 보드 SCR-050-m·t·d를 한 페이지 반응형으로 합쳤다).
// 한 열: 제목·소개 → 초대 요약 카드(파트너·역할·권한 유효 시간·초대 이메일) → 수락 조건 → 두 동의 카드 → 수락·수락하지 않기.
// 휴대폰은 바탕 위에 바로 쌓고, md 768부터 옅은 바탕(surface-basement) 가운데 560 폭으로 바뀐다. 셸은 스태프 변형(하늘 = 현장 책임자).
// 실제 화면은 주소의 #token= 조각을 읽고 지운 뒤 클라이언트가 그린다(d5 §5.26). 퍼블리싱 단계라 상태는 ?state=(보드 state 값), 다크는 ?theme=dark.
import Link from 'next/link';
import { previewHref, resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { ME_HANEUL } from '@/entities/me';
import { ProductionPoster } from '@/entities/production';
import { VerifyIdentityButton } from '@/features/identity-verify';
import { SCR050_STATES } from '@/shared/config/screens.account';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { COLLECT_ROWS, INVITATION, invitationSummary, provideRows } from '../model/invitation';
import { invitationView } from '../model/state';
import { InviteConsentForm } from './InviteConsentForm';

const PATH = '/staff/invitations';
/** 닫기·수락하지 않기는 홈으로 간다(추천안: d5에 닫은 뒤 갈 곳이 없다) */
const CLOSE_HREF = '/';

/** 상태 카드(이유 화면) 둘레: 휴대폰 보드 28/20, md 이상은 SCR-051 태블릿 보드와 같은 36/32(추천안: 이 화면의 태블릿 보드에는 기본 상태만 있다) */
const STATE_CARD = 'card state px-5 py-7 md:px-8 md:py-9';

export async function StaffInvitationsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR050_STATES, '동의 전');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const keep = { theme: dark ? 'dark' : undefined };
  const v = invitationView(state);
  const inv = invitationSummary();
  const email = v.otherEmail ? INVITATION.otherEmailMasked : INVITATION.emailMasked;

  return (
    <AppShell variant="staff" staff={{ closeHref: CLOSE_HREF }} user={ME_HANEUL} dark={dark}>
      <main
        className="page-main px-4 pt-6 pb-10 md:bg-(--surface-basement) md:px-6 md:pt-10 md:pb-14 lg:px-8 lg:pt-12 lg:pb-16"
        id="main"
        tabIndex={-1}
      >
        <div className="col mx-auto w-full max-w-[560px] flex-1 gap-6">
          <div className="col" style={{ gap: 8 }}>
            <h1 className="t-xl">현장 스태프 초대</h1>
            {v.summary ? <p className="t-sm muted lg:text-[16px] lg:leading-[22px]">{inv.partnerName}가 현장 근무에 초대했습니다.</p> : null}
          </div>

          {v.mode === 'loading' ? <LoadingSkeleton /> : null}

          {v.mode === 'done' ? (
            <div className="banner banner-success" role="status">
              <i className="ic ic-check-circle" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">수락했습니다</span>
                입장 시작 3시간 전부터 스캐너에 로그인할 수 있습니다.
              </div>
            </div>
          ) : null}

          {v.summary ? (
            <article className="card" aria-labelledby="inv-t">
              <div className="row items-start gap-3 px-4 pt-4 pb-[14px] md:gap-4 md:px-5 md:pt-5 md:pb-4 lg:px-6">
                <ProductionPoster art={inv.posterArt} size="sm" title={inv.posterShort} label={`${inv.title} 포스터`} className="w-14 md:w-16" />
                <div className="col grow" style={{ gap: 4 }}>
                  <h2 className="t-md fw-b md:text-[20px] md:leading-[27px]" id="inv-t">
                    {inv.title}
                  </h2>
                  <p className="t-sm muted">{inv.whenWhere}</p>
                </div>
              </div>
              <hr className="divider" />
              <dl className="kv px-4 pt-[14px] pb-3 md:px-5 md:pt-4 lg:px-6">
                <dt>파트너</dt>
                <dd>{inv.partnerName}</dd>
                <dt>역할</dt>
                <dd>
                  <span className="badge badge-primary">{inv.roleLabel}</span>
                </dd>
                <dt>권한 유효 시간</dt>
                <dd>{inv.validText}</dd>
                <dt>초대 이메일</dt>
                <dd>
                  <span className="mono t-sm">{email}</span>
                </dd>
              </dl>
              <p className="t-xs muted px-4 pb-4 md:px-5 md:pb-[18px] lg:px-6">권한 유효 시간은 입장 시작 3시간 전부터 공연 종료 2시간 뒤까지입니다.</p>
            </article>
          ) : null}

          {v.mode === 'form' ? (
            <InviteConsentForm
              key={state}
              collectRows={COLLECT_ROWS}
              provideRows={provideRows(inv.partnerName)}
              defaultCollect={v.consent.collect}
              defaultProvide={v.consent.provide}
              provideError={v.consent.provideError}
              acceptedHref={previewHref(PATH, '수락 완료', keep)}
              closeHref={CLOSE_HREF}
            />
          ) : null}

          {v.mode === 'mismatch' ? (
            <div className={STATE_CARD} role="alert">
              <span className="state-icon is-danger">
                <i className="ic ic-mail" aria-hidden="true" />
              </span>
              <h2 className="t-lg">초대 이메일과 계정 이메일이 다릅니다</h2>
              {/* 보드는 이 줄에 ha***@example.com을, 카드의 초대 이메일에 .org를 적었다. 이 줄은 초대 이메일을 말하므로 카드와 같은 주소로 맞췄다(추천안) */}
              <p className="t-sm">
                이 초대는 <span className="mono">{email}</span> 계정 이메일과 같아야 받을 수 있습니다. 이 계정 이메일로 다시 초대를 요청하세요.
              </p>
            </div>
          ) : null}

          {v.mode === 'no-verified-email' ? (
            <div className={STATE_CARD} role="alert">
              <span className="state-icon is-warning">
                <i className="ic ic-key" aria-hidden="true" />
              </span>
              <h2 className="t-lg">카카오나 구글 로그인 수단을 연결해야 받을 수 있습니다</h2>
              <p className="t-sm muted">이 계정은 네이버 로그인만 연결되어 있어 초대 이메일과 맞춰 볼 검증된 이메일이 없습니다.</p>
              <Link className="btn btn-primary btn-lg btn-block" href="/my/settings/providers">
                로그인 수단 연결하러 가기
              </Link>
            </div>
          ) : null}

          {v.mode === 'need-identity' ? (
            <div className={STATE_CARD} role="alert">
              <span className="state-icon is-warning">
                <i className="ic ic-shield" aria-hidden="true" />
              </span>
              <h2 className="t-lg">휴대폰 본인확인을 먼저 마쳐야 합니다</h2>
              <p className="t-sm muted">본인확인을 마친 계정만 초대를 받을 수 있습니다. 본인확인을 마치면 이 화면에서 수락을 이어 갑니다.</p>
              <p className="t-sm" id="nid-purpose">
                휴대폰 본인확인은 계정당 한 번만 합니다. 한 사람은 한 계정으로만 예매할 수 있습니다
              </p>
              {/* SCR-006 기관 창·결과 대화상자를 이 화면 위에서 연다 */}
              <VerifyIdentityButton className="btn btn-primary btn-lg btn-block" describedBy="nid-purpose">
                <i className="ic ic-phone" aria-hidden="true" />
                휴대폰 본인확인
              </VerifyIdentityButton>
            </div>
          ) : null}

          {v.mode === 'expired' ? (
            <div className="card state px-5 py-9 md:px-8 md:py-11" role="alert">
              <span className="state-icon is-warning">
                <i className="ic ic-clock" aria-hidden="true" />
              </span>
              <h2 className="t-lg">초대가 만료되었습니다</h2>
              <p className="t-sm muted">초대 링크는 받은 때부터 24시간 동안 한 번만 쓸 수 있습니다. 파트너에게 다시 요청하세요.</p>
            </div>
          ) : null}

          {v.mode === 'assigned' ? (
            <div className={STATE_CARD} role="alert">
              <span className="state-icon is-primary">
                <i className="ic ic-check-circle" aria-hidden="true" />
              </span>
              <h2 className="t-lg">이미 이 회차에 배정되어 있습니다</h2>
              <p className="t-sm muted">배정 내용과 권한 유효 시간은 내 현장 배정에서 볼 수 있습니다.</p>
              <Link className="btn btn-primary btn-lg btn-block" href="/staff">
                내 현장 배정 보기
              </Link>
            </div>
          ) : null}

          {v.mode === 'done' ? (
            <Link className="btn btn-primary btn-lg btn-block" href="/staff">
              내 현장 배정 보기
            </Link>
          ) : null}
        </div>
      </main>
      <PreviewSwitcher path={PATH} states={SCR050_STATES} current={state} keep={keep} />
    </AppShell>
  );
}

/** 조회 중: 초대 요약 카드와 동의 카드 뼈대(보드 그대로) */
function LoadingSkeleton() {
  return (
    <div className="col" style={{ gap: 16 }} aria-busy="true">
      <p className="t-sm muted" role="status">
        초대 정보를 확인하는 중입니다
      </p>
      <div className="card col" style={{ gap: 12, padding: 16 }}>
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <span className="skel" style={{ width: 56, height: 75, flex: 'none' }} />
          <div className="col grow" style={{ gap: 8 }}>
            <span className="skel" style={{ height: 20, width: '85%' }} />
            <span className="skel" style={{ height: 16, width: '60%' }} />
          </div>
        </div>
        <hr className="divider" />
        <span className="skel" style={{ height: 16 }} />
        <span className="skel" style={{ height: 16 }} />
        <span className="skel" style={{ height: 16, width: '70%' }} />
      </div>
      <div className="card col" style={{ gap: 10, padding: 16 }}>
        <span className="skel" style={{ height: 20, width: '40%' }} />
        <span className="skel" style={{ height: 16 }} />
        <span className="skel" style={{ height: 16 }} />
        <span className="skel" style={{ height: 16, width: '60%' }} />
      </div>
    </div>
  );
}
