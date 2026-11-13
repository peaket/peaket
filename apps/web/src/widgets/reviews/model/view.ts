// SCR-016 후기 모달의 처음 모습 정하기. 서버(공연 상세 페이지)와 클라이언트(뒤로 가기 popstate)가 같은 규칙을 쓴다.
// 1) ?state=가 SCR-016 상태(보드 state 열거값)면 그 상태로 열린 채 그린다(퍼블리싱 미리보기).
// 2) 아니면 실제 주소 값: ?reviews=all(전체 모달, &review=<id>&photo=<n>이면 사진 보기) · ?review=new(쓰기 모달) ·
//    ?report=<id>(신고 모달, ?reviews=all과 함께면 전체 모달 자리, 아니면 상세 위).
// 3) 둘 다 없으면 null(아무것도 그리지 않는다).
import { SCR016_STATES, type Scr016State } from '@/shared/config/screens.discovery';

export type ReviewModalKind = 'list' | 'photo' | 'report' | 'confirm' | 'write' | 'noRight' | 'login' | 'reportLogin' | 'off';

export interface ReviewModalInit {
  kind: ReviewModalKind;
  /** 사진 보기·신고 대상 후기 id */
  reviewId: string;
  /** 사진 보기의 몇 번째(1부터) */
  photo: number;
  /** 신고를 연 자리: 전체 모달('list')이면 닫을 때 전체 모달로 돌아가고, 상세 미리보기('detail')면 상세로 닫는다 */
  from: 'list' | 'detail';
  /** 퍼블리싱 미리보기 상태(SCR-016). 실제 주소로 열었으면 null */
  preview: Scr016State | null;
}

/** 보드 상태가 기본으로 고르는 신고·사진 대상(김**의 후기, 게시물 1234) */
export const DEMO_REVIEW_ID = '1234';

const REPORT_STATES: readonly Scr016State[] = [
  '신고',
  '신고 · 권리 침해',
  '신고 · 불법 촬영물',
  '신고 입력 오류',
  '신고 전송 실패',
  '신고 한도',
  '신고 대상 없음',
  '신고기관 바로가기',
  '복사 실패',
];
const WRITE_STATES: readonly Scr016State[] = ['후기 쓰기(사진)', '사진 확인 중', '사진 오류', '입력 오류', '금칙어 오류', '이미 씀'];

type Params = Record<string, string | string[] | undefined> | URLSearchParams;

function read(sp: Params, key: string): string | undefined {
  if (sp instanceof URLSearchParams) return sp.get(key) ?? undefined;
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

export function isScr016State(v: string | undefined): v is Scr016State {
  return v !== undefined && (SCR016_STATES as readonly string[]).includes(v);
}

function fromPreview(state: Scr016State): ReviewModalInit {
  const base = { reviewId: DEMO_REVIEW_ID, photo: 1, from: 'list' as const, preview: state };
  if (state === '사진 보기') return { ...base, kind: 'photo' };
  if (REPORT_STATES.includes(state)) return { ...base, kind: 'report' };
  if (state === '신고 확인' || state === '신고 보내는 중') return { ...base, kind: 'confirm' };
  if (state === '신고 로그인 필요') return { ...base, kind: 'reportLogin', from: 'detail' };
  if (state === '기능 꺼짐') return { ...base, kind: 'off' };
  if (WRITE_STATES.includes(state)) return { ...base, kind: 'write' };
  if (state === '자격 없음 대화상자') return { ...base, kind: 'noRight' };
  if (state === '로그인 필요') return { ...base, kind: 'login' };
  // 전체 모달 · 빈 화면 · 신고 접수 완료
  return { ...base, kind: 'list' };
}

/** 주소 값으로 처음 모습을 정한다. guest면 쓰기·신고 대신 로그인 안내를 연다 */
export function resolveReviewModal(sp: Params, guest: boolean): ReviewModalInit | null {
  const state = read(sp, 'state');
  if (isScr016State(state)) return fromPreview(state);
  const all = read(sp, 'reviews') === 'all';
  const report = read(sp, 'report');
  const review = read(sp, 'review');
  const photo = Number(read(sp, 'photo') ?? '');
  const base = { reviewId: DEMO_REVIEW_ID, photo: 1, from: 'list' as const, preview: null };
  if (report) {
    return { ...base, kind: guest ? 'reportLogin' : 'report', reviewId: report, from: all ? 'list' : 'detail' };
  }
  if (all) {
    // 사진 수는 목록을 받은 뒤 안다. 주소가 사진을 가리키면 화면이 목록에서 찾아 그리고, 없으면 안내한다.
    if (review && Number.isInteger(photo) && photo >= 1) return { ...base, kind: 'photo', reviewId: review, photo };
    return { ...base, kind: 'list' };
  }
  if (review === 'new') return { ...base, kind: guest ? 'login' : 'write', from: 'detail' };
  return null;
}

/** 이 모습을 다시 그릴 주소(검색 문자열). 상태 고르기(?state=)는 빼고 테마만 남긴다 */
export function reviewModalSearch(view: Pick<ReviewModalInit, 'kind' | 'reviewId' | 'photo' | 'from'>, theme: string | undefined): string {
  const p = new URLSearchParams();
  switch (view.kind) {
    case 'list':
      p.set('reviews', 'all');
      break;
    case 'photo':
      p.set('reviews', 'all');
      p.set('review', view.reviewId);
      p.set('photo', String(view.photo));
      break;
    case 'report':
    case 'confirm':
      if (view.from === 'list') p.set('reviews', 'all');
      p.set('report', view.reviewId);
      break;
    case 'write':
      p.set('review', 'new');
      break;
    default:
      break;
  }
  if (theme) p.set('theme', theme);
  const q = p.toString();
  return q ? `?${q}` : '';
}

/** 모달 값을 모두 지운 주소(닫기) */
export function closedSearch(theme: string | undefined): string {
  return theme ? `?theme=${encodeURIComponent(theme)}` : '';
}
