// 배치 하나(t 보드)의 화면: 보드 머리(cs-bar)와 본문·겹침·바닥. 배치마다 따로 받아 휴대폰이 데스크톱 그림을 받지 않게 한다.
import { BarT, OverlaysT, valsT } from './board-t';
import type { Source } from '../lib/source';

export default function ViewT({ state, close, source }: { state: string; close: () => void; source: Source }) {
  const v = valsT(state, source);
  return (
    <>
      <header className="cs-bar" style={{ flexWrap: 'wrap', whiteSpace: 'normal' }}>
        <BarT v={v} />
      </header>
      <OverlaysT v={v} close={close} />
    </>
  );
}
