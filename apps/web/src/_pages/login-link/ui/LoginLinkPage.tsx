// SCR-039 계정 연결 제안(d5 §5.21, d3 SCR-039 행, 캔버스 보드 SCR-039-m·t·d를 한 페이지 반응형으로 합쳤다).
// 로그인 카드와 같은 폭(최대 400). 휴대폰은 바탕 위에 바로, md 768부터 옅은 바탕 가운데 카드. 본문은 ds AccountLinkPrompt(CMP-055).
// 연결 성공은 원래 화면으로 돌아가며 그 화면을 불러오는 뼈대와 토스트 "구글 계정을 연결했습니다"를 보인다(셸은 로그인한 모양).
// 상태는 ?state=(보드 state 값), 다크는 ?theme=dark.
import { AccountLinkPrompt } from '@peaket/ds/AccountLinkPrompt';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { Toast } from '@peaket/ds/Toast';
import { LINK_PROPOSAL, PROVIDER_LOGIN_LABEL, PROVIDER_NAME } from '@/entities/provider';
import { SCR039_STATES } from '@/shared/config/screens.account';
import { renderNextLink } from '@/shared/lib/next-link';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { linkView } from '../model/state';

export async function LoginLinkPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR039_STATES, '제안');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = linkView(state);
  const p = LINK_PROPOSAL;
  const existing = PROVIDER_NAME[p.existing];
  const incoming = PROVIDER_NAME[p.incoming];
  const remaining = v.prompt === 'verifying' ? p.remaining.verifying : v.prompt === 'error' ? p.remaining.mismatch : p.remaining.proposed;

  return (
    <AppShell dark={dark} guest={!v.success}>
      <main
        className="page-main px-4 pt-6 pb-8 md:items-center md:justify-center md:bg-(--surface-basement) md:px-6 md:pt-14 md:pb-[72px] lg:px-8"
        id="main"
        tabIndex={-1}
      >
        {v.prompt ? (
          <div className="col m-auto w-full max-w-[400px] md:rounded-(--r-xl) md:border md:border-(--border) md:bg-(--surface) md:px-7 md:pt-8 md:pb-7">
            <AccountLinkPrompt
              status={v.prompt}
              title="계정 연결"
              message={`이 이메일로 가입한 계정이 있습니다(${existing} 로그인). 연결하면 다음부터 ${incoming}로도 같은 계정에 로그인되고 티켓과 주문은 그대로입니다`}
              accountLabel="이미 가입한 계정"
              account={[
                { term: '로그인 수단', value: existing },
                { term: '이메일', value: p.maskedEmail, mono: true },
              ]}
              errorText={`다른 계정입니다. 처음 가입한 ${existing} 계정으로 로그인해 주세요 (남은 시도 ${p.attemptsLeft}회)`}
              instruction={`처음 가입한 ${existing} 계정으로 로그인하면 연결됩니다`}
              provider={p.existing}
              providerLabel={PROVIDER_LOGIN_LABEL[p.existing]}
              newAccount={{ label: '새 계정 만들기', href: '/signup/consent' }}
              remaining={remaining}
              close={{ label: '창 닫기', href: '/login' }}
              expired={{ title: '시간이 지났습니다. 다시 로그인해 주세요', actionLabel: '로그인', actionHref: '/login' }}
              renderLink={renderNextLink}
            />
          </div>
        ) : null}

        {v.success ? (
          <>
            <h1 className="sr-only">계정 연결 완료</h1>
            <div className="col w-full md:max-w-[720px]" aria-busy="true" style={{ gap: 14 }}>
              <span className="sr-only">원래 화면으로 돌아가는 중</span>
              <span className="skel" style={{ height: 220 }} />
              <span className="skel" style={{ height: 24, width: '72%' }} />
              <span className="skel" style={{ height: 16, width: '48%' }} />
              <span className="skel" style={{ height: 16, width: '60%' }} />
              <span className="skel" style={{ height: 52, marginTop: 8 }} />
            </div>
            <div className="center fixed inset-x-4 bottom-6 z-[90]">
              <Toast tone="success">{incoming} 계정을 연결했습니다</Toast>
            </div>
          </>
        ) : null}
      </main>
      <PreviewSwitcher path="/login/link" states={SCR039_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}
