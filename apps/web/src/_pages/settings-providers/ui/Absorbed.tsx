// SCR-040 '지금 계정이 흡수됨'(d5 §5.22): 지금 계정이 대표 계정으로 흡수되어 세션이 끝났다(세션 종료 MERGED, 휴대폰 보드).
// 미리보기 상태('흡수된 세션 안내')는 서버 페이지가, 실제 흐름(?ended=MERGED)은 흡수 표시를 본 MergedAwayNotice가 그린다.
import Link from 'next/link';
import { MERGE_PROPOSAL, PROVIDER_NAME } from '@/entities/provider';

/** live면 실제 흐름에서 왔다(목업의 제공자 이름 대신 일반 문장) */
export function Absorbed({ live }: { live: boolean }) {
  return (
    <div className="col mx-auto w-full max-w-[400px] gap-5 px-4 pt-14 pb-6">
      <div className="state" role="alert" style={{ padding: 0 }}>
        <span className="state-icon is-warning">
          <i className="ic ic-logout" aria-hidden="true" />
        </span>
        <h1 className="t-xl">이 계정은 대표 계정으로 합쳐졌습니다</h1>
        <p className="t-md muted">대표 계정으로 다시 로그인해 주세요</p>
      </div>
      <p className="t-sm muted" style={{ textAlign: 'center' }}>
        {live ? '지금까지 쓰던 로그인 수단으로 로그인해도 대표 계정으로 들어갑니다.' : `${PROVIDER_NAME[MERGE_PROPOSAL.incoming]}로 로그인해도 대표 계정으로 들어갑니다.`}
      </p>
      <Link className="btn btn-primary btn-lg btn-block" href="/login">
        로그인 화면으로 가기
      </Link>
    </div>
  );
}
