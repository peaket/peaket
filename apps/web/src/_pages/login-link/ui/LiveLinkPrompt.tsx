'use client';
// SCR-039 계정 연결 제안의 실제 흐름(docs/features/identity.md §2.1 '가입 때 연결 제안의 첫 구현', BUILD_ORDER BOT-040, I-T29·I-T30).
// 콜백이 보낸 주소의 값으로 상태를 고른다: ?proposal=(제안, &mismatch=남은 시도), ?link=expired(만료), ?linked=제공자&next=(연결 성공).
// 제안 ID는 주소에 있어도 되고, 묶음 값은 앱 서버의 연결 제안 쿠키에만 있다. 닉네임·이메일은 보이지 않는다(밖에서 다른 사람 계정을 캐내지 못하게).
import { AccountLinkPrompt, type AccountLinkProvider, type AccountLinkStatus } from '@peaket/ds/AccountLinkPrompt';
import { Toast } from '@peaket/ds/Toast';
import { useEffect, useRef, useState } from 'react';
import { PROVIDER_LOGIN_LABEL, PROVIDER_NAME } from '@/entities/provider';
import { DeviceIdInput } from '@/features/social-login';
import { deviceId } from '@/shared/lib/device-id';
import { renderNextLink } from '@/shared/lib/next-link';
import { safeNext } from '@/shared/lib/safe-next';

type Provider = AccountLinkProvider;
const PROVIDERS: readonly string[] = ['kakao', 'naver', 'google'];
const isProvider = (v: unknown): v is Provider => typeof v === 'string' && PROVIDERS.includes(v);
/** 연결 성공을 보인 뒤 원래 화면으로 가기까지 [가정](토스트를 읽을 시간) */
export const LINKED_PAUSE_MS = 1_500;

export interface LiveLinkProps {
  proposalId?: string;
  mismatchLeft?: number;
  expired?: boolean;
  linked?: string;
  next?: string;
}

interface Proposal {
  existingProvider: Provider;
  newProvider: Provider;
  expiresAt: number;
  attemptsLeft: number;
}

export function LiveLinkPrompt(props: LiveLinkProps) {
  if (props.linked !== undefined && isProvider(props.linked)) return <Linked provider={props.linked} next={safeNext(props.next)} />;
  if (props.expired || !props.proposalId) return <Card status="expired" />;
  return <Proposed id={props.proposalId} mismatchLeft={props.mismatchLeft} />;
}

function Linked({ provider, next }: { provider: Provider; next: string }) {
  useEffect(() => {
    const t = setTimeout(() => window.location.replace(next), LINKED_PAUSE_MS);
    return () => clearTimeout(t);
  }, [next]);
  return (
    <>
      <h1 className="sr-only">계정 연결 완료</h1>
      <div className="col w-full md:max-w-[720px]" aria-busy="true" style={{ gap: 14 }}>
        <span className="sr-only">원래 화면으로 돌아가는 중</span>
        <span className="skel" style={{ height: 220 }} />
        <span className="skel" style={{ height: 24, width: '72%' }} />
        <span className="skel" style={{ height: 16, width: '48%' }} />
      </div>
      <div className="center fixed inset-x-4 bottom-6 z-[90]">
        <Toast tone="success">{PROVIDER_NAME[provider]} 계정을 연결했습니다</Toast>
      </div>
    </>
  );
}

function Proposed({ id, mismatchLeft }: { id: string; mismatchLeft?: number }) {
  const [p, setP] = useState<Proposal | null>(null);
  const [status, setStatus] = useState<AccountLinkStatus | 'loading'>('loading');
  const [failText, setFailText] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await fetch(`/v1/identity/link-proposals/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
        if (!live) return;
        if (r.status !== 200) {
          setStatus(r.status === 404 ? 'expired' : 'error');
          if (r.status !== 404) setFailText('지금은 확인할 수 없습니다. 잠시 뒤 다시 시도해 주세요');
          return;
        }
        const b = (await r.json()) as { existingProvider?: unknown; newProvider?: unknown; expiresAt?: unknown; attemptsLeft?: unknown };
        const expiresAt = typeof b.expiresAt === 'string' ? Date.parse(b.expiresAt) : Number.NaN;
        if (!isProvider(b.existingProvider) || !isProvider(b.newProvider) || !Number.isFinite(expiresAt) || typeof b.attemptsLeft !== 'number') {
          setStatus('expired');
          return;
        }
        setP({ existingProvider: b.existingProvider, newProvider: b.newProvider, expiresAt, attemptsLeft: b.attemptsLeft });
        setStatus(mismatchLeft !== undefined ? 'error' : 'proposed');
      } catch {
        if (live) {
          setStatus('error');
          setFailText('지금은 확인할 수 없습니다. 잠시 뒤 다시 시도해 주세요');
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [id, mismatchLeft]);

  // 제공자 화면에서 뒤로 와 페이지가 그대로 복원되면(bfcache) 누른 뒤의 '확인 중'을 되돌린다(새 맥락 리뷰 낮음 8)
  useEffect(() => {
    const back = (e: PageTransitionEvent) => {
      if (e.persisted) setStatus((s) => (s === 'verifying' ? (mismatchLeft !== undefined ? 'error' : 'proposed') : s));
    };
    window.addEventListener('pageshow', back);
    return () => window.removeEventListener('pageshow', back);
  }, [mismatchLeft]);

  // 남은 시간: 1초마다 다시 그리고, 다 되면 만료
  useEffect(() => {
    if (!p) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [p]);
  const remaining = p ? Math.max(0, Math.floor((p.expiresAt - now) / 1000)) : 0;
  if (p && remaining === 0 && status !== 'expired') return <Card status="expired" />;
  if (status === 'loading') return <div className="spinner m-auto" role="status" aria-label="불러오는 중" />;
  if (status === 'expired' || !p) {
    if (status === 'error' && failText) return <Card status="error" failText={failText} />;
    return <Card status="expired" />;
  }

  const existing = PROVIDER_NAME[p.existingProvider];
  const incoming = PROVIDER_NAME[p.newProvider];
  const login = () => {
    setStatus('verifying');
    form.current?.requestSubmit();
  };
  const separate = async () => {
    setStatus('verifying');
    try {
      const r = await fetch(`/v1/identity/link-proposals/${encodeURIComponent(id)}/separate-account`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ deviceId: deviceId() ?? '' }).toString(),
      });
      if (r.status === 201) {
        const b = (await r.json()) as { next?: unknown };
        window.location.assign(safeNext(b.next));
        return;
      }
      if (r.status === 404) {
        setStatus('expired');
        return;
      }
      setFailText('지금은 처리할 수 없습니다. 잠시 뒤 다시 시도해 주세요');
      setStatus('error');
    } catch {
      setFailText('지금은 처리할 수 없습니다. 잠시 뒤 다시 시도해 주세요');
      setStatus('error');
    }
  };
  const mismatchText = `다른 계정입니다. 처음 가입한 ${existing} 계정으로 로그인해 주세요 (남은 시도 ${p.attemptsLeft}회)`;

  return (
    <div className="col m-auto w-full max-w-[400px] md:rounded-(--r-xl) md:border md:border-(--border) md:bg-(--surface) md:px-7 md:pt-8 md:pb-7">
      {/* [기존 제공자 로그인]은 제안 ID를 실은 로그인 시작 양식이다(돌아갈 주소는 연결 제안 쿠키의 것을 쓴다) */}
      <form ref={form} method="post" action={`/login/${p.existingProvider}`} hidden>
        <input type="hidden" name="linkProposal" value={id} />
        <input type="hidden" name="returnTo" value="/" />
        <DeviceIdInput />
      </form>
      <AccountLinkPrompt
        status={status}
        title="계정 연결"
        message={`이 이메일로 가입한 계정이 있습니다(${existing} 로그인). 연결하면 다음부터 ${incoming}로도 같은 계정에 로그인되고 티켓과 주문은 그대로입니다`}
        accountLabel="이미 가입한 계정"
        account={[{ term: '로그인 수단', value: existing }]}
        errorText={failText ?? mismatchText}
        instruction={`처음 가입한 ${existing} 계정으로 로그인하면 연결됩니다`}
        provider={p.existingProvider}
        providerLabel={PROVIDER_LOGIN_LABEL[p.existingProvider]}
        newAccount={{ label: '새 계정 만들기', href: '/login' }}
        remaining={remaining}
        close={{ label: '창 닫기', href: '/login' }}
        expired={{ title: '시간이 지났습니다. 다시 로그인해 주세요', actionLabel: '로그인', actionHref: '/login' }}
        renderLink={renderNextLink}
        onProvider={login}
        onNewAccount={() => void separate()}
      />
    </div>
  );
}

function Card({ status, failText }: { status: 'expired' | 'error'; failText?: string }) {
  if (status === 'error')
    return (
      <div className="col m-auto w-full max-w-[400px]" style={{ gap: 16 }}>
        <h1 className="t-lg">계정 연결</h1>
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">{failText}</div>
        </div>
        <a className="link-more" href="/login">
          로그인으로 돌아가기
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </a>
      </div>
    );
  return (
    <div className="col m-auto w-full max-w-[400px]">
      <AccountLinkPrompt
        status="expired"
        title="계정 연결"
        message=""
        accountLabel=""
        account={[]}
        instruction=""
        provider="kakao"
        providerLabel=""
        newAccount={{ label: '', href: '/login' }}
        remaining={0}
        close={{ label: '', href: '/login' }}
        expired={{ title: '시간이 지났습니다. 다시 로그인해 주세요', actionLabel: '로그인', actionHref: '/login' }}
        renderLink={renderNextLink}
      />
    </div>
  );
}
