// SCR-068 공지 관리(/notices, d5 §7.16). 실제 경로는 ConnectedPage, `?state=` 미리보기만 디자인 보드(SCR-068-d·t·m)를 그린다.
// 홈 구성(배너·테마 줄 게시)을 포함한다. 역할(d5 §3.3): viewer는 홈 구성 읽기, operator는 작성·발송과 홈 구성 게시,
// commander는 템플릿 승인과 홈 구성 게시, CS 두 역할은 메뉴에 없는다.
import { useSearchParams } from 'react-router';
import { useBoardPage } from '@/shared/lib/board';
import { DEFAULT, STATES } from '../states';
import { MainD, valsD } from './board-d';
import { MainM, valsM } from './board-m';
import { MainT, valsT } from './board-t';
import { ConnectedPage } from './ConnectedPage';

const TITLE = '공지 관리';

function BoardPage() {
  const { state, layout, close, go } = useBoardPage(TITLE, STATES, DEFAULT);
  return (
    <>
      {layout === 'desktop' ? <MainD v={valsD(state)} close={close} go={go} /> : null}
      {layout === 'tablet' ? <MainT v={valsT(state)} close={close} go={go} /> : null}
      {layout === 'phone' ? <MainM v={valsM(state)} close={close} go={go} /> : null}
    </>
  );
}

export function Page() {
  const [sp] = useSearchParams();
  return __PREVIEW__ && sp.get('state') ? <BoardPage /> : <ConnectedPage />;
}
