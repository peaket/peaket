// SCR-029 휴대폰(SCR-029-m) 보드의 상태 값(보드 vals 함수와 상태 열거). board-m.tsx에서 그대로 떼어 냈다(F-03-2 OPS-360, ADR-0361 결정 10).
// 대시보드 화면 덩어리가 보드 셋을 함께 싣지 않게, 페이지는 이 파일만 바로 가져오고 보드 그림(board-m.tsx)은 배치에 맞는 것만 늦게 싣는다.
export const STATES_M = ["T=0", "판매 중", "T-30분 점검", "종료 후 리포트", "입장 탭", "수집 장애", "제어 입력 없음", "메뉴 열림", "자동 조치 걸림", "숨겼다가 돌아옴", "실시간 표 낡음", "거래 사건 끊김", "경보 억제", "버짓 50% 소진", "버짓 100% 소진", "대상 없음", "viewer"] as const;
export const DEFAULT_M = "T=0";

export function valsM(state: string) {
    let st = state || 'T=0';
    let supp = st === '경보 억제';
    let b50 = st === '버짓 50% 소진';
    let b100 = st === '버짓 100% 소진';
    let budget = b50 || b100;
    let empty = st === '대상 없음';
    let viewer = st === 'viewer';
    let menu = st === '메뉴 열림';
    let auto = st === '자동 조치 걸림';
    let back = st === '숨겼다가 돌아옴';
    let stale = st === '실시간 표 낡음';
    let gap = st === '거래 사건 끊김';
    let live = st === '판매 중' || auto || back || stale || gap || supp || budget;
    let noin = st === '제어 입력 없음';
    let t0 = st === 'T=0' || st === '수집 장애' || noin || menu || viewer;
    let shell0 = t0 || live;
    let t30 = st === 'T-30분 점검';
    let after = st === '종료 후 리포트';
    let entry = st === '입장 탭';
    function on(b: any) { return b ? 'is-active' : ''; }
    function sel(b: any) { return b ? 'true' : 'false'; }
    return {
      isSupp: supp,
      notSupp: !supp,
      isB50: b50,
      isB100: b100,
      isBudget: budget,
      notBudget: !budget,
      notSuppBud: !supp && !budget,
      raiseStop: budget,
      sevSupp: supp,
      sevBud: budget,
      sevEmpty: empty,
      isEmpty: empty,
      notEmpty: !empty,
      isViewer: viewer,
      notViewer: !viewer,
      isT0Shell: shell0,
      isT0Grid: t0,
      notT0: !shell0 && !empty,
      isPaused: shell0 && !noin && !budget,
      seatBan: shell0 && !budget,
      isNoInput: noin,
      sev1Cut: !noin,
      isLive: live,
      isAuto: auto,
      isBack: back,
      notBack: !back,
      freshOk: !back && !stale,
      isStale: stale,
      notStale: !stale,
      isGap: gap,
      liveBase: live && !auto,
      ctlNormal: st === 'T=0' || menu || viewer,
      isNormal: st === 'T=0' || menu || noin || viewer,
      isDown: st === '수집 장애',
      isT30: t30,
      isAfter: after,
      isEntry: entry,
      isMenu: menu,
      sevA: ((shell0 && !noin && !supp && !budget) || t30) && !auto,
      sevB: auto,
      tab: { t30: on(t30), t0: on(t0), live: on(live), after: on(after), entry: on(entry) },
      sel: { t30: sel(t30), t0: sel(t0), live: sel(live), after: sel(after), entry: sel(entry) }
    };
  }
