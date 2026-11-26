// F-04-16 운영 원천 오류 상태. 권한 없음·원천 만료·가명처리 검토 전·파일 거절을 같은 자리에서 보인다.
import type { ReplayProblem } from '../lib/replay-export';

const center = { flex: '1', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '80px 20px', textAlign: 'center' } as const;

const TITLE: Partial<Record<ReplayProblem['kind'], string>> = {
  denied: '이 화면을 볼 권한이 없습니다',
  expired: '원천 만료',
  'review-pending': '가명 처리 검토 중입니다',
  'not-found': '찾을 수 없습니다',
  'not-ready': '연구용 내보내기를 아직 만드는 중입니다',
  auth: '로그인이 필요합니다',
  reauth: '다시 인증해 주세요',
  unavailable: '잠시 뒤 다시 시도해 주세요',
};

export function ProblemMain({ problem }: { problem: ReplayProblem }) {
  const title = TITLE[problem.kind] ?? '기록을 열 수 없습니다';
  return (
    <main id="main" role="alert" aria-live="assertive" className="col" style={center}>
      <h1 className="t-lg">{title}</h1>
      <p className="t-md muted">{problem.message}</p>
      <a className="link-more" href="/dashboard">
        관제 콘솔
      </a>
    </main>
  );
}
