// SCR-051 스캐너 승인(휴대폰 쪽)(d5 §5.27, d3 SCR-051 행, 캔버스 보드 SCR-051-m·t·d와 흐름 보드 FLOW-staff-login ⑤⑥을 한 페이지 반응형으로 합쳤다).
// 스캐너(SCR-036)의 QR을 스태프가 자기 휴대폰으로 찍으면 열린다. 한 열: 설명 → ① 경고 → ② 기기 카드 → ③ 확인 코드 → ④ 내 배정 → ⑥ 대리 승인 → ⑤ 승인·거부.
// 휴대폰은 바탕 위에 바로 쌓고, md 768부터 옅은 바탕(surface-basement) 가운데 560 폭으로 바뀐다. 셸은 스태프 변형(하늘 = 현장 책임자, 로그인 필요는 로그인 전 모양).
// 실제 흐름(API 출처가 있고 ?state=가 없을 때)은 주소의 #code= 조각을 읽고 지운 뒤 클라이언트가 그린다(StaffApproveLive, d5 §5.27, BUILD_ORDER F-05-7, ADR-0362).
// 퍼블리싱 미리보기는 ?state=(보드 state 값과 d5 상태 이름), 다크는 ?theme=dark.
import { previewHref, resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { ME_HANEUL } from '@/entities/me';
import { STAFF_ROLE_LABEL } from '@/entities/staff-assignment';
import { isLiveStaff } from '@/features/staff-invitation/browser';
import { SCR051_STATES } from '@/shared/config/screens.account';
import type { PageProps } from '@/shared/lib/page-props';
import { staffLoginHref } from '@/shared/lib/staff-fragment';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { approvalModel, codeLabel, STAFF_DOYUN } from '../model/approval';
import { approveView } from '../model/state';
import { ApproveCodeCard, ApproveDenyCard, ApproveDeviceCard, ApproveIntro, ApproveLoadingSkeleton, ApproveLoginCard, ApproveResultCard, ApproveWarning } from './ApproveParts';
import { ApproveForm } from './ApproveForm';
import { StaffApproveLiveLoader } from './StaffApproveLiveLoader';

const PATH = '/staff/approve';
/** 닫기는 내 현장 배정으로 간다(추천안: d5에 닫은 뒤 갈 곳이 없고, 스태프 화면의 첫 화면이 SCR-061이다) */
const CLOSE_HREF = '/staff';

export async function StaffApprovePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  // 실제 흐름: API 출처가 있고 미리보기 상태를 고르지 않았을 때(계획 F-05-7 §4)
  if (isLiveStaff() && sp.state === undefined) return <StaffApproveLiveLoader />;
  const state = resolvePreviewState(sp, SCR051_STATES, '승인 대기');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const keep = { theme: dark ? 'dark' : undefined };
  const v = approveView(state);
  const m = approvalModel();
  const account = v.introAs === 'staff' ? STAFF_DOYUN : ME_HANEUL;
  const accountRole = STAFF_ROLE_LABEL[v.introAs === 'staff' ? 'gate_staff' : 'gate_lead'];

  return (
    <AppShell variant="staff" staff={{ closeHref: CLOSE_HREF }} user={account} guest={!v.signedIn} dark={dark}>
      <main
        className="page-main px-4 pt-6 pb-10 md:bg-(--surface-basement) md:px-6 md:pt-10 md:pb-14 lg:px-8"
        id="main"
        tabIndex={-1}
      >
        <div className="col mx-auto w-full max-w-[560px] flex-1 gap-5">
          <h1 className="t-xl">스캐너 승인</h1>

          {v.introAs ? <ApproveIntro account={`${account.name} · ${accountRole}`} /> : null}
          {/* 로그인 뒤 같은 탭으로 돌아온다. next에는 경로만 넣는다(#code= 조각은 넣지 않는다, d5 §5.27) */}
          {v.mode === 'login' ? <ApproveLoginCard loginHref={staffLoginHref(PATH)} /> : null}
          {v.warning ? <ApproveWarning /> : null}
          {v.mode === 'loading' ? <ApproveLoadingSkeleton /> : null}
          {v.device ? <ApproveDeviceCard deviceName={m.deviceName} partnerName={v.partnerKnown ? m.partnerName : null} /> : null}

          {v.mode === 'ready' ? (
            <div className="col flex-1 gap-5">
              <ApproveCodeCard code={m.code} label={codeLabel(m.code)} />
              <ApproveForm
                key={state}
                deviceName={m.deviceName}
                single={
                  v.pick === 'single' ? (v.partnerKnown ? { title: m.single.show, meta: m.single.meta } : { title: m.singleCompact }) : undefined
                }
                options={v.pick === 'multi' ? m.options : undefined}
                canProxy={v.pick === 'single'}
                defaultProxy={v.proxy}
                accountName={ME_HANEUL.name}
                approvedHref={previewHref(PATH, '승인됨', keep)}
                rejectedHref={previewHref(PATH, '거부함', keep)}
              />
            </div>
          ) : null}

          {v.mode === 'denied' && v.deny ? <ApproveDenyCard deny={v.deny} accountName={account.name} validText={m.validText} /> : null}
          <ApproveResultCard mode={v.mode} approvedText={m.approvedText} />
        </div>
      </main>
      <PreviewSwitcher path={PATH} states={SCR051_STATES} current={state} keep={keep} />
    </AppShell>
  );
}
