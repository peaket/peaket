// SCR-059 시스템 안내 화면 관제 변형(d5 §5.33의 관제 쪽, §3.6). 보드 SCR-059-console(데스크톱)·-t(태블릿)·-m(휴대폰)을 배치마다 옮겼다.
// 관제 셸 안에 같은 틀을 그린다(위 상태 바와 경보는 그대로). 없는 주소(*)의 화면이고, ?state=로 500·429·미지원·화면 불러오기 실패를 본다.
// 보드는 commander 수진의 화면이다. 위 상태 바: 단계 T=0 · 자동 제어 일시정지 13:12 · 20:04:12(호스트 값을 덮어쓴다).
import { useBoardPage } from '@/shared/lib/board';
import { usePreviewHost } from '@/features/preview-host';
import { useDocumentTitle } from '@/shared/lib/title';
import { useMainStyle } from '@/shared/model/shell';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { DEFAULT, STATES } from '../states';
import { MainD, valsD } from './board-d';
import { MainM, valsM } from './board-m';
import { MainT, valsT } from './board-t';

/** 보드의 <main class="cs-main" style> 값 */
const MAIN_STYLE = {
  desktop: { justifyContent: 'center', alignItems: 'center', padding: '40px 20px' },
  tablet: { justifyContent: 'center', alignItems: 'center', padding: '40px 24px' },
  phone: { justifyContent: 'center' },
} as const;

const TITLES: Record<string, string> = {
  '500': '일시적인 오류',
  '404': '찾을 수 없는 화면',
  '429': '요청이 많아 잠시 기다림',
  미지원: '지원하지 않는 브라우저',
  '미지원(인앱 브라우저)': '지원하지 않는 브라우저',
  '화면 불러오기 실패': '화면을 불러오지 못함',
  '화면 불러오기 실패(새 버전)': '화면을 불러오지 못함',
};

export function NotFoundPage() {
  const { state, layout, close, go } = useBoardPage('찾을 수 없는 화면', STATES, DEFAULT);
  useMainStyle(MAIN_STYLE[layout], `scr-059-${layout}`);
  usePreviewHost({ scope: { stage: 'T=0' }, control: { kind: 'paused', remaining: '13:12' }, clock: '20:04:12 KST' }, [state]);
  // 상태마다 보드 제목으로 바꾼다(useBoardPage의 제목 뒤에 돈다)
  useDocumentTitle(TITLES[state] ?? '찾을 수 없는 화면');
  // 데스크톱 보드에는 인앱 브라우저 변형이 없어 '미지원'으로 그린다
  const dState = state === '미지원(인앱 브라우저)' ? '미지원' : state;
  return (
    <>
      {layout === 'desktop' ? <MainD v={valsD(dState)} close={close} go={go} /> : null}
      {layout === 'tablet' ? <MainT v={valsT(state)} close={close} go={go} /> : null}
      {layout === 'phone' ? <MainM v={valsM(state)} close={close} go={go} /> : null}
      <PreviewSwitcher states={STATES} current={state} />
    </>
  );
}

