'use client';
// SCR-040 ①②③의 실제 흐름(docs/features/identity.md §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BUILD_ORDER BOT-041, I-T33·I-T34)과
// ④~⑥ 계정 합치기(같은 절 '계정 병합의 첫 구현' 화면, BUILD_ORDER BOT-043, I-T31·I-T32).
// 목록을 읽고, [연결 해제]·[로그인 수단 추가]·[다시 로그인하고 계속](합치기)은 먼저 재인증한다(연결한 제공자가 둘 이상이면 고른다). 재인증에서 돌아오면 탭 저장소의 할 일을 잇는다:
// 해제는 DELETE /v1/identity/providers/{p}, 추가는 POST /link/{p}(앱 서버가 새 제공자 인증 뒤 ?loginMethod=로 결과를 돌려준다),
// 합치기는 제안을 다시 읽고 확인 창을 연 뒤 POST /v1/identity/merge-proposals/{id}/confirmation이다.
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { useEffect, useId, useState } from 'react';
import { PROVIDER_NAME } from '@/entities/provider';
import {
  addResultText,
  browserLoginMethodsApi,
  dayText,
  isMergeProposalId,
  type LinkedMethod,
  leaveForReauth,
  linkForm,
  markMergedAway,
  mergeAfterConfirm,
  mergeAfterGet,
  mergeToOpen,
  mergeUrlWithoutProposal,
  type MergeState,
  type MergeStep,
  PROVIDERS,
  type Provider,
  submitForm,
  tabStore,
  takePending,
  unlinkResultText,
} from '@/features/login-methods';
import { WebShellModal } from '@peaket/ds/WebShell';
import { loginHrefAfterRefresh } from '@/shared/lib/token-refresh';
import { REAUTH_START_UNAVAILABLE, reauthFailureText } from '@/shared/lib/reauth-failure';
import { LiveMergeCard } from './LiveMergeCard';

type Notice = { tone: 'success' | 'warning' | 'danger'; text: string };
type Plan = { action: 'unlink' | 'add'; provider: Provider } | { action: 'merge'; proposalId: string };

const CARD_FROM_MD = 'md:rounded-(--r-xl) md:border md:border-(--border) md:bg-(--surface) md:px-6 md:py-5';

export function LiveLoginMethods({ loginMethod, mergeProposal }: { loginMethod?: string; mergeProposal?: string }) {
  const [api] = useState(() => browserLoginMethodsApi());
  const [methods, setMethods] = useState<LinkedMethod[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(() => addResultText(loginMethod ?? null, loginMethod === 'other-account' ? { merge: isMergeProposalId(mergeProposal) } : {}));
  const [plan, setPlan] = useState<Plan | null>(null);
  const [choosingAdd, setChoosingAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 목록을 불러오지 못했다(안내와 다시 불러오기) */
  const [loadFailed, setLoadFailed] = useState(false);
  const [merge, setMerge] = useState<MergeState | null>(() => (isMergeProposalId(mergeProposal) ? { id: mergeProposal, view: null, phase: 'loading' } : null));
  const ids = useId();
  const toLogin = () => window.location.assign(loginHrefAfterRefresh('/my/settings/providers'));

  const load = async () => {
    const r = await api.list();
    if (r.kind === 'ok') {
      setLoadFailed(false);
      setMethods(r.methods);
    } else if (r.kind === 'login') toLogin();
    else setLoadFailed(true);
  };

  /** 상태 바뀜(features/login-methods mergeAfter*)을 화면에 옮긴다. 다른 문서로 떠나면 true. keepNotice면 앞서 띄운 안내를 덮지 않는다(시작할 때) */
  const apply = (st: MergeStep, keepNotice = false): boolean => {
    if (st.login) {
      toLogin();
      return true;
    }
    if (st.go) {
      // 세션이 끝났으므로 새 문서로 연다(남은 화면 상태를 들고 가지 않게, 탈퇴 완료와 같다).
      // 흡수 안내는 이 탭에만 보이게 떠나기 직전에 표시를 남긴다(주소만으로는 안내를 그리지 않는다, BOT-043이 넘긴 것)
      if (st.mergedAway) markMergedAway(tabStore, Date.now());
      window.location.assign(st.go);
      return true;
    }
    if (st.merge) setMerge(st.merge);
    if (st.notice) setNotice((n) => (keepNotice && n ? n : (st.notice ?? null)));
    if (st.reload) void load();
    return false;
  };

  /** 제안을 읽어 카드를 그린다. 재인증 토큰이 있으면(돌아온 뒤) 확인 창을 연다 */
  const openMerge = async (id: string, token?: MergeState['token'], keepNotice = false) => {
    setMerge({ id, view: null, phase: 'loading' });
    return apply(mergeAfterGet(id, await api.getMerge(id), token), keepNotice);
  };

  useEffect(() => {
    // 병합 제안 ID와 추가 결과는 처음 그릴 때 읽었다. 주소창에서 지워, 카드를 닫은 뒤 새로 고쳐도 다시 뜨지 않고 그 방문 기록 항목에 남지 않게 한다(BOT-043이 넘긴 것)
    const clean = mergeUrlWithoutProposal(location.pathname, location.search, location.hash);
    if (clean) history.replaceState(null, '', clean);
    void (async () => {
      // 재인증에서 돌아왔으면(탭 저장소의 할 일) 토큰을 한 번 받아 그 일을 잇는다
      const p = takePending(tabStore, Date.now());
      let t: Awaited<ReturnType<typeof api.pickupReauth>> | null = null;
      if (p) {
        setBusy(true);
        t = await api.pickupReauth();
        // 받지 못한 이유마다 문구가 다르다(오래된 인증·계정 불일치 등, 탈퇴 화면과 같다, BOT-041이 넘긴 것)
        if (t.kind !== 'token') setNotice({ tone: 'danger', text: reauthFailureText(t.reason) });
        else if (p.action === 'add') {
          submitForm(linkForm(p.provider, t.token));
          return;
        } else if (p.action === 'unlink') {
          const r = await api.unlink(p.provider, t.token);
          if (r.kind === 'login') return toLogin();
          setNotice(unlinkResultText(r));
        }
      }
      // 열 병합 제안: 합치기 할 일이면 그 제안(받은 토큰과), 아니면 주소의 제안. 할 일과 겹쳐도 한 번 읽는다(새 맥락 리뷰 중간 1, 흐름 시험 mergeToOpen)
      const m = mergeToOpen(p, merge?.id, t);
      if (m && (await openMerge(m.id, m.token, p !== null))) return;
      setBusy(false);
      await load();
    })();
    // 처음 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 합치기 카드가 고를 수 있는 상태(ready)를 벗어나면 합치기용 수단 고르기 창을 닫는다(만료된 제안으로 재인증하러 떠나지 않게, 다시 검토 낮음 1)
  const mergeReady = merge?.phase === 'ready';
  useEffect(() => {
    if (!mergeReady) setPlan((x) => (x?.action === 'merge' ? null : x));
  }, [mergeReady]);

  // 합치기 제안이 끝나는 때 한 번 깨어 만료로 바꾼다(시계는 카드가 그린다, 서버도 10분 뒤 제안을 지운다, 새 맥락 리뷰 낮음 7)
  const endsAt = merge?.phase === 'ready' ? merge.view?.expiresAt : undefined;
  useEffect(() => {
    if (endsAt === undefined) return;
    const h = setTimeout(
      () => setMerge((m) => (m && m.phase === 'ready' && m.view && m.view.expiresAt <= Date.now() ? { id: m.id, view: m.view, phase: 'expired' } : m)),
      Math.min(Math.max(0, endsAt - Date.now()) + 50, 2_147_000_000),
    );
    return () => clearTimeout(h);
  }, [endsAt]);

  // 재인증으로 떠난 뒤 뒤로 가기 캐시(bfcache)로 그대로 돌아오면 누름 잠금을 푼다(확인 필요 11)
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      // 떠나기 전 목록을 읽지 않았을 수 있다(추가 할 일은 목록보다 먼저 떠난다): 목록을 다시 읽는다(다시 검토 낮음 3)
      setBusy(false);
      void load();
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  /**
   * 재인증으로 떠난다(떠나기 직전에 토큰을 갱신, 만료된 토큰이면 재인증 시작이 막다른 페이지가 된다).
   * 갱신이 401일 때만 로그인 화면이고, 일시 장애면 떠나지 않고 수단 고르기 창을 닫은 뒤 목록 위에 '잠시 뒤 다시'를 보인다(새 맥락 리뷰)
   */
  const reauthWith = async (via: Provider, what: Plan | null = plan) => {
    if (!what || busy) return;
    setBusy(true);
    const at = Date.now();
    const r = await leaveForReauth({
      api,
      storage: tabStore,
      pending: what.action === 'merge' ? { action: 'merge', provider: via, proposalId: what.proposalId, at } : { ...what, at },
      provider: via,
      submit: submitForm,
    });
    if (r === 'left') return;
    if (r === 'login') return toLogin();
    setBusy(false);
    setPlan(null);
    setNotice({ tone: 'danger', text: REAUTH_START_UNAVAILABLE });
  };

  const continueMerge = () => {
    if (!merge || !methods?.length || busy) return;
    setNotice(null);
    const what: Plan = { action: 'merge', proposalId: merge.id };
    if (methods.length === 1) void reauthWith(methods[0]!.provider, what);
    else setPlan(what);
  };

  const confirmMerge = async () => {
    if (!merge?.token || !merge.view || busy) return;
    setBusy(true);
    const r = await api.confirmMerge(merge.id, merge.token.token);
    if (apply(mergeAfterConfirm(merge, r))) return;
    setBusy(false);
  };

  const card =
    merge && merge.phase !== 'dismissed' ? (
      <LiveMergeCard
        merge={{ ...merge, phase: merge.phase }}
        methods={(methods ?? []).map((m) => m.provider)}
        busy={busy}
        onContinue={continueMerge}
        onConfirm={() => void confirmMerge()}
        onCancelConfirm={() => setMerge({ id: merge.id, view: merge.view, phase: merge.phase })}
        onDismiss={() => setMerge({ id: merge.id, view: merge.view, phase: 'dismissed' })}
      />
    ) : null;

  if (methods === null) {
    // 불러오지 못했으면 안내와 [다시 불러오기](돌기만 하지 않게, 새 맥락 리뷰 낮음 2)
    if (loadFailed)
      return (
        <>
          <section className={`col gap-3 px-4 pt-4 ${CARD_FROM_MD}`} aria-labelledby={`${ids}-h`}>
            <h2 id={`${ids}-h`} className="section-title">
              연결된 로그인 수단
            </h2>
            {notice ? (
              // 방금 한 일(해제·추가)의 결과는 목록을 못 불러와도 보인다(다시 검토 낮음)
              <div className={`banner banner-${notice.tone}`} role={notice.tone === 'success' ? 'status' : 'alert'}>
                <i className={`ic ${notice.tone === 'success' ? 'ic-check-circle' : 'ic-alert-circle'}`} aria-hidden="true" />
                <div className="banner-body">{notice.text}</div>
              </div>
            ) : null}
            <div className="banner banner-danger" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              <div className="banner-body">로그인 수단을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요</div>
            </div>
            <button className="btn btn-secondary" type="button" onClick={() => void load()}>
              다시 불러오기
            </button>
          </section>
          {/* 목록을 못 불러와도 합치기 카드·확인 창은 그대로 둔다(새 맥락 리뷰 낮음 10) */}
          {card}
        </>
      );
    return <div className="spinner m-auto my-8" role="status" aria-label="불러오는 중" />;
  }
  const linked = new Set(methods.map((m) => m.provider));
  const addable = PROVIDERS.filter((p) => !linked.has(p));
  const lastOne = methods.length === 1;
  const lastId = `${ids}-last`;
  const planText = plan ? (plan.action === 'merge' ? '계정 합치기' : plan.action === 'unlink' ? `${PROVIDER_NAME[plan.provider]} 연결 해제` : `${PROVIDER_NAME[plan.provider]} 추가`) : '';

  return (
    <>
      <section className={`col gap-2 px-4 pt-4 ${CARD_FROM_MD}`} aria-labelledby={`${ids}-h`}>
        <div className="section-title">
          <h2 id={`${ids}-h`}>연결된 로그인 수단</h2>
        </div>
        {notice ? (
          <div className={`banner banner-${notice.tone}`} role={notice.tone === 'success' ? 'status' : 'alert'}>
            <i className={`ic ${notice.tone === 'success' ? 'ic-check-circle' : 'ic-alert-circle'}`} aria-hidden="true" />
            <div className="banner-body">{notice.text}</div>
          </div>
        ) : null}
        <ul className="col">
          {methods.map((m) => (
            <li className="li" key={m.provider}>
              <span className={`btn btn-${m.provider}`} aria-hidden="true" style={{ width: 40, height: 40, padding: 0, ...(m.provider === 'naver' ? { borderRadius: '50%' } : null) }}>
                <i className={`prov prov-${m.provider}`} />
              </span>
              <span className="col grow" style={{ gap: 2 }}>
                <span className="li-title">{PROVIDER_NAME[m.provider]}</span>
                <span className="li-sub">
                  처음 연결 {dayText(m.linkedAt)} · 최근 로그인 {dayText(m.lastLoginAt) ?? '기록 없음'}
                </span>
              </span>
              <button
                className="btn btn-outline btn-sm"
                type="button"
                aria-label={`${PROVIDER_NAME[m.provider]} 연결 해제`}
                aria-disabled={lastOne || busy ? true : undefined}
                aria-describedby={lastOne ? lastId : undefined}
                onClick={() => {
                  if (lastOne || busy) return;
                  setNotice(null);
                  setPlan({ action: 'unlink', provider: m.provider });
                }}
              >
                연결 해제
              </button>
            </li>
          ))}
        </ul>
        {lastOne ? (
          <NoticeBanner id={lastId} tone="warning" className="md:mt-1">
            마지막 로그인 수단은 해제할 수 없습니다
          </NoticeBanner>
        ) : null}
        <div className="flex flex-col gap-2 md:mt-2 md:flex-row md:items-center md:justify-between md:gap-4">
          <p className="t-xs muted">연결을 해제하거나 수단을 추가하기 전에 다시 로그인합니다.</p>
          {addable.length ? (
            <button className="btn btn-secondary btn-block mt-2 md:mt-0 md:w-auto" type="button" aria-expanded={choosingAdd} aria-disabled={busy ? true : undefined} onClick={() => !busy && setChoosingAdd((v) => !v)}>
              <i className="ic ic-plus" aria-hidden="true" />
              로그인 수단 추가
            </button>
          ) : null}
        </div>
        {choosingAdd ? (
          <div className="col" style={{ gap: 8 }} role="group" aria-label="추가할 로그인 수단">
            {addable.map((p) => (
              <button
                key={p}
                className={`btn btn-${p} btn-block`}
                type="button"
                onClick={() => {
                  setChoosingAdd(false);
                  setNotice(null);
                  setPlan({ action: 'add', provider: p });
                }}
              >
                <i className={`prov prov-${p}`} aria-hidden="true" />
                {PROVIDER_NAME[p]} 추가
              </button>
            ))}
          </div>
        ) : null}

        <WebShellModal open={plan !== null} onClose={() => !busy && setPlan(null)} title="다시 로그인하고 계속" icon={<i className="ic ic-shield" aria-hidden="true" />} iconTone="primary" describedBy={`${ids}-ra`} maxWidth={440}>
          <p className="t-sm" id={`${ids}-ra`}>
            {planText}
            {plan?.action === 'merge' ? '는 두 계정을 하나로 합치는 작업이라' : '는 계정의 로그인 방법을 바꾸는 작업이라'} 로그인한 분이 맞는지 한 번 더 확인합니다. 지금 계정에 연결된 로그인 수단으로 다시 로그인해 주세요.
          </p>
          <p className="t-sm muted">다시 로그인한 뒤 5분 안에 마쳐야 합니다.</p>
          <div className="col" style={{ gap: 8 }}>
            {methods.map((m) => (
              <button key={m.provider} className={`btn btn-${m.provider} btn-lg btn-block`} type="button" aria-disabled={busy ? true : undefined} onClick={() => void reauthWith(m.provider)}>
                <i className={`prov prov-${m.provider}`} aria-hidden="true" />
                {PROVIDER_NAME[m.provider]}로 다시 로그인하고 계속
              </button>
            ))}
            <button className="btn btn-ghost btn-block" type="button" onClick={() => !busy && setPlan(null)}>
              닫기
            </button>
          </div>
        </WebShellModal>
      </section>
      {card}
    </>
  );
}
