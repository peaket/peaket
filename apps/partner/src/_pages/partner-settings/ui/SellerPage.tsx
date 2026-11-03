// SCR-020 설정 › 판매자 정보(/settings/seller, d5 §6.1 ⑧, 보드 SCR-020 isSeller 구역).
// [변경 요청]은 파트너 관리자만(실무자는 이유 있는 비활성), 휴대폰은 안내 카드(d5 §3.9 범위 밖).
import Link from 'next/link';
import { SELLER_FIELDS, stellaOrg } from '@/entities/partner-org';
import { routes } from '@/shared/config/routes';
import { SELLER_STATES } from '@/shared/config/states/scr020-settings';
import { readPreview, type RouteProps } from '@/shared/lib/preview';
import { BigScreenNotice } from '@/shared/ui/BigScreenNotice';
import { Modal } from '@/shared/ui/Modal';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { sellerChangeRequest } from '../model/settings';
import { CancelButton, SHEET_ACTIONS, SHEET_PRIMARY } from './dialogs';
import { SettingsFrame, withKeep } from './SettingsFrame';

export default async function SellerPage({ searchParams }: RouteProps) {
  const pv = readPreview(await searchParams, SELLER_STATES, '판매자 정보');
  const isReview = pv.state === '판매자 정보 검토 중';
  const seller = stellaOrg.seller;

  return (
    <>
      <SettingsFrame current="seller" isMember={pv.isMember} keep={pv.keep}>
        <div className="page-head">
          <div className="col" style={{ gap: 4, flex: '1 1 320px', minWidth: 0 }}>
            <h1>판매자 정보</h1>
            <p className="t-sm muted" id="sl-req-h">
              상호·대표자 변경은 변경 요청 뒤 PEAKET 운영자가 판매자 정보를 다시 확인합니다.
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {isReview && (
              <span className="badge badge-warning badge-lg">
                <i className="ic ic-clock" aria-hidden="true" />
                검토 중 · {sellerChangeRequest.requestedAt} 요청
              </span>
            )}
            {pv.isMember ? (
              <button className="btn btn-outline max-md:hidden" type="button" aria-disabled="true" aria-describedby="sl-role-h">
                변경 요청
              </button>
            ) : (
              <button className="btn btn-outline max-md:hidden" type="button" aria-haspopup="dialog" aria-describedby="sl-req-h" data-modal-open="seller-req">
                변경 요청
              </button>
            )}
          </div>
        </div>

        {pv.isMember ? (
          <>
            <p className="row t-sm tx-warning max-md:hidden" id="sl-role-h" style={{ gap: 6 }}>
              <i className="ic ic-lock ic-16" aria-hidden="true" />
              변경 요청은 파트너 관리자만 할 수 있습니다
            </p>
            <div className="banner banner-warning md:hidden" role="note">
              <i className="ic ic-lock" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">판매자 정보 변경 요청</span>변경 요청은 파트너 관리자만 할 수 있습니다
              </div>
            </div>
          </>
        ) : (
          <BigScreenNotice title="판매자 정보 변경 요청은 태블릿이나 데스크톱에서 합니다" />
        )}

        {isReview && (
          <div className="banner banner-warning" role="status">
            <i className="ic ic-clock" aria-hidden="true" />
            <div className="banner-body">확인이 끝날 때까지 지금 정보가 공연 상세와 결제 화면에 보입니다.</div>
          </div>
        )}

        <section className="card pad-lg col gap-4 max-md:gap-3 max-md:p-4" aria-labelledby="h-seller">
          <div className="banner banner-info">
            <i className="ic ic-info" aria-hidden="true" />
            <div className="banner-body">이 정보는 공연 상세·결제 직전·예매 확인서에 판매자 정보로 보입니다(전자상거래법 §20②).</div>
          </div>
          <h2 className="t-lg" id="h-seller">
            판매자 신원정보 7항목
          </h2>
          <dl className="kv md:grid-cols-[160px_minmax(0,1fr)] md:[&_dd]:text-left">
            {SELLER_FIELDS.map((f) => (
              <div key={f.key} className="contents">
                <dt>{f.label}</dt>
                <dd>{seller[f.key]}</dd>
              </div>
            ))}
          </dl>
          <div className="col" style={{ gap: 4 }}>
            <p className="t-xs muted">마지막 확인 {seller.lastVerifiedAt} · PEAKET 판매 승인에 쓰인 값</p>
            <p className="t-xs muted">통신판매업 신고번호가 없으면 면제 근거를 적습니다.</p>
          </div>
        </section>
      </SettingsFrame>

      {!pv.isMember && (
        // 변경 요청은 태블릿·데스크톱에서만(휴대폰은 위 안내 카드)
        <div className="max-md:hidden">
          <Modal id="seller-req" defaultOpen={pv.state === '판매자 정보 변경 요청'} labelledBy="sr-t" describedBy="sr-w" maxWidth={520} sheetOnMobile={false}>
            <h2 className="dialog-title" id="sr-t">
              판매자 정보 변경 요청
            </h2>
            <fieldset className="col">
              <legend className="label" style={{ marginBottom: 10 }}>
                바꿀 항목 (필수)
              </legend>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '10px 16px' }}>
                {SELLER_FIELDS.map((f, i) => (
                  <label key={f.key} className="check-row" htmlFor={`sr-c${i + 1}`}>
                    <input className="cb" id={`sr-c${i + 1}`} type="checkbox" defaultChecked={f.key === sellerChangeRequest.checked} />
                    {f.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="field">
              <label className="label" htmlFor="sr-new">
                대표자 새 값 (필수)
              </label>
              <input className="input" id="sr-new" type="text" autoComplete="off" data-autofocus="" />
            </div>
            <div className="field">
              <label className="label" htmlFor="sr-ref">
                근거 서류 참조 (필수)
              </label>
              <input className="input" id="sr-ref" type="text" autoComplete="off" placeholder="[근거 서류 참조 자리 표시]" aria-describedby="sr-ref-h" />
              <span className="hint" id="sr-ref-h">
                파일은 받지 않습니다
              </span>
            </div>
            <div className="banner banner-warning" id="sr-w">
              <i className="ic ic-alert" aria-hidden="true" />
              <div className="banner-body">
                상호나 대표자를 바꾸면 PEAKET 운영자가 판매자 정보를 다시 확인합니다(POL-039). 확인이 끝날 때까지 지금 정보가 공연 상세와 결제 화면에 보입니다.
              </div>
            </div>
            <div className={SHEET_ACTIONS}>
              <CancelButton>요청하지 않고 닫기</CancelButton>
              <Link className={`btn btn-primary ${SHEET_PRIMARY}`} href={withKeep(routes.settingsSeller(), pv.keep, { state: '판매자 정보 검토 중' })}>
                변경을 요청합니다
              </Link>
            </div>
          </Modal>
        </div>
      )}

      <PreviewStateSwitcher path={routes.settingsSeller()} states={SELLER_STATES} current={pv.state} keep={pv.keep} />
    </>
  );
}
