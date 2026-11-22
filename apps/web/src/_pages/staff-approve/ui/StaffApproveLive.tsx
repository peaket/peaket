'use client';
// SCR-051 실제 화면(d5 §5.27, docs/features/identity.md §6.1 '휴대폰 화면 실제 연결'·'승인 화면의 파트너 이름', BUILD_ORDER F-05-7 = GAT-230, ADR-0362 결정 8).
// 차례: 주소의 #code= 조각을 읽어 탭 저장소로 옮기고 주소창에서 지운다 → 조회 → 배정마다 회차 공개 요약 → 사람이 두 코드를 대조하고 [승인]·[거부]를 누를 때만 보낸다.
// 규칙은 features/staff-approval/flow.ts에 있다. 조회가 성공하면 탭 저장소의 코드를 지우고 이 화면 메모리에만 둔다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browserEventSummaryReader } from '@/entities/event-summary/browser';
import { useFanSession } from '@/entities/me';
import { STAFF_ROLE_LABEL } from '@/entities/staff-assignment';
import { tabStore } from '@/features/account-withdraw';
import { afterDecide, type ApprovalLiveState, type ApprovalView, approvalCodeLabel, loadApproval } from '@/features/staff-approval';
import { browserStaffApprovalApi } from '@/features/staff-approval/browser';
import { STAFF_RETRY_TEXT } from '@/features/staff-invitation';
import { captureStaffFragment, clearStaffFragment, keepStaffFragment, staffLoginHref, takeStaffFragment } from '@/shared/lib/staff-fragment';
import { loginHrefAfterRefresh } from '@/shared/lib/token-refresh';
import { AppShell } from '@/widgets/app-shell';
import { approveView } from '../model/state';
import { ApproveCodeCard, ApproveDenyCard, ApproveDeviceCard, ApproveIntro, ApproveLoadingSkeleton, ApproveLoginCard, ApproveResultCard, ApproveWarning } from './ApproveParts';
import { ApproveForm } from './ApproveForm';

const PATH = '/staff/approve';
const CLOSE_HREF = '/staff';

export function StaffApproveLive() {
  const api = useMemo(() => browserStaffApprovalApi(), []);
  const events = useMemo(() => browserEventSummaryReader(), []);
  const session = useFanSession();
  const [state, setState] = useState<ApprovalLiveState>('조회 중');
  const [view, setView] = useState<ApprovalView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 승인됨 카드 줄에 쓸 고른 배정 */
  const [decided, setDecided] = useState<{ assignmentId?: string; proxy: boolean } | null>(null);
  const codeRef = useRef<string | null>(null);

  const lookup = useCallback(async () => {
    setState('조회 중');
    setNotice(null);
    const code = codeRef.current ?? takeStaffFragment(tabStore, 'approve', Date.now());
    const r = await loadApproval({ api, events, code });
    if (r.view) {
      codeRef.current = code;
      clearStaffFragment(tabStore, 'approve');
    } else if (r.state !== '로그인 필요' && r.state !== '불러오지 못함') {
      // 코드 만료·시도 초과·권한 없음은 그 코드로 더 할 일이 없다
      codeRef.current = null;
      clearStaffFragment(tabStore, 'approve');
    }
    setView(r.view ?? null);
    setState(r.state);
  }, [api, events]);

  useEffect(() => {
    captureStaffFragment({ kind: 'approve', location: window.location, history: window.history, storage: tabStore, now: Date.now() });
    void lookup();
  }, [lookup]);

  const decide = async (d: { decision: 'APPROVE' | 'DENY'; assignmentId?: string; proxy: boolean }) => {
    const code = codeRef.current;
    if (busy || !code) return;
    setBusy(true);
    setNotice(null);
    const next = afterDecide(await api.decide({ userCode: code, decision: d.decision, ...(d.assignmentId ? { assignmentId: d.assignmentId } : {}), proxy: d.proxy }), d.decision);
    setBusy(false);
    if (next === 'login') {
      keepStaffFragment(tabStore, 'approve', code, Date.now());
      window.location.assign(loginHrefAfterRefresh(PATH));
      return;
    }
    if (next === 'retry') return setNotice(STAFF_RETRY_TEXT);
    // 대리 승인 거절은 승인 요청의 거절이라 기기 정보를 그대로 둔다(d5 §5.27). 그 밖의 결과는 이 코드로 더 할 일이 없다
    if (next !== '권한 없음 · 대리 승인') codeRef.current = null;
    setDecided(d);
    setState(next);
  };

  const v = approveView(state);
  const member = session.status === 'member' ? session.me : null;
  const single = view && view.assignments.length === 1 ? view.assignments[0]! : null;
  const roleOfMe = single ? STAFF_ROLE_LABEL[single.role] : null;
  const chosen = view?.assignments.find((a) => a.assignmentId === (decided?.assignmentId ?? single?.assignmentId));
  const approvedText = view && chosen ? [view.deviceName, chosen.label].join(' · ') : view?.deviceName;

  return (
    <AppShell variant="staff" staff={{ closeHref: CLOSE_HREF }} guest={!v.signedIn}>
      <main className="page-main px-4 pt-6 pb-10 md:bg-(--surface-basement) md:px-6 md:pt-10 md:pb-14 lg:px-8" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[560px] flex-1 gap-5">
          <h1 className="t-xl">스캐너 승인</h1>

          {v.introAs ? <ApproveIntro account={member ? (roleOfMe ? `${member.name} · ${roleOfMe}` : member.name) : null} /> : null}
          {v.mode === 'login' ? <ApproveLoginCard loginHref={staffLoginHref(PATH)} /> : null}
          {v.warning ? <ApproveWarning /> : null}
          {v.mode === 'loading' ? <ApproveLoadingSkeleton /> : null}
          {(v.mode === 'ready' || v.deny === 'proxy') && view ? <ApproveDeviceCard deviceName={view.deviceName} partnerName={view.partnerName} /> : null}

          {v.mode === 'ready' && view ? (
            <div className="col flex-1 gap-5">
              <ApproveCodeCard code={view.code} label={approvalCodeLabel(view.code)} />
              <ApproveForm
                deviceName={view.deviceName}
                single={single ? { title: single.title, ...(single.meta ? { meta: single.meta } : {}) } : undefined}
                singleId={single?.assignmentId}
                options={single ? undefined : view.assignments.map((a) => ({ id: a.assignmentId, label: a.label }))}
                canProxy={view.canProxy}
                defaultProxy={false}
                accountName={member?.name ?? null}
                onDecide={(d) => void decide(d)}
                busy={busy}
                notice={notice}
              />
            </div>
          ) : null}

          {v.mode === 'denied' && v.deny ? <ApproveDenyCard deny={v.deny} accountName={member?.name ?? null} /> : null}
          <ApproveResultCard mode={v.mode} approvedText={approvedText} onRetry={() => void lookup()} />
        </div>
      </main>
    </AppShell>
  );
}
