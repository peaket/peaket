'use client';
// SCR-050 실제 화면(d5 §5.26, docs/features/identity.md §6.1 '휴대폰 화면 실제 연결', BUILD_ORDER F-05-7 = GAT-230·GAT-240, ADR-0362).
// 차례: 주소의 #token= 조각을 읽어 탭 저장소로 옮기고 주소창에서 지운다 → 조회 → 회차 공개 요약(판매자 상호·공연명·회차 시작) →
// 두 동의 체크 → 수락(조회가 준 consentVersion) 또는 [수락하지 않기] → 확인 줄 → 거절. 규칙은 features/staff-invitation/flow.ts에 있다.
// 조회가 성공하면 탭 저장소의 토큰을 지우고 이 화면 메모리에만 둔다. 로그인하러 갈 때 next에는 경로만 싣고, 토큰은 탭 저장소에 되돌려 둔다(돌아와 잇는다).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browserEventSummaryReader } from '@/entities/event-summary/browser';
import { STAFF_ROLE_LABEL, staffValidRangeText, staffWhenText } from '@/entities/staff-assignment';
import { tabStore } from '@/features/account-withdraw';
import { afterAccept, afterReject, canAcceptIn, consentLinesOf, type InvitationLoad, loadInvitation, STAFF_RETRY_TEXT } from '@/features/staff-invitation';
import { browserStaffInvitationApi } from '@/features/staff-invitation/browser';
import { captureStaffFragment, clearStaffFragment, keepStaffFragment, staffLoginHref, takeStaffFragment } from '@/shared/lib/staff-fragment';
import { loginHrefAfterRefresh } from '@/shared/lib/token-refresh';
import { AppShell } from '@/widgets/app-shell';
import { invitationView } from '../model/state';
import { InvitationDoneBanner, InvitationDoneLink, InvitationLoadingSkeleton, InvitationStateCard, InvitationSummaryCard } from './InvitationParts';
import { InviteConsentForm } from './InviteConsentForm';

const PATH = '/staff/invitations';
const CLOSE_HREF = '/';

export function StaffInvitationsLive() {
  const api = useMemo(() => browserStaffInvitationApi(), []);
  const events = useMemo(() => browserEventSummaryReader(), []);
  const [load, setLoad] = useState<InvitationLoad>({ state: '조회 중' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 고지를 다시 조회하면(422 consent-version-outdated) 폼을 새로 그려 체크를 푼다 */
  const [formKey, setFormKey] = useState(0);
  /** 조회에 쓴 토큰(조회가 성공하면 탭 저장소에서 지우고 여기에만 둔다) */
  const tokenRef = useRef<string | null>(null);

  const lookup = useCallback(async () => {
    setLoad({ state: '조회 중' });
    setNotice(null);
    const token = tokenRef.current ?? takeStaffFragment(tabStore, 'invite', Date.now());
    const r = await loadInvitation({ api, events, token });
    if (r.invitation) {
      // 조회 성공: 탭 저장소에서 지운다(docs/frontend.md §3.12). 수락·거절은 메모리의 토큰으로 보낸다
      tokenRef.current = token;
      clearStaffFragment(tabStore, 'invite');
    } else if (r.state === '만료') {
      tokenRef.current = null;
      clearStaffFragment(tabStore, 'invite');
    }
    // 로그인 필요·불러오지 못함은 탭 저장소 값을 남겨 로그인 뒤·다시 불러올 때 잇는다
    setLoad(r);
  }, [api, events]);

  useEffect(() => {
    captureStaffFragment({ kind: 'invite', location: window.location, history: window.history, storage: tabStore, now: Date.now() });
    void lookup();
  }, [lookup]);

  /** 세션이 끝나 로그인 화면으로 간다: 토큰을 탭 저장소에 되돌려 두고 next에는 경로만 */
  const toLogin = () => {
    if (tokenRef.current) keepStaffFragment(tabStore, 'invite', tokenRef.current, Date.now());
    window.location.assign(loginHrefAfterRefresh(PATH));
  };

  const accept = async () => {
    const token = tokenRef.current;
    const inv = load.invitation;
    // [수락]을 켜는 판정과 같은 함수로 막는다(요약을 못 읽었거나 동의 전이 아니면 요청을 보내지 않는다, I-T91 ③, 리뷰 RV-01)
    if (busy || !token || !inv || !canAcceptIn(load)) return;
    setBusy(true);
    setNotice(null);
    const next = afterAccept(await api.accept({ inviteToken: token, consentVersion: inv.consents.consentVersion }));
    setBusy(false);
    if (next === 'login') return toLogin();
    if (next === 'retry') return setNotice(STAFF_RETRY_TEXT);
    if (next === 'reload') {
      // 고지 판이 바뀌었다: 다시 조회해 새 문안을 보이고 체크를 푼다(I-T91 ②)
      setFormKey((k) => k + 1);
      return void lookup();
    }
    if (next === '수락 완료' || next === '만료') tokenRef.current = null;
    setLoad((l) => ({ ...l, state: next }));
  };

  const reject = async () => {
    const token = tokenRef.current;
    if (busy || !token) return;
    setBusy(true);
    setNotice(null);
    const next = afterReject(await api.reject(token));
    setBusy(false);
    if (next === 'login') return toLogin();
    if (next === 'retry') return setNotice(STAFF_RETRY_TEXT);
    tokenRef.current = null;
    setLoad((l) => ({ ...l, state: next }));
  };

  const v = invitationView(load.state);
  const inv = load.invitation;
  const summary = load.summary;

  return (
    <AppShell variant="staff" staff={{ closeHref: CLOSE_HREF }} guest={v.mode === 'login'}>
      <main
        className="page-main px-4 pt-6 pb-10 md:bg-(--surface-basement) md:px-6 md:pt-10 md:pb-14 lg:px-8 lg:pt-12 lg:pb-16"
        id="main"
        tabIndex={-1}
      >
        <div className="col mx-auto w-full max-w-[560px] flex-1 gap-6">
          <div className="col" style={{ gap: 8 }}>
            <h1 className="t-xl">현장 스태프 초대</h1>
            {v.summary && summary ? <p className="t-sm muted lg:text-[16px] lg:leading-[22px]">{summary.sellerName}가 현장 근무에 초대했습니다.</p> : null}
          </div>

          {v.mode === 'loading' ? <InvitationLoadingSkeleton /> : null}
          {v.mode === 'done' ? <InvitationDoneBanner /> : null}

          {v.summary && inv ? (
            <InvitationSummaryCard
              title={summary?.title ?? ''}
              whenWhere={summary ? staffWhenText(summary.startsAt) : ''}
              partnerName={summary?.sellerName ?? null}
              roleLabel={STAFF_ROLE_LABEL[inv.role]}
              validText={staffValidRangeText(inv.validFrom, inv.validUntil)}
              email={inv.invitedEmailMasked}
              onReload={() => void lookup()}
            />
          ) : null}

          {v.mode === 'form' && inv ? (
            <InviteConsentForm
              key={`${formKey}-${inv.consents.consentVersion}`}
              collectRows={consentLinesOf(inv.consents.collection)}
              provideRows={consentLinesOf(inv.consents.provision)}
              defaultCollect={false}
              defaultProvide={false}
              provideError={v.consent.provideError}
              blocked={!canAcceptIn(load)}
              onAccept={() => void accept()}
              onReject={() => void reject()}
              busy={busy}
              notice={notice}
            />
          ) : null}

          <InvitationStateCard mode={v.mode} email={inv?.invitedEmailMasked ?? ''} loginHref={staffLoginHref(PATH)} onRetry={() => void lookup()} />
          {v.mode === 'done' ? <InvitationDoneLink /> : null}
        </div>
      </main>
    </AppShell>
  );
}
