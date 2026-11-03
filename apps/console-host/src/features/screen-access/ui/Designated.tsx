// 지정으로 여는 화면(부정 거래 조사 SCR-070·071)의 권한 처리와 휴대폰 범위 밖 안내(d5 §3.3 '지정 메뉴', §3.9).
// 퍼블리싱: 역할·지정을 고르지 않았으면 조사관 도윤(cs_lead, FRAUD_INVESTIGATOR)의 화면으로 그린다. 고른 역할·지정에 조사관 지정이 없으면 '권한 없음(지정 없음)'이다.
// 메뉴 숨김과 이 안내는 화면 장치이고, 막는 것은 서버의 요청마다 지정 확인이다(control-tower §9.2). 데이터 연결 단계에서 이 층은 걷어 낸다(ADR-0170).
import { Link } from 'react-router';
import { PermissionDenied } from '@peaket/ds/PermissionDenied';
import { copyLink } from '@/shared/lib/clipboard';

/** '권한 없음(지정 없음)' — d5 §7.18 상태 표의 문구 */
export function InvestigatorDenied() {
  return (
    <section className="widget" aria-label="권한 없음">
      <PermissionDenied
        variant="inline"
        headingLevel={1}
        title="이 화면을 볼 권한이 없습니다"
        description="부정 거래 조사관 지정이 있는 commander·cs_lead만 엽니다. 지정은 commander가 계정·세션(SCR-064)에서 합니다."
        actions={
          <Link className="btn btn-outline" to="/dashboard">
            대시보드로 가기
          </Link>
        }
        style={{ padding: '64px 16px' }}
      />
    </section>
  );
}

/** 휴대폰 범위 밖 안내 카드(d5 §3.9): 버튼을 숨기지 않고 그 자리에 둔다 */
export function BigScreenNote({ what }: { what: string }) {
  return (
    <div className="banner banner-info bigscreen" role="note">
      <i className="ic ic-monitor" aria-hidden="true" />
      <div className="banner-body">
        <span className="banner-title">{what}</span>
        이 작업은 태블릿이나 데스크톱에서 합니다. 휴대폰에서는 볼 수만 있습니다
      </div>
      <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
        <i className="ic ic-copy" aria-hidden="true" />
        링크 복사
      </button>
    </div>
  );
}
