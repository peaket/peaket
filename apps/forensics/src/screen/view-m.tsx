// 배치 하나(m 보드)의 화면: 보드 머리(cs-bar)와 본문·겹침·바닥. 배치마다 따로 받아 휴대폰이 데스크톱 그림을 받지 않게 한다.
import { BarM, OverlaysM, valsM } from './board-m';
import type { Source } from '../lib/source';

export default function ViewM({ state, close, source }: { state: string; close: () => void; source: Source }) {
  const v = valsM(state, source);
  return (
    <>
      <header className="cs-bar" style={{ flexWrap: 'wrap', whiteSpace: 'normal', gap: 8 }}>
        <BarM v={v} />
      </header>
      <OverlaysM v={v} close={close} />
    </>
  );
}
