// SCR-045 'viewer 주소로 열기'(d5 §7.6 상태 표 'viewer' 줄). 보드에 없는 상태라 SCR-049 'CS 담당자' 보드의 안내 모양을 그대로 쓴다.
// viewer는 셸 메뉴에 CS 처리함이 없고, 주소로 열면 이 안내와 정산 지급 링크를 본다(목록·상세 경로의 허용 역할에 viewer가 없어 403).
import { Link } from 'react-router';

export function ViewerNotice() {
  return (
    <>
      <div className="page-head">
        <div className="col" style={{ gap: 4 }}>
          <h1>CS 처리함</h1>
          <p className="t-sm muted">사람이 판단할 건을 기한과 함께 처리합니다. 결제자 이름·전화는 가려 보이고, 열람하면 사유가 접속기록에 남습니다.</p>
        </div>
      </div>
      <div className="state" role="status" style={{ padding: '64px 16px', gap: 12 }}>
        <span className="state-icon">
          <i className="ic ic-lock" aria-hidden="true" />
        </span>
        <h2 className="t-lg">CS 처리함은 CS 담당자와 operator·commander가 씁니다</h2>
        <p className="t-sm muted">정산 건의 건수는 정산 지급에서 봅니다.</p>
        <Link to="/settlements" className="btn btn-outline">
          정산 지급으로
        </Link>
      </div>
    </>
  );
}
