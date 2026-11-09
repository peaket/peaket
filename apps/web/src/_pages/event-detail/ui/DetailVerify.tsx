'use client';
// 공연 정보 ③ 본인확인 줄(d5 §5.2 그림 ③, ADR-0202 결정 3, HOT-321). 팬 계정 요약(useFanSession)으로 고른다.
// - 본인확인 완료: '본인확인 <완료>' + 목적 문구
// - 본인확인 전(로그인한 팬): '본인확인이 필요합니다' + 목적 문구 + [ 휴대폰 본인확인 ](이 화면 위 기관 창, 결과는 대화상자, SCR-006)
// - 비로그인·모름: 목적 문구만(입장 버튼이 [[ 로그인하고 입장 ]]이다) · 받기 전: 뼈대
import { useFanSession } from '@/entities/me';
import { VERIFY_PURPOSE } from '../model/content';
import { VerifyButtonLazy } from './VerifyButtonLazy';

export function VerifyStatusRow({ loginHref }: { loginHref: string }) {
  const s = useFanSession();
  if (s.status === 'loading') {
    return (
      <div className="col" style={{ gap: 8 }} aria-busy="true">
        <span className="sr-only">본인확인 상태를 불러오는 중</span>
        <span className="skel" style={{ height: 22, width: 140 }} />
        <span className="skel" style={{ height: 16, width: '90%' }} />
      </div>
    );
  }
  if (s.status === 'member' && s.me.verified) {
    return (
      // 본인확인을 마친 뒤 초점이 오는 자리(data-verify-return, 바뀐 버튼 대신)
      <div className="col" style={{ gap: 4 }} tabIndex={-1} data-verify-return>
        <div className="row" style={{ gap: 10 }}>
          <span className="t-sm fw-b">본인확인</span>
          <span className="badge badge-success">
            <i className="ic ic-check" aria-hidden="true" />
            완료
          </span>
        </div>
        <p className="t-sm muted">{VERIFY_PURPOSE}</p>
      </div>
    );
  }
  if (s.status === 'member') {
    return (
      <div className="banner banner-warning">
        <i className="ic ic-alert" aria-hidden="true" />
        <div className="banner-body col" style={{ gap: 8 }}>
          <span className="banner-title">본인확인이 필요합니다</span>
          <p id="vf-purpose">{VERIFY_PURPOSE}</p>
          <VerifyButtonLazy className="btn btn-outline btn-sm" describedBy="vf-purpose" loginHref={loginHref} style={{ alignSelf: 'flex-start' }}>
            <i className="ic ic-phone" aria-hidden="true" />
            휴대폰 본인확인
          </VerifyButtonLazy>
        </div>
      </div>
    );
  }
  return <p className="t-sm muted">{VERIFY_PURPOSE}</p>;
}
