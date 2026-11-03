// SCR-020 설정 › 정산 계좌(/settings/payout, d5 §6.1 ⑥, 보드 SCR-020 isPayout 구역).
// [계좌 바꾸기](파트너 관리자) → 재인증(비밀번호·인증 앱 코드) → 패스키 확인 → '정산 계좌 바꾸기'(CMP-062 payout) → 완료.
// 휴대폰은 안내 카드(d5 §3.9 범위 밖)라 대화상자를 열지 않는다.
import { stellaOrg } from '@/entities/partner-org';
import { routes } from '@/shared/config/routes';
import { PAYOUT_STATES } from '@/shared/config/states/scr020-settings';
import { readPreview, type RouteProps } from '@/shared/lib/preview';
import { BigScreenNotice } from '@/shared/ui/BigScreenNotice';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { payoutHoldUntil } from '../model/settings';
import { PasskeyDialog, PayoutChangeDialog, ReauthDialog } from './dialogs';
import { SettingsFrame, withKeep } from './SettingsFrame';

export default async function PayoutPage({ searchParams }: RouteProps) {
  const pv = readPreview(await searchParams, PAYOUT_STATES, '정산 계좌');
  const st = pv.state;
  const done = st === '정산 계좌 변경 완료';
  const mismatch = st === '포트원 계좌 불일치';
  const pkFail = st === '패스키 확인 실패';
  const showPk = st === '정산 계좌 변경 · 패스키 확인' || pkFail;
  const holderErr = st === '예금주 불일치';
  const showChange = st === '정산 계좌 변경' || holderErr;
  const po = stellaOrg.payout;
  const [mask, last4] = [po.accountMasked.slice(0, -4), po.accountMasked.slice(-4)];

  return (
    <>
      <SettingsFrame current="payout" isMember={pv.isMember} keep={pv.keep}>
        <div className="page-head">
          <div className="col" style={{ gap: 4, flex: '1 1 320px', minWidth: 0 }}>
            <h1>정산 계좌</h1>
            <p className="t-sm muted" id="po-reauth-h">
              바꾸기 전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다. 계좌번호는 결제사 지급대행 등록에만 넘기고 PEAKET에는
              은행과 끝 4자리만 남깁니다. 바꾸면 등록 이메일과 전화로 알립니다.
            </p>
          </div>
          {pv.isMember ? (
            <button className="btn btn-outline max-md:hidden" type="button" aria-disabled="true" aria-describedby="po-role-h">
              계좌 바꾸기
            </button>
          ) : (
            <button className="btn btn-outline max-md:hidden" type="button" aria-haspopup="dialog" aria-describedby="po-reauth-h" data-modal-open="po-reauth">
              계좌 바꾸기
            </button>
          )}
        </div>

        {pv.isMember ? (
          <>
            <p className="row t-sm tx-warning max-md:hidden" id="po-role-h" style={{ gap: 6 }}>
              <i className="ic ic-lock ic-16" aria-hidden="true" />이 작업은 파트너 관리자만 할 수 있습니다
            </p>
            <div className="banner banner-warning md:hidden" role="note">
              <i className="ic ic-lock" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">정산 계좌 바꾸기</span>이 작업은 파트너 관리자만 할 수 있습니다
              </div>
            </div>
          </>
        ) : (
          <BigScreenNotice title="정산 계좌 바꾸기는 태블릿이나 데스크톱에서 합니다" />
        )}

        {done && (
          <div className="banner banner-success" role="status">
            <i className="ic ic-check-circle" aria-hidden="true" />
            <div className="banner-body">변경했습니다. {payoutHoldUntil}까지 지급이 보류됩니다</div>
          </div>
        )}
        {mismatch && (
          <div className="banner banner-warning" role="status">
            <i className="ic ic-alert" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">포트원 결제분 지급 보류(계좌 불일치)</span>계좌를 다시 내 주세요. 대조가 맞은 뒤 3영업일 뒤 지급합니다
            </div>
          </div>
        )}

        <section className="card pad-lg col gap-4 max-md:gap-3 max-md:p-4" aria-labelledby="h-po">
          <h2 className="t-lg" id="h-po">
            정산금 지급 계좌
          </h2>
          <dl className="kv md:grid-cols-[132px_minmax(0,1fr)] md:[&_dd]:text-left" style={{ alignItems: 'center' }}>
            <dt>은행</dt>
            <dd>{po.bank}</dd>
            <dt>계좌</dt>
            <dd className="num">
              <span aria-hidden="true">{mask}</span>
              {last4}
              <span className="sr-only">(끝 4자리)</span>
            </dd>
            <dt>예금주</dt>
            <dd>
              <span className="flex flex-col items-end gap-1 md:flex-row md:flex-wrap md:items-center md:gap-2">
                {po.holder}
                {po.holderVerified && (
                  <span className="badge badge-success">
                    <i className="ic ic-check" aria-hidden="true" />
                    예금주 확인 완료
                  </span>
                )}
              </span>
            </dd>
            <dt>지급 보류</dt>
            <dd>
              {done ? (
                <span className="badge badge-warning">
                  <i className="ic ic-clock" aria-hidden="true" />
                  {payoutHoldUntil}까지 보류(계좌 변경)
                </span>
              ) : mismatch ? (
                <span className="badge badge-warning max-md:whitespace-normal max-md:text-right">
                  <i className="ic ic-alert" aria-hidden="true" />
                  포트원 결제분 지급 보류(계좌 불일치)
                </span>
              ) : (
                po.hold
              )}
            </dd>
          </dl>
          <div className="banner banner-info">
            <i className="ic ic-info" aria-hidden="true" />
            <div className="banner-body">예금주가 판매자 상호나 대표자와 같은 계좌만 받습니다 · 바꾸면 3영업일 동안 지급이 보류됩니다</div>
          </div>
        </section>
      </SettingsFrame>

      {!pv.isMember && (
        <div className="max-md:hidden">
          <ReauthDialog
            id="po-reauth"
            steps
            before="정산 계좌를 바꾸기 전에"
            body="정산 계좌를 바꾸기 전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다."
            submitLabel="다시 인증"
            next="po-passkey"
          />
          <PasskeyDialog id="po-passkey" defaultOpen={showPk} failed={pkFail} next="po-change" />
          <PayoutChangeDialog
            id="po-change"
            defaultOpen={showChange}
            holderError={holderErr}
            doneHref={withKeep(routes.settingsPayout(), pv.keep, { state: '정산 계좌 변경 완료' })}
          />
        </div>
      )}

      <PreviewStateSwitcher path={routes.settingsPayout()} states={PAYOUT_STATES} current={st} keep={pv.keep} />
    </>
  );
}
