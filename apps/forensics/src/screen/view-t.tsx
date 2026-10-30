// 배치 하나(t 보드)의 화면: 보드 머리(cs-bar)와 본문·겹침·바닥. 배치마다 따로 받아 휴대폰이 데스크톱 그림을 받지 않게 한다.
import { BarT, OverlaysT, valsT } from './board-t';

export default function ViewT({ state, close }: { state: string; close: () => void }) {
  const v = valsT(state);
  return (
    <>
      <header className="cs-bar" style={{ flexWrap: 'wrap', whiteSpace: 'normal' }}>
        <BarT v={v} />
      </header>
      <OverlaysT v={v} close={close} />
    </>
  );
}
