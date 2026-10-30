// SCR-020 설정 › 내 계정(/settings/account, d5 §6.1 ⑦, 보드 SCR-020 isAccount 구역).
// 보안 설정 바꾸기는 모두 CMP-064 admin 재인증 뒤. '유휴 만료 2분 전 경고'·'유휴 만료'는 셸이 대화상자를 연다.
import type { ReactNode } from 'react';
import { stellaOrg } from '@/entities/partner-org';
import { me, PARTNER_ROLE_LABEL } from '@/entities/partner-user';
import { routes } from '@/shared/config/routes';
import { ACCOUNT_STATES } from '@/shared/config/states/scr020-settings';
import { readPreview, type RouteProps } from '@/shared/lib/preview';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { accountSecurity, loginDevices } from '../model/settings';
import { ReauthDialog } from './dialogs';
import { SettingsFrame } from './SettingsFrame';

/** 보안 한 줄: 데스크톱은 왼쪽 설명 · 오른쪽 버튼, 휴대폰은 제목 줄 오른쪽에 버튼(같은 격자로 둘 다 맞는다) */
function SecurityRow({ title, action, children, wideBody }: { title: string; action: ReactNode; children: ReactNode; wideBody?: boolean }) {
  return (
    <div
      className="grid items-start gap-x-4 gap-y-1"
      style={{ gridTemplateColumns: 'minmax(0,1fr) auto', padding: '14px 0', borderTop: '1px solid var(--border)' }}
    >
      <h3 className="t-md fw-b" style={{ gridColumn: 1 }}>
        {title}
      </h3>
      <div style={{ gridColumn: 2, gridRow: 1 }}>{action}</div>
      <div className={`col col-start-1 ${wideBody ? 'max-md:col-span-2 gap-2' : 'gap-1'}`} style={{ alignItems: 'flex-start' }}>
        {children}
      </div>
    </div>
  );
}

function ReauthButton({ modal, children, label, describedBy = 'ac-ra' }: { modal: string; children: ReactNode; label?: string; describedBy?: string }) {
  return (
    <button className="btn btn-outline btn-sm" type="button" aria-haspopup="dialog" aria-describedby={describedBy} aria-label={label} data-modal-open={modal}>
      {children}
    </button>
  );
}

export default async function AccountPage({ searchParams }: RouteProps) {
  const pv = readPreview(await searchParams, ACCOUNT_STATES, '내 계정');
  const isAdmin = !pv.isMember;
  const lastPasskey = accountSecurity.passkeys.length === 1;

  return (
    <>
      <SettingsFrame current="account" isMember={pv.isMember} keep={pv.keep}>
        <div className="page-head">
          <div className="col" style={{ gap: 4 }}>
            <h1>내 계정</h1>
            <p className="t-sm muted" id="ac-ra">
              보안 설정은 바꾸기 전에 비밀번호와 인증 앱 코드로 다시 인증합니다(5분 안에 한 번).
            </p>
          </div>
        </div>

        <section className="card pad-lg col max-md:p-4" style={{ gap: 16 }} aria-labelledby="h-prof">
          <div className="row" style={{ gap: 12 }}>
            <span className="avatar" style={{ width: 40, height: 40, fontSize: 15 }} aria-hidden="true">
              {me.avatarText}
            </span>
            <h2 className="t-lg" id="h-prof">
              프로필
            </h2>
          </div>
          <dl className="kv md:grid-cols-[132px_minmax(0,1fr)] md:[&_dd]:text-left">
            <dt>이름 표시</dt>
            <dd>{me.displayName}</dd>
            <dt>업무용 이메일</dt>
            <dd className="mono">{me.emailMasked}</dd>
            <dt>역할</dt>
            <dd>
              <span className="badge badge-outline">{PARTNER_ROLE_LABEL[pv.role]}</span>
            </dd>
            <dt>소속</dt>
            <dd>{stellaOrg.name}</dd>
          </dl>
        </section>

        <section className="card col px-6 pb-1.5 pt-5 max-md:px-4 max-md:pb-1 max-md:pt-4" aria-labelledby="h-sec">
          <h2 className="t-lg" id="h-sec" style={{ paddingBottom: 14 }}>
            보안
          </h2>
          <SecurityRow title="비밀번호" action={<ReauthButton modal="ra-password">비밀번호 바꾸기</ReauthButton>}>
            <p className="t-sm">마지막 변경 {accountSecurity.passwordChangedAt}</p>
            <p className="t-xs muted">15자 이상 · 문자 조합 규칙 없음 · 유출된 적 있는 비밀번호는 쓸 수 없습니다</p>
          </SecurityRow>
          <SecurityRow title="인증 앱" action={<ReauthButton modal="ra-totp">인증 앱 다시 등록</ReauthButton>}>
            <span className="badge badge-success">
              <i className="ic ic-check" aria-hidden="true" />
              등록됨 {accountSecurity.totpRegisteredAt}
            </span>
            <p className="t-xs muted">로그인할 때마다 인증 앱의 6자리 코드를 씁니다</p>
          </SecurityRow>
          <SecurityRow
            title="패스키"
            wideBody
            action={
              <ReauthButton modal="ra-passkey" describedBy="pk-h ac-ra">
                패스키 등록
              </ReauthButton>
            }
          >
            {accountSecurity.passkeys.map((k) => (
              <div
                key={k.id}
                className="row"
                style={{ gap: 10, padding: '6px 6px 6px 12px', borderRadius: 'var(--r-md)', background: 'var(--surface-muted)', alignSelf: 'stretch' }}
              >
                <i className="ic ic-key ic-16 muted" aria-hidden="true" />
                <span className="t-sm grow">
                  {k.name} · {k.registeredAt} 등록
                </span>
                {isAdmin && lastPasskey ? (
                  <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" aria-label={`${k.name} 패스키 지우기`} aria-describedby="pk-last-h">
                    지우기
                  </button>
                ) : (
                  <ReauthButton modal="ra-passkey-del" label={`${k.name} 패스키 지우기`}>
                    지우기
                  </ReauthButton>
                )}
              </div>
            ))}
            {isAdmin && lastPasskey && (
              <p className="row t-xs" id="pk-last-h" style={{ gap: 6, alignItems: 'flex-start' }}>
                <i className="ic ic-info ic-16 muted" aria-hidden="true" />
                파트너 관리자는 패스키가 하나 이상 있어야 합니다. 다른 패스키를 먼저 등록하세요
              </p>
            )}
            <p className="t-xs muted" id="pk-h">
              패스키는 인증 앱을 대신하지 않습니다. 정산 계좌 변경·명단 내려받기·역할 변경을 할 때 한 번 더 확인하는 데 씁니다
            </p>
          </SecurityRow>
          <SecurityRow
            title="복구 코드"
            action={
              <ReauthButton modal="ra-recovery" label="복구 코드 다시 만들기">
                다시 만들기
              </ReauthButton>
            }
          >
            <p className="t-sm">남은 코드 {accountSecurity.recoveryCodesLeft}개</p>
            <p className="t-xs muted">인증 앱을 쓸 수 없을 때 코드 하나를 한 번 씁니다</p>
          </SecurityRow>
        </section>

        <section className="card col px-6 pb-1.5 pt-5 max-md:px-4 max-md:pb-1 max-md:pt-3.5" aria-labelledby="h-dev">
          <div className="row between" style={{ paddingBottom: 14 }}>
            <h2 className="t-lg" id="h-dev">
              로그인 기기
            </h2>
            <span className="t-sm muted">최대 2대</span>
          </div>
          {loginDevices.map((d) => (
            <div key={d.id} className="row" style={{ gap: 12, padding: d.current ? '14px 0' : '10px 0', borderTop: '1px solid var(--border)' }}>
              <i className={`ic ${d.icon} muted`} aria-hidden="true" />
              <span className={d.current ? 't-sm fw-b grow' : 't-sm grow'}>{d.current ? `이 기기 · ${d.label}` : d.label}</span>
              {!d.current && (
                <ReauthButton modal="ra-device" label={`${d.label.split(' · ').slice(0, 2).join(' · ')} 로그아웃`}>
                  로그아웃
                </ReauthButton>
              )}
            </div>
          ))}
        </section>
      </SettingsFrame>

      <ReauthDialog id="ra-password" defaultOpen={pv.state === '보안 설정 재인증'} before="비밀번호를 바꾸기 전에" submitLabel="다시 인증하고 비밀번호 바꾸기" />
      {/* 아래 넷은 보드에 그려진 비밀번호 대화상자와 같은 문형으로 둔 추천안(d5 §6.1 '보안 설정 재인증': 비밀번호·인증 앱·패스키·복구 코드·로그인 기기 변경) */}
      <ReauthDialog id="ra-totp" before="인증 앱을 다시 등록하기 전에" submitLabel="다시 인증하고 인증 앱 다시 등록" />
      <ReauthDialog id="ra-passkey" before="패스키를 등록하기 전에" submitLabel="다시 인증하고 패스키 등록" />
      <ReauthDialog id="ra-passkey-del" before="패스키를 지우기 전에" submitLabel="다시 인증하고 패스키 지우기" />
      <ReauthDialog id="ra-recovery" before="복구 코드를 다시 만들기 전에" submitLabel="다시 인증하고 복구 코드 다시 만들기" />
      <ReauthDialog id="ra-device" before="다른 기기를 로그아웃하기 전에" submitLabel="다시 인증하고 로그아웃" />

      <PreviewStateSwitcher path={routes.settingsAccount()} states={ACCOUNT_STATES} current={pv.state} keep={pv.keep} />
    </>
  );
}
