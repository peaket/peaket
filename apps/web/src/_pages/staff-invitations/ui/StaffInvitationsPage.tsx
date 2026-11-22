// SCR-050 현장 스태프 초대 수락(d5 §5.26, d3 SCR-050 행, 캔버스 보드 SCR-050-m·t·d를 한 페이지 반응형으로 합쳤다).
// 한 열: 제목·소개 → 초대 요약 카드(파트너·역할·권한 유효 시간·초대 이메일) → 수락 조건 → 두 동의 카드 → 수락·수락하지 않기(거절 확인).
// 휴대폰은 바탕 위에 바로 쌓고, md 768부터 옅은 바탕(surface-basement) 가운데 560 폭으로 바뀐다. 셸은 스태프 변형(하늘 = 현장 책임자).
// 실제 흐름(API 출처가 있고 ?state=가 없을 때)은 주소의 #token= 조각을 읽고 지운 뒤 클라이언트가 그린다(StaffInvitationsLive, d5 §5.26, BUILD_ORDER F-05-7, ADR-0362).
// 퍼블리싱 미리보기는 ?state=(보드 state 값과 d5 상태 이름), 다크는 ?theme=dark.
import { previewHref, resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { ME_HANEUL } from '@/entities/me';
import { isLiveStaff } from '@/features/staff-invitation/browser';
import { SCR050_STATES } from '@/shared/config/screens.account';
import type { PageProps } from '@/shared/lib/page-props';
import { staffLoginHref } from '@/shared/lib/staff-fragment';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { COLLECT_ROWS, INVITATION, invitationSummary, provideRows } from '../model/invitation';
import { invitationView } from '../model/state';
import { InvitationDoneBanner, InvitationDoneLink, InvitationLoadingSkeleton, InvitationStateCard, InvitationSummaryCard } from './InvitationParts';
import { InviteConsentForm } from './InviteConsentForm';
import { StaffInvitationsLiveLoader } from './StaffInvitationsLiveLoader';

const PATH = '/staff/invitations';
/** 닫기는 홈으로 간다(추천안: d5에 닫은 뒤 갈 곳이 없다) */
const CLOSE_HREF = '/';

export async function StaffInvitationsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  // 실제 흐름: API 출처가 있고 미리보기 상태를 고르지 않았을 때(계획 F-05-7 §4)
  if (isLiveStaff() && sp.state === undefined) return <StaffInvitationsLiveLoader />;
  const state = resolvePreviewState(sp, SCR050_STATES, '동의 전');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const keep = { theme: dark ? 'dark' : undefined };
  const v = invitationView(state);
  const inv = invitationSummary();
  const email = v.otherEmail ? INVITATION.otherEmailMasked : INVITATION.emailMasked;

  return (
    <AppShell variant="staff" staff={{ closeHref: CLOSE_HREF }} user={ME_HANEUL} guest={v.mode === 'login'} dark={dark}>
      <main
        className="page-main px-4 pt-6 pb-10 md:bg-(--surface-basement) md:px-6 md:pt-10 md:pb-14 lg:px-8 lg:pt-12 lg:pb-16"
        id="main"
        tabIndex={-1}
      >
        <div className="col mx-auto w-full max-w-[560px] flex-1 gap-6">
          <div className="col" style={{ gap: 8 }}>
            <h1 className="t-xl">현장 스태프 초대</h1>
            {v.summary && !v.partnerUnreadable ? <p className="t-sm muted lg:text-[16px] lg:leading-[22px]">{inv.partnerName}가 현장 근무에 초대했습니다.</p> : null}
          </div>

          {v.mode === 'loading' ? <InvitationLoadingSkeleton /> : null}
          {v.mode === 'done' ? <InvitationDoneBanner /> : null}

          {v.summary ? (
            <InvitationSummaryCard
              title={inv.title}
              poster={{ art: inv.posterArt, short: inv.posterShort }}
              whenWhere={inv.whenWhere}
              partnerName={v.partnerUnreadable ? null : inv.partnerName}
              roleLabel={inv.roleLabel}
              validText={inv.validText}
              email={email}
            />
          ) : null}

          {v.mode === 'form' ? (
            <InviteConsentForm
              key={state}
              collectRows={COLLECT_ROWS}
              provideRows={provideRows(inv.partnerName)}
              defaultCollect={v.consent.collect}
              defaultProvide={v.consent.provide}
              provideError={v.consent.provideError}
              blocked={v.partnerUnreadable}
              defaultConfirmReject={v.confirmReject}
              acceptedHref={previewHref(PATH, '수락 완료', keep)}
              rejectedHref={previewHref(PATH, '거절함', keep)}
            />
          ) : null}

          <InvitationStateCard mode={v.mode} email={email} loginHref={staffLoginHref(PATH)} />
          {v.mode === 'done' ? <InvitationDoneLink /> : null}
        </div>
      </main>
      <PreviewSwitcher path={PATH} states={SCR050_STATES} current={state} keep={keep} />
    </AppShell>
  );
}
