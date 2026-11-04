'use client';
// SCR-040 ①②③의 실제 흐름(docs/features/identity.md §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BUILD_ORDER BOT-041, I-T33·I-T34).
// 목록을 읽고, [연결 해제]·[로그인 수단 추가]는 먼저 재인증한다(연결한 제공자가 둘 이상이면 고른다). 재인증에서 돌아오면 탭 저장소의 할 일을 잇는다:
// 해제는 DELETE /v1/identity/providers/{p}, 추가는 POST /link/{p}(앱 서버가 새 제공자 인증 뒤 ?loginMethod=로 결과를 돌려준다).
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { useEffect, useId, useState } from 'react';
import { PROVIDER_NAME } from '@/entities/provider';
import {
  addResultText,
  browserLoginMethodsApi,
  dayText,
  type LinkedMethod,
  linkForm,
  markPending,
  PROVIDERS,
  type Provider,
  reauthForm,
  submitForm,
  tabStore,
  takePending,
  unlinkResultText,
} from '@/features/login-methods';
import { WebShellModal } from '@peaket/ds/WebShell';

type Notice = { tone: 'success' | 'warning' | 'danger'; text: string };
type Plan = { action: 'unlink' | 'add'; provider: Provider };

const CARD_FROM_MD = 'md:rounded-(--r-xl) md:border md:border-(--border) md:bg-(--surface) md:px-6 md:py-5';

export function LiveLoginMethods({ loginMethod }: { loginMethod?: string }) {
  const [api] = useState(() => browserLoginMethodsApi());
  const [methods, setMethods] = useState<LinkedMethod[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(() => addResultText(loginMethod ?? null));
  const [plan, setPlan] = useState<Plan | null>(null);
  const [choosingAdd, setChoosingAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 목록을 불러오지 못했다(안내와 다시 불러오기) */
  const [loadFailed, setLoadFailed] = useState(false);
  const ids = useId();
  const toLogin = () => window.location.assign(`/login?next=${encodeURIComponent('/my/settings/providers')}`);

  const load = async () => {
    const r = await api.list();
    if (r.kind === 'ok') {
      setLoadFailed(false);
      setMethods(r.methods);
    } else if (r.kind === 'login') toLogin();
    else setLoadFailed(true);
  };

  useEffect(() => {
    void (async () => {
      // 재인증에서 돌아왔으면(탭 저장소의 할 일) 토큰을 한 번 받아 그 일을 잇는다
      const p = takePending(tabStore, Date.now());
      if (p) {
        setBusy(true);
        const t = await api.pickupReauth();
        if (t.kind !== 'token') {
          setNotice({ tone: 'danger', text: '다시 로그인하지 못했습니다. 다시 시도해 주세요' });
          setBusy(false);
        } else if (p.action === 'add') {
          submitForm(linkForm(p.provider, t.token));
          return;
        } else {
          const r = await api.unlink(p.provider, t.token);
          if (r.kind === 'login') return toLogin();
          setNotice(unlinkResultText(r));
          setBusy(false);
        }
      }
      await load();
    })();
    // 처음 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 재인증으로 떠난다(떠나기 직전에 토큰을 갱신, 만료된 토큰이면 재인증 시작이 막다른 페이지가 된다) */
  const reauthWith = async (via: Provider) => {
    if (!plan || busy) return;
    setBusy(true);
    if (!(await api.refresh())) return toLogin();
    markPending(tabStore, { ...plan, at: Date.now() });
    submitForm(reauthForm(via));
  };

  if (methods === null) {
    // 불러오지 못했으면 안내와 [다시 불러오기](돌기만 하지 않게, 새 맥락 리뷰 낮음 2)
    if (loadFailed)
      return (
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
      );
    return <div className="spinner m-auto my-8" role="status" aria-label="불러오는 중" />;
  }
  const linked = new Set(methods.map((m) => m.provider));
  const addable = PROVIDERS.filter((p) => !linked.has(p));
  const lastOne = methods.length === 1;
  const lastId = `${ids}-last`;

  return (
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
          {plan ? (plan.action === 'unlink' ? `${PROVIDER_NAME[plan.provider]} 연결 해제` : `${PROVIDER_NAME[plan.provider]} 추가`) : ''}는 계정의 로그인 방법을 바꾸는 작업이라 로그인한 분이 맞는지 한 번 더
          확인합니다. 지금 계정에 연결된 로그인 수단으로 다시 로그인해 주세요.
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
  );
}
