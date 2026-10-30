'use client';
// SCR-060의 소셜 재인증 시트 둘(CMP-064 fan-social 모양, d5 §3.5·§5.34, 보드 SCR-060-m '재인증 시트'·'재인증 만료').
// SCR-043에도 같은 틀이 있지만 페이지끼리 가져오지 않아(FSD) 이 페이지 것을 따로 둔다.
// 휴대폰은 아래 시트, 태블릿·데스크톱은 가운데 대화상자다(WebShellModal responsive). ds 부품을 따로 두지 않고 이 페이지 안에 둔다.
// 제공자 버튼은 동작이 없다(퍼블리싱 단계): 누르면 시트만 닫힌다.
import { useId } from 'react';
import { WebShellModal } from '@peaket/ds/WebShell';

export type ReauthSheetKind = 'reauth' | 'expired';

const KAKAO = 'btn btn-kakao btn-lg btn-block';
const CLOSE = 'btn btn-ghost btn-block';

export function ReauthSheet({ open, onClose }: { open: ReauthSheetKind | null; onClose: () => void }) {
  const ids = useId();
  const actions = (
    <>
      <button className={KAKAO} type="button" onClick={onClose}>
        <i className="prov prov-kakao" aria-hidden="true" />
        카카오로 다시 로그인하고 계속
      </button>
      <button className={CLOSE} type="button" onClick={onClose}>
        닫기
      </button>
    </>
  );
  return (
    <>
      <WebShellModal
        open={open === 'reauth'}
        onClose={onClose}
        title="다시 로그인하고 계속"
        icon={<i className="ic ic-shield" aria-hidden="true" />}
        iconTone="primary"
        describedBy={`${ids}-ra`}
        actions={actions}
      >
        <p className="t-sm" id={`${ids}-ra`}>
          환급금을 받을 계좌를 정하는 작업이라 로그인한 분이 맞는지 한 번 더 확인합니다. 지금 로그인한 카카오 계정으로 다시 로그인해 주세요.
        </p>
        <p className="t-sm muted">다시 로그인한 뒤 5분 안에 환급 요청을 보내야 합니다.</p>
      </WebShellModal>

      <WebShellModal open={open === 'expired'} onClose={onClose} title="다시 로그인해 주세요" describedBy={`${ids}-ex`} actions={actions}>
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">다시 로그인한 지 5분이 지났습니다. 다시 로그인해 주세요</div>
        </div>
        <p className="t-sm muted" id={`${ids}-ex`}>
          환급 요청은 아직 보내지 않았습니다. 다시 로그인하면 이어서 보낼 수 있습니다.
        </p>
      </WebShellModal>
    </>
  );
}
