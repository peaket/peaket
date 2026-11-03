// -*- mode: Bluespec; -*-
// 대기열·입장 제어 명세(wbs 0.9.1, docs/verification.md §2.1 `queue`).
// 근거: ADR-0002(순번 카운터), ADR-0041(동시 도착 구간 묶음), ADR-0056(리더 세대 펜싱, 입장 확정 때 1인 1순번 재확인),
//       ADR-0181(세대 키로 장애 전환을 알아채고 RB-05), ADR-0182(리더의 묶음 닫기·게시), ADR-0183(입장 확정을 네 호출로),
//       docs/features/queue-admission.md §3(진입 ①②③, 묶음, 장애 전환·세대)·§5(리더 루프)·§6(입장 확정), docs/infra.md RB-05.
// 읽는 법은 specs/README.md. 이 파일은 정본이 아니다. 정본과 다르면 정본이 이기고, 이 파일을 고친다.
// 동작 이름은 구현(queue-svc entry·admission, admission-ctrl leader·batch)과 모델 기반 시험의 명령 이름과 같다(wbs 2.3.4, V-T40).
// 이름을 바꾸거나 더하면 services/admission-ctrl/test-int/queue-model/actions.ts의 SPEC_ACTIONS도 함께 고친다(CI가 견준다).
//
// 모형으로 줄인 것:
// - 시간: 15분 입장 기한, 판매 종료, PENDING 수명 10초, 묶음 구간 N초는 '언제든 끝날 수 있음'으로만 둔다.
// - 대기열 Redis는 회차 슬롯(`{event:E}`) 샤드 하나와 사람마다 사람 슬롯(`{pid}`: q:dup, q:adm) 샤드 하나다.
//   복제는 비동기이고 순서대로 간다. 회차 슬롯은 아직 복제되지 않은 쓰기를 LAG개까지 둔다(evPend). 쓰기가 LAG개를 넘으면 가장 오래된 것부터
//   복제본에 닿는다. 장애 전환은 복제본을 주 노드로 올려 복제되지 않은 쓰기를 모두 잃는다. 사람 슬롯은 쓰기 하나까지다.
// - 한 Lua 안의 일은 한 걸음(원자)이다. 서로 다른 슬롯에 걸친 일(진입 ①②③, 입장 확정의 네 호출)은 걸음을 나눈다. 다만 ③ 실패 뒤 빠진 번호 등록,
//   이탈, 입장 확정의 1인 1순번 거절 뒤 빠진 번호 등록은 한 걸음으로 묶었다(그 사이의 장애 전환은 따로 보지 않는다).
//   ADMIT_STEPS가 거짓인 범위는 입장 확정 네 호출을 한 걸음(admit)으로 묶어 상태 수를 줄인다(자리가 있는 경우만).
// - 리더 쓰기는 'Lease 재확인 → (멈출 수 있음) → 세대 확인 Lua' 두 걸음이다. 그 사이에 무엇이든 끼어든다(멈췄다 깨어난 옛 리더).
//   serving 전진(TICK)은 한 번에 유효 번호 하나다: 빠진 번호와 건너뛴 구간을 지나 다음 유효 번호까지, 발급된 번호를 넘지 않고, 묶음 표시가 있는데
//   아직 게시하지 않았으면 그 묶음의 첫 번호 앞까지다(첫 전진 문, ADR-0058 결정 4. 게시 뒤 분산 창은 '언제든 지날 수 있음'으로 줄여 게시와 함께 연다).
//   더 큰 폭은 여러 번 전진한 것과 같은 serving에 닿고, ③은 폭이 아니라 반영된 쓰기 수를 센다. 오는 중·입장 비율·판매 상태·빈자리는 담지 않는다
//   (serving이 덜 나가는 쪽이라 ①~⑤와 상관없다).
// - 탭 하나는 기기 하나이고 탭마다 요청 하나다. 같은 대기표의 요청 둘이 동시에 오는 경합(입장 Lua의 slot_of, SOON 되돌리기의 요청 표지)은
//   모델 기반 시험이 실제 Lua 위에서 순서를 섞어 본다(wbs 2.3.4). 묶음 참가자는 사전 검증 토큰 해시라(queue-admission §3) 탭마다 따로 센다.
// - RB-05(ADR-0181): 회차 슬롯의 세대 키(ev.node)에 마지막으로 쓴 주 노드의 설정 세대를 두고, 지금 주 노드의 설정 세대(env.primary)와 다르면
//   장애 전환으로 본다. 건너뛰는 양 K = 바탕 값(LAG: 쓰기 하나에 번호 하나) × 설정 세대가 오른 수(1~3) + (구간이 끝났는데 묶음 표시가 없으면 참가자 수).
//   설정 세대는 장애 전환마다 EPOCH_JUMPS 가운데 하나만큼 오른다(새로 만든 클러스터는 한 번에도 여럿 오른다, PRF-085 측정).
//   잃은 묶음 표시는 되살리지 않고 다음 진입이나 리더가 새 카운터 위에서 다시 닫는다(ADR-0181 결정 5).
// - 묶음 게시(publishBatch)는 리더가 표시가 복제된 것을 확인한 뒤(WAIT) 결과와 게시 표시(pub:1)를 쓰는 한 걸음이고, 참가자 탭은 그 뒤 자기 결과를
//   받는다(takeBatchResult). 결과는 공시한 시드와 그 표시로 정해져 두 번 써도 같다.
// 뺀 것: 로비 셔플(ADR-0064), 추가 검증(§7), 진입 Degraded 도착 시각 칸(§9), 같은 요청 ID 재시도, 리더 상태 기록(일시정지·목표,
//        ADR-0056 결정 4), 15분 기한, 매진, 결과 키를 잃은 묶음의 다시 쓰기. 이탈(leave)은 아직 구현이 없다(BUILD_ORDER HOT-060).
module queue {
  // ---- 범위(작은 범위, docs/verification.md §2.1. 검사 모듈이 정한다) ----
  const TICKETS: Set[(int, int)] // (사람, 탭). 탭마다 진입 시도 하나(요청 ID 하나)
  const CTRLS: Set[int]          // admission-ctrl 파드
  const MAX_FAILOVERS: int       // 대기열 Redis 장애 전환(샤드 상관없이 합)
  const PERSON_FAILOVERS: bool   // 사람 슬롯 샤드도 장애 전환하는지
  const MAX_LEADER_CHANGES: int  // 리더 교체 횟수(첫 리더 뒤)
  const LAG: int                 // 회차 슬롯의 복제되지 않은 쓰기 상한(1 또는 2)
  const EPOCH_JUMPS: Set[int]    // 장애 전환 한 번에 오르는 설정 세대
  const OPEN_BATCH: bool         // 오픈 직후 묶음 구간이 있는 회차인지(거짓이면 처음부터 구간 밖)
  const ADMIT_STEPS: bool        // 입장 확정을 네 호출로 나눠 보는지(거짓이면 admit 한 걸음)
  // ---- 설계 장치(하나씩 끈 변형으로 검사가 살아 있는지 본다, V-T1) ----
  const FENCING: bool            // 리더 쓰기 Lua의 세대 확인(ADR-0056 결정 2)
  const SERVING_CHECK: bool      // 입장 확정의 '내 번호 ≤ serving'(queue-admission §6)
  const ADMISSION_RECHECK: bool  // 입장 확정의 q:adm 재확인(ADR-0056 결정 5)
  const ENTRY_WAITS_RB05: bool   // 세대 키가 다르면 RB-05가 끝날 때까지 번호를 내지 않고 묶음도 닫지 않음(ADR-0181 결정 1)
  // 1인 1순번 장치(PRF-060): 묶음에 넣은 뒤 사람 슬롯의 PENDING을 묶음 기록(판매 종료 수명)으로 바꾸고, ③과 묶음 기록도 q:adm이 비었는지 본다
  const ONE_PERSON_GUARDS: bool
  const EPOCH_MULTIPLIER: bool   // RB-05가 설정 세대가 오른 수만큼 바탕 값을 곱함(ADR-0181 결정 4, RB-05 자체를 잃는 연속 장애 전환)
  const MISSING_CHECK: bool      // 게시된 묶음의 참가자 목록에 없는 참가(SADD를 잃음)의 묶음 기록을 지우고 같은 요청으로 다시 진입(batchMissing)

  // ---- 값 ----
  type Slot = { kind: str, tab: int, seq: int, gen: int }   // q:dup·q:adm 값. kind: NONE·PENDING·REC(번호 기록)·BATCH(묶음 기록)·ADM(입장 키)
  type PRec = { dup: Slot, adm: Slot }
  type Range = { start: int, end: int, gen: int }          // q:{event:E}:skipped 한 줄
  // 회차 슬롯: 카운터, serving, 리더 세대, 건너뛴 구간, 빠진 번호, 묶음 닫힘 표시(첫 번호·크기·세대)·게시 표시와 참가자, 세대 키(쓴 주 노드의 설정 세대)
  type Ev = { seq: int, serving: int, leader: int, skips: Set[Range], removed: Set[int],
              closed: bool, first: int, size: int, bgen: int, pub: bool, members: Set[(int, int)], node: int }
  // 탭(브라우저와 그 요청을 처리하는 queue-svc). phase: IDLE·PREEMPTED·NUMBERED·SADDED(묶음에 넣고 기록 전)·BATCHED·HELD·ADMITTED·DONE(409·이탈로 끝남)
  //   입장 확정(ADMIT_STEPS): CHECKED(회차 슬롯 확인 통과)·CLAIMED(q:adm을 채움)·SLOTTED(자리를 받음)·RELEASING(q:adm 되돌리기 전, 그 뒤 after로)
  //   own: 이 요청이 q:adm을 비어 있던 데서 채웠다(그때만 되돌린다)
  type Tab = { phase: str, seq: int, gen: int, own: bool, after: str }
  type Ctrl = { gen: int, op: str }                        // op: NONE·BUMP·ADVANCE·CLOSE(Lease를 확인하고 아직 Lua를 보내지 않은 쓰기)
  type Ctl = { holder: int, transitions: int, acquisitions: int, c: int -> Ctrl }
  // primary: 지금 주 노드의 설정 세대(클러스터 상태라 장애 전환으로 잃지 않는다)
  type Env = { windowOpen: bool, primary: int, evFailovers: int, psFailovers: int }
  type Ticket = { pid: int, tab: int, seq: int, gen: int }
  // 검사에만 쓰는 기록(시스템이 아는 값이 아니다). admittedBy: 사람마다 입장한 (탭, 번호, 세대), dupLost: 장애 전환으로 q:dup이 바뀐 사람,
  // early: 자리를 받을 때 번호가 serving보다 컸던 적이 있음
  type Ghost = { issued: Set[Ticket], admittedBy: int -> Set[(int, int, int)], early: bool, staleApplied: int, maxGenSeen: int,
                 admLost: Set[int], dupLost: Set[int] }

  pure val EMPTY: Slot = { kind: "NONE", tab: 0, seq: 0, gen: 0 }
  pure val NOOP: Ctrl = { gen: 0, op: "NONE" }
  pure val PERSONS: Set[int] = TICKETS.map(k => k._1)
  pure def maxI(a: int, b: int): int = if (a > b) a else b
  pure def minI(a: int, b: int): int = if (a < b) a else b
  // 묶음 안 순서(셔플 결과). 안전성과 상관없어 (사람, 탭) 순으로 둔다
  pure def keyOf(k: (int, int)): int = k._1 * 100 + k._2
  pure def rankIn(m: Set[(int, int)], k: (int, int)): int = m.filter(q => keyOf(q) < keyOf(k)).size()
  // 대기표 세대 = 건너뛴 구간 줄 수 + 1(docs/data.md q:{event:E}:skipped)
  pure def genOf(e: Ev): int = e.skips.size() + 1
  pure def skipped(e: Ev, n: int): bool = e.skips.exists(g => g.start <= n and n <= g.end)
  // TICK 한 번(최대 전진 1): 첫 전진 문까지, 다음 유효 번호(빠진 번호·건너뛴 구간이 아닌 번호)로. 그런 번호가 없으면 갈 수 있는 끝까지
  pure def advanced(e: Ev): int = {
    val cap = if (e.closed and not(e.pub)) minI(e.seq, e.first - 1) else e.seq
    val valid = (e.serving + 1).to(cap).filter(n => not(e.removed.contains(n)) and not(skipped(e, n)))
    if (cap <= e.serving) e.serving else if (valid.size() == 0) cap else valid.fold(cap, (a, n) => minI(a, n))
  }

  var ev: Ev
  var evRep: Ev
  var evPend: List[Ev]
  var pss: int -> PRec
  var pssRep: int -> PRec
  var tabs: (int, int) -> Tab
  var ctl: Ctl
  var env: Env
  var ghost: Ghost

  def curGen: int = genOf(ev)
  def tab(p: int, t: int): Tab = tabs.get((p, t))
  def markerOk: bool = not(ENTRY_WAITS_RB05) or ev.node == env.primary
  // 표시가 복제본에도 같다(리더는 게시 전에 같은 슬롯 쓰기 뒤 WAIT로 확인한다, ADR-0181 결정 5·PRF-090)
  def markerReplicated: bool = ev.closed and evRep.closed and evRep.first == ev.first and evRep.size == ev.size and evRep.bgen == ev.bgen

  // ---- 저장소 쓰기 ----
  action evKeep: bool = all { ev' = ev, evRep' = evRep, evPend' = evPend }
  action evWrite(e2: Ev): bool =
    if (e2 == ev) evKeep
    else if (evPend.length() < LAG) all { ev' = e2, evRep' = evRep, evPend' = evPend.append(e2) }
    else all { ev' = e2, evRep' = evPend.head(), evPend' = evPend.tail().append(e2) }
  action psWrite(p: int, r2: PRec): bool = all {
    pss' = pss.set(p, r2),
    pssRep' = if (r2 == pss.get(p)) pssRep else pssRep.set(p, pss.get(p)),
  }
  action psKeep: bool = all { pss' = pss, pssRep' = pssRep }
  action setTab(p: int, t: int, x: Tab): bool = tabs' = tabs.set((p, t), x)

  action init = {
    // 세대 키는 오픈 전에 회차 일정 사본을 읽는 Lua가 쓴다(ADR-0181 결정 1)
    val ev0: Ev = { seq: 0, serving: 0, leader: 0, skips: Set(), removed: Set(), closed: false, first: 0, size: 0, bgen: 0, pub: false, members: Set(), node: 1 }
    val p0: PRec = { dup: EMPTY, adm: EMPTY }
    all {
      ev' = ev0,
      evRep' = ev0,
      evPend' = List(),
      pss' = PERSONS.mapBy(p => p0),
      pssRep' = PERSONS.mapBy(p => p0),
      tabs' = TICKETS.mapBy(k => { phase: "IDLE", seq: 0, gen: 0, own: false, after: "" }),
      ctl' = { holder: 0, transitions: 0, acquisitions: 0, c: CTRLS.mapBy(c => NOOP) },
      env' = { windowOpen: OPEN_BATCH, primary: 1, evFailovers: 0, psFailovers: 0 },
      ghost' = { issued: Set(), admittedBy: PERSONS.mapBy(p => Set()), early: false, staleApplied: 0, maxGenSeen: 0,
                 admLost: Set(), dupLost: Set() },
    }
  }

  // 묶음 닫기(구간이 닫히는 순간 카운터를 몫만큼 떼고 {첫 번호}:{크기}:{세대} 표시를 남긴다. HSETNX라 표시가 있으면 아무것도 안 한다, 중간-028)
  pure def closeBatch(e: Ev): Ev =
    if (e.closed or not(OPEN_BATCH)) e
    else e.with("closed", true).with("first", e.seq + 1).with("size", e.members.size()).with("bgen", genOf(e)).with("seq", e.seq + e.members.size())

  // ---- 진입 ① 사람 슬롯 Lua: 이미 입장했거나 다른 요청이 선점했으면 409, 비었으면 PENDING:{요청 ID}로 선점 ----
  action enterPreempt(p: int, t: int): bool = {
    val r = pss.get(p)
    all {
      tab(p, t).phase == "IDLE",
      if (r.adm.kind != "NONE" or r.dup.kind != "NONE")
        all { setTab(p, t, tab(p, t).with("phase", "DONE")), psKeep }
      else
        all { psWrite(p, r.with("dup", { kind: "PENDING", tab: t, seq: 0, gen: 0 })),
              setTab(p, t, tab(p, t).with("phase", "PREEMPTED")) },
      evKeep, ctl' = ctl, env' = env, ghost' = ghost,
    }
  }

  // PENDING 수명(10초)이 지남
  action pendingExpires(p: int): bool = all {
    pss.get(p).dup.kind == "PENDING",
    psWrite(p, pss.get(p).with("dup", EMPTY)),
    evKeep, tabs' = tabs, ctl' = ctl, env' = env, ghost' = ghost,
  }

  // ---- 진입 ② 회차 슬롯 Lua: 세대 키가 다르면 RB05(아무것도 쓰지 않음), 구간 안이면 묶음에 SADD(202), 아니면 표시를 보고(없으면 먼저 닫고) INCR ----
  action enterNumber(p: int, t: int): bool = all {
    tab(p, t).phase == "PREEMPTED",
    markerOk,   // 아니면 503 queue-recovering(선점을 풀고 같은 요청 ID로 다시 온다. 그 사이 RB-05가 돈다)
    if (env.windowOpen and not(ev.closed))
      all { evWrite(ev.with("members", ev.members.union(Set((p, t))))),
            setTab(p, t, tab(p, t).with("phase", if (ONE_PERSON_GUARDS) "SADDED" else "BATCHED")),
            ghost' = ghost }
    else {
      val e1 = closeBatch(ev)
      val n = e1.seq + 1
      all {
        evWrite(e1.with("seq", n)),
        setTab(p, t, tab(p, t).with("phase", "NUMBERED").with("seq", n).with("gen", genOf(e1))),
        ghost' = ghost,
      }
    },
    psKeep, ctl' = ctl, env' = env,
  }

  // ---- 진입 ③ 사람 슬롯 Lua: PENDING:{내 요청 ID}이거나 비었으면 {번호}:{세대}:{요청 ID}로 기록하고 201, 아니면 빠진 번호로 돌리고 409 ----
  action enterRecord(p: int, t: int): bool = {
    val r = pss.get(p)
    val tb = tab(p, t)
    all {
      tb.phase == "NUMBERED",
      // 같은 Lua에서 q:adm도 본다: 이미 입장한 사람의 멈춰 있던 다른 요청이 번호를 기록하지 못하게
      if ((r.dup.kind == "NONE" or (r.dup.kind == "PENDING" and r.dup.tab == t)) and (not(ONE_PERSON_GUARDS) or r.adm.kind == "NONE"))
        all { psWrite(p, r.with("dup", { kind: "REC", tab: t, seq: tb.seq, gen: tb.gen })),
              setTab(p, t, tb.with("phase", "HELD")),
              evKeep,
              ghost' = ghost.with("issued", ghost.issued.union(Set({ pid: p, tab: t, seq: tb.seq, gen: tb.gen }))) }
      else
        all { psKeep, setTab(p, t, tb.with("phase", "DONE")),
              evWrite(ev.with("removed", ev.removed.union(Set(tb.seq)))), ghost' = ghost },
      ctl' = ctl, env' = env,
    }
  }

  // 묶음 기록 사람 슬롯 Lua: PENDING:{내 요청 ID}이거나 비었으면 묶음 기록(판매 종료 수명)으로 바꾸고 202,
  // 아니면(그사이 수명이 지난 선점을 다른 요청이 차지했거나 이미 입장함) 409. 묶음 몫의 그 자리는 아무도 갖지 않은 번호가 된다
  action enterBatchRecord(p: int, t: int): bool = {
    val r = pss.get(p)
    all {
      tab(p, t).phase == "SADDED",
      if ((r.dup.kind == "NONE" or (r.dup.kind == "PENDING" and r.dup.tab == t)) and r.adm.kind == "NONE")
        all { psWrite(p, r.with("dup", { kind: "BATCH", tab: t, seq: 0, gen: 0 })), setTab(p, t, tab(p, t).with("phase", "BATCHED")) }
      else
        all { psKeep, setTab(p, t, tab(p, t).with("phase", "DONE")) },
      evKeep, ctl' = ctl, env' = env, ghost' = ghost,
    }
  }

  // 게시된 묶음의 참가자 목록에 내 참가가 없으면(장애 전환으로 SADD를 잃음) 묶음 기록을 지우고 같은 요청으로 일반 진입을 다시 한다(queue-svc가 pub:1과
  // 참가자 목록을 본다. 탭은 IDLE로 돌아가 enterPreempt부터). 묶음 기록은 판매 종료까지 남으므로, 지우지 않으면 그 사람은 판매 종료까지 409를 받는다
  action batchMissing(p: int, t: int): bool = {
    val r = pss.get(p)
    all {
      MISSING_CHECK,
      tab(p, t).phase == "BATCHED",
      ev.pub,
      not(ev.members.contains((p, t))),
      setTab(p, t, tab(p, t).with("phase", "IDLE")),
      psWrite(p, if (r.dup.kind == "BATCH" and r.dup.tab == t) r.with("dup", EMPTY) else r),
      evKeep, ctl' = ctl, env' = env, ghost' = ghost,
    }
  }

  // 대기 취소(이탈): 번호를 빠진 번호로 돌리고 q:dup을 지운다
  action leave(p: int, t: int): bool = {
    val tb = tab(p, t)
    val r = pss.get(p)
    all {
      tb.phase == "HELD",
      setTab(p, t, tb.with("phase", "DONE")),
      evWrite(ev.with("removed", ev.removed.union(Set(tb.seq)))),
      psWrite(p, if ((r.dup.kind == "REC" or r.dup.kind == "BATCH") and r.dup.tab == t) r.with("dup", EMPTY) else r),
      ctl' = ctl, env' = env, ghost' = ghost,
    }
  }

  // 묶음 구간(T=0+N)이 지남
  action windowEnds: bool = all {
    env.windowOpen,
    env' = env.with("windowOpen", false),
    evKeep, psKeep, tabs' = tabs, ctl' = ctl, ghost' = ghost,
  }

  // 묶음 결과 게시(admission-ctrl PublishBatchResults): 리더가 표시가 복제된 것을 확인한 뒤(WAIT) 사람별 결과와 결과 파일을 쓰고 게시 표시(pub:1)를 쓴다.
  // 결과는 공시한 시드와 그 표시로 정해져 두 번 써도 같으므로 세대 확인 없이 쓴다(ADR-0056 결정 2). 참가자가 없어도 게시한다(첫 전진 문을 연다)
  action publishBatch: bool = all {
    OPEN_BATCH,
    markerReplicated,
    not(ev.pub),
    evWrite(ev.with("pub", true)),
    psKeep, tabs' = tabs, ctl' = ctl, env' = env, ghost' = ghost,
  }

  // 참가자 탭이 게시된 결과의 순번을 받는다(queue-svc 묶음 결과 읽기와 묶음 기록을 번호 기록으로 바꾸기, 탭마다 따로 걸음으로).
  // 사람 슬롯의 묶음 기록이 이 탭의 것이면 번호 기록으로 바꾸고 대기표를 준다. 그사이 바뀌었으면(사람 슬롯 장애 전환으로 잃음) 409다.
  // 결과 키는 사람마다 다른 슬롯이라 이 모형의 장애 전환이 지우지 않는다
  action takeBatchResult(p: int, t: int): bool = {
    val n = ev.first + rankIn(ev.members, (p, t))
    val r = pss.get(p)
    all {
      tab(p, t).phase == "BATCHED",
      ev.pub,
      ev.members.contains((p, t)),
      if (r.dup.kind == "BATCH" and r.dup.tab == t)
        all { setTab(p, t, tab(p, t).with("phase", "HELD").with("seq", n).with("gen", ev.bgen)),
              psWrite(p, r.with("dup", { kind: "REC", tab: t, seq: n, gen: ev.bgen })),
              ghost' = ghost.with("issued", ghost.issued.union(Set({ pid: p, tab: t, seq: n, gen: ev.bgen }))) }
      else
        all { setTab(p, t, tab(p, t).with("phase", "DONE")), psKeep, ghost' = ghost },
      evKeep, ctl' = ctl, env' = env,
    }
  }

  // ---- 리더 ----
  // Lease 얻기: 지금 보유자가 멈추거나 갱신하지 못하면 다른 파드가 얻는다. leaseTransitions + 1이 리더 세대다(ADR-0056 결정 1).
  // 새 리더는 진행 중인 회차의 세대부터 올린다(결정 3, BUMP). 쓰기 하나를 보내는 중인 파드는 그 쓰기를 마치기 전에는 다시 얻지 않는다
  action acquire(c: int): bool = all {
    ctl.holder != c,
    ctl.c.get(c).op == "NONE",
    ctl.acquisitions <= MAX_LEADER_CHANGES,
    ctl' = { holder: c, transitions: ctl.transitions + 1, acquisitions: ctl.acquisitions + 1,
             c: ctl.c.set(c, { gen: ctl.transitions + 1, op: "BUMP" }) },
    evKeep, psKeep, tabs' = tabs, env' = env, ghost' = ghost,
  }

  // Lease 재확인 뒤 쓰기 하나를 정한다(ADR-0010 결정 5). 그 뒤 Lua를 보내기 전에 멈출 수 있다
  action plan(c: int, op: str): bool = all {
    ctl.holder == c,
    ctl.c.get(c).op == "NONE",
    if (op == "ADVANCE") ev.seq > ev.serving else all { OPEN_BATCH, not(env.windowOpen), not(ev.closed) },
    ctl' = ctl.with("c", ctl.c.set(c, ctl.c.get(c).with("op", op))),
    evKeep, psKeep, tabs' = tabs, env' = env, ghost' = ghost,
  }

  // 세대 확인 Lua(ADR-0056 결정 2): 내 세대가 저장된 세대보다 작으면 아무것도 쓰지 않고 FENCED(파드는 루프를 멈춘다),
  // 아니면 저장된 세대를 내 세대로 올리고 쓴다. ADVANCE(TICK)는 serving을 다음 유효 번호로 올린다(advanced). CLOSE는 진입 ②처럼 세대 키가 다르면
  // 표시를 쓰지 않는다(RB05, ADR-0182 결정 6)
  action applyWrite(c: int): bool = {
    val w = ctl.c.get(c)
    val fenced = FENCING and w.gen < ev.leader
    val e1 = ev.with("leader", maxI(ev.leader, w.gen))
    val e2 = if (w.op == "ADVANCE") e1.with("serving", advanced(e1))
             else if (w.op == "CLOSE" and markerOk) closeBatch(e1)
             else e1
    all {
      w.op != "NONE",
      ctl' = ctl.with("c", ctl.c.set(c, NOOP.with("gen", w.gen))),
      if (fenced) all { evKeep, ghost' = ghost }
      else all {
        evWrite(e2),
        ghost' = ghost.with("staleApplied", if (w.gen < ghost.maxGenSeen) ghost.staleApplied + 1 else ghost.staleApplied)
                      .with("maxGenSeen", maxI(ghost.maxGenSeen, w.gen)),
      },
      psKeep, tabs' = tabs, env' = env,
    }
  }

  // ---- 대기열 Redis 복제와 장애 전환 ----
  action replicateEv: bool = all {
    evPend.length() > 0,
    evRep' = evPend.head(), evPend' = evPend.tail(),
    ev' = ev, psKeep, tabs' = tabs, ctl' = ctl, env' = env, ghost' = ghost,
  }

  action replicatePerson(p: int): bool = all {
    pssRep.get(p) != pss.get(p),
    pssRep' = pssRep.set(p, pss.get(p)),
    pss' = pss, evKeep, tabs' = tabs, ctl' = ctl, env' = env, ghost' = ghost,
  }

  // 회차 슬롯 샤드 장애 전환: 복제되지 않은 쓰기(카운터·serving·리더 세대·묶음 표시·게시 표시·세대 키)를 잃고, 새 주 노드의 설정 세대가 j만큼 오른다
  action failoverEv(j: int): bool = all {
    env.evFailovers + env.psFailovers < MAX_FAILOVERS,
    evPend.length() > 0,
    ev' = evRep, evRep' = evRep, evPend' = List(),
    env' = env.with("evFailovers", env.evFailovers + 1).with("primary", env.primary + j),
    psKeep, tabs' = tabs, ctl' = ctl, ghost' = ghost,
  }

  // 사람 슬롯 샤드 장애 전환: 복제되지 않은 q:dup·q:adm을 잃는다
  action failoverPerson(p: int): bool = all {
    PERSON_FAILOVERS,
    env.evFailovers + env.psFailovers < MAX_FAILOVERS,
    pssRep.get(p) != pss.get(p),
    pss' = pss.set(p, pssRep.get(p)), pssRep' = pssRep,
    env' = env.with("psFailovers", env.psFailovers + 1),
    ghost' = ghost.with("admLost", if (pss.get(p).adm.kind == "ADM" and pssRep.get(p).adm != pss.get(p).adm)
                                     ghost.admLost.union(Set(p)) else ghost.admLost)
                  .with("dupLost", if (pssRep.get(p).dup != pss.get(p).dup) ghost.dupLost.union(Set(p)) else ghost.dupLost),
    evKeep, tabs' = tabs, ctl' = ctl,
  }

  // RB-05(ADR-0181 결정 3·4·5): 세대 키가 지금 주 노드와 다를 때만, 카운터를 K만큼 건너뛰고 그 구간을 skipped에 한 줄 더한 뒤(세대 + 1) 세대 키를 바꾼다.
  // 잃은 묶음 표시는 되살리지 않는다(그 인원만큼 더 건너뛰고, 다음 진입이나 리더가 다시 닫는다). 진입 파드와 리더 어느 쪽이 돌아도 같다
  action rb05: bool = {
    val gap = env.primary - ev.node
    val times = if (EPOCH_MULTIPLIER and gap > 1) minI(gap, 3) else 1
    val lostMarker = if (OPEN_BATCH and not(env.windowOpen) and not(ev.closed)) ev.members.size() else 0
    val k = LAG * times + lostMarker
    all {
      ev.node != env.primary,
      evWrite(ev.with("seq", ev.seq + k).with("skips", ev.skips.union(Set({ start: ev.seq + 1, end: ev.seq + k, gen: curGen })))
                .with("node", env.primary)),
      env' = env, psKeep, tabs' = tabs, ctl' = ctl, ghost' = ghost,
    }
  }

  // ---- 입장 확정(queue-admission §6, ADR-0183 결정 1: 확인 → q:adm → 입장 → 마무리) ----
  // q:adm 값은 대기표(묶음은 참가 토큰)의 해시다. 탭(요청)까지 넣어 가린다(②가 깨진 모듈에서도 두 대기표를 하나로 세지 않게)
  def meOf(t: int, tb: Tab): Slot = { kind: "ADM", tab: t, seq: tb.seq, gen: tb.gen }
  // ① 회차 슬롯 확인이 거절하는 대기표: 빠진 번호, 또는 건너뛴 구간 안인데 그 줄보다 새 세대(장애 전에 받은 진짜 대기자가 아님)
  def rejected(tb: Tab): bool =
    ev.removed.contains(tb.seq) or ev.skips.exists(g => g.start <= tb.seq and tb.seq <= g.end and tb.gen > g.gen)
  def turnCome(tb: Tab): bool = not(SERVING_CHECK) or tb.seq <= ev.serving
  // ② q:adm이 다른 대기표로 차 있음(DUPLICATE_ADMISSION)
  def dupClaim(r: PRec, me: Slot): bool = r.adm.kind == "ADM" and r.adm != me
  // ④ 마무리(ADMITTED): 비었거나 같은 대기표면 이 요청의 값으로 쓰고, q:dup을 지운다
  pure def settled(r: PRec, me: Slot): PRec = { dup: EMPTY, adm: if (r.adm.kind == "NONE" or r.adm == me) me else r.adm }
  def admitted(p: int, t: int, tb: Tab): Ghost =
    ghost.with("admittedBy", ghost.admittedBy.setBy(p, s => s.union(Set((t, tb.seq, tb.gen)))))

  // 네 호출을 한 걸음으로(ADMIT_STEPS가 거짓인 범위, 자리가 있는 경우). NOT_YET·SOON은 아무것도 남기지 않아 걸음이 아니다
  action admit(p: int, t: int): bool = {
    val tb = tab(p, t)
    val r = pss.get(p)
    val me = meOf(t, tb)
    all {
      not(ADMIT_STEPS),
      tb.phase == "HELD",
      if (rejected(tb))
        all { setTab(p, t, tb.with("phase", "DONE")), evKeep, psKeep, ghost' = ghost }   // 409 REMOVED
      else all {
        turnCome(tb),
        if (ADMISSION_RECHECK and dupClaim(r, me))
          // 409 DUPLICATE_ADMISSION: 이 번호를 빠진 번호(1인 1순번 위반 무효화)로 돌린다
          all { setTab(p, t, tb.with("phase", "DONE")), psKeep, evWrite(ev.with("removed", ev.removed.union(Set(tb.seq)))), ghost' = ghost }
        else
          all { setTab(p, t, tb.with("phase", "ADMITTED")), psWrite(p, settled(r, me)), evKeep,
                ghost' = admitted(p, t, tb).with("early", ghost.early or tb.seq > ev.serving) },
      },
      ctl' = ctl, env' = env,
    }
  }

  // ① 회차 슬롯 확인(읽기만, PRECHECK): 거절이면 409, 차례 전이면 NOT_YET(걸음 아님), 아니면 다음 호출로
  action admitCheck(p: int, t: int): bool = {
    val tb = tab(p, t)
    all {
      ADMIT_STEPS,
      tb.phase == "HELD",
      if (rejected(tb)) setTab(p, t, tb.with("phase", "DONE"))
      else all { turnCome(tb), setTab(p, t, tb.with("phase", "CHECKED")) },
      evKeep, psKeep, ctl' = ctl, env' = env, ghost' = ghost,
    }
  }

  // ② 사람 슬롯 q:adm(CLAIM): 비었으면 채움(NEW), 같은 대기표면 SAME, 다른 대기표면 DUP → 빠진 번호로 돌리고 409
  action admitClaim(p: int, t: int): bool = {
    val tb = tab(p, t)
    val r = pss.get(p)
    val me = meOf(t, tb)
    all {
      ADMIT_STEPS,
      tb.phase == "CHECKED",
      if (r.adm.kind == "NONE")
        all { psWrite(p, r.with("adm", me)), setTab(p, t, tb.with("phase", "CLAIMED").with("own", true)), evKeep }
      else if (ADMISSION_RECHECK and dupClaim(r, me))
        all { psKeep, setTab(p, t, tb.with("phase", "DONE")), evWrite(ev.with("removed", ev.removed.union(Set(tb.seq)))) }
      else
        all { psKeep, setTab(p, t, tb.with("phase", "CLAIMED").with("own", false)), evKeep },
      ctl' = ctl, env' = env, ghost' = ghost,
    }
  }

  // ③ 회차 슬롯 입장(ADMIT): serving·빠진 번호를 다시 보고, 빈자리가 있으면(ok) 자리를 잡고, 없으면 곧 입장(SOON).
  // 자리를 받지 못하면 이 요청이 채운 q:adm만 되돌린다(RELEASING 뒤 SOON·NOT_YET은 HELD로, REMOVED는 DONE으로)
  action admitSlot(p: int, t: int, ok: bool): bool = {
    val tb = tab(p, t)
    val gone = ev.removed.contains(tb.seq)
    val after = if (gone) "DONE" else "HELD"
    all {
      ADMIT_STEPS,
      tb.phase == "CLAIMED",
      if (not(gone) and turnCome(tb) and ok)
        all { setTab(p, t, tb.with("phase", "SLOTTED")), ghost' = ghost.with("early", ghost.early or tb.seq > ev.serving) }
      else
        all { (not(gone) and turnCome(tb)) implies not(ok),
              setTab(p, t, if (tb.own) tb.with("phase", "RELEASING").with("after", after) else tb.with("phase", after)),
              ghost' = ghost },
      evKeep, psKeep, ctl' = ctl, env' = env,
    }
  }

  // ④ 사람 슬롯 마무리(SETTLE ADMITTED): 입장 토큰을 낸다
  action admitSettle(p: int, t: int): bool = {
    val tb = tab(p, t)
    all {
      ADMIT_STEPS,
      tb.phase == "SLOTTED",
      setTab(p, t, tb.with("phase", "ADMITTED")),
      psWrite(p, settled(pss.get(p), meOf(t, tb))),
      ghost' = admitted(p, t, tb),
      evKeep, ctl' = ctl, env' = env,
    }
  }

  // ④ 사람 슬롯 되돌리기(SETTLE RELEASE): 값이 이 요청이 채운 그대로일 때만 지운다
  action admitRelease(p: int, t: int): bool = {
    val tb = tab(p, t)
    val r = pss.get(p)
    all {
      ADMIT_STEPS,
      tb.phase == "RELEASING",
      setTab(p, t, tb.with("phase", tb.after).with("own", false).with("after", "")),
      if (r.adm == meOf(t, tb)) psWrite(p, r.with("adm", EMPTY)) else psKeep,
      evKeep, ctl' = ctl, env' = env, ghost' = ghost,
    }
  }

  // nondet은 쓰는 동작 묶음 안에 둔다(맨 위에 두면 모든 동작이 쓰지 않는 nondet 조합 수만큼 같은 다음 상태를 다시 만들어 TLC가 몇 배 느려진다)
  action step = any {
    nondet k = TICKETS.oneOf()
    nondet ok = Set(true, false).oneOf()
    any {
      enterPreempt(k._1, k._2), enterNumber(k._1, k._2), enterRecord(k._1, k._2), enterBatchRecord(k._1, k._2), batchMissing(k._1, k._2),
      leave(k._1, k._2), takeBatchResult(k._1, k._2),
      admit(k._1, k._2), admitCheck(k._1, k._2), admitClaim(k._1, k._2), admitSlot(k._1, k._2, ok), admitSettle(k._1, k._2), admitRelease(k._1, k._2),
    },
    nondet p = PERSONS.oneOf()
    any { pendingExpires(p), replicatePerson(p), failoverPerson(p) },
    nondet c = CTRLS.oneOf()
    any { acquire(c), plan(c, "ADVANCE"), plan(c, "CLOSE"), applyWrite(c) },
    nondet j = EPOCH_JUMPS.oneOf()
    failoverEv(j),
    windowEnds, publishBatch, replicateEv, rb05,
  }

  // ---- 언제나 참(docs/verification.md §2.1 `queue` ①~④) ----
  // ① 차례 전 입장 0: 자리를 받을 때 번호가 그 시각 serving 이하(QR-FS-5). 이 불변식은 입장 확정이 그 순간의 serving과 견주는지
  //   (확인 장치)를 본다. serving 값 자체가 옛 리더 쓰기로 앞서 나가는 몫은 ③이 센다(코드 리뷰 2026-11-02)
  val inv_noAdmissionBeforeTurn = not(ghost.early)
  // ② 같은 세대 안 순번 중복 0: 내준 대기표 가운데 (번호, 세대)가 같은 것은 같은 탭의 것뿐
  val inv_noDuplicateNumberInGeneration = ghost.issued.forall(a => ghost.issued.forall(b =>
    (a.seq == b.seq and a.gen == b.gen) implies (a.pid == b.pid and a.tab == b.tab)))
  // ③ 옛 리더 쓰기: 장애 전환이 없으면 반영 0, 있으면 회차 슬롯 장애 전환마다 많아야 1회(ADR-0056 '남는 한계').
  //   '옛 리더 쓰기'는 더 큰 리더 세대의 쓰기가 반영된 뒤에 반영된 작은 세대의 쓰기다
  val inv_staleLeaderWritesBounded =
    (env.evFailovers == 0 implies ghost.staleApplied == 0) and ghost.staleApplied <= env.evFailovers
  // ④ 입장 키(q:adm)를 잃는 장애 전환이 없으면 한 사람의 입장은 대기표 하나
  val inv_onePersonOneAdmission = PERSONS.forall(p =>
    not(ghost.admLost.contains(p)) implies ghost.admittedBy.get(p).size() <= 1)

  // ⑤ 1인 1순번(POL-002): 사람 슬롯 장애 전환으로 q:dup·q:adm이 바뀌지 않았으면, 한 사람이 가진 자리(대기표·묶음 자리·입장)는 하나 이하.
  //   정본은 두 장이 장애 전환으로만 생긴다고 본다(ADR-0056 맥락·재검토 조건). §2.1 표에 없지만 그 주장을 검사하려고 더했다.
  //   번호를 받고 기록 전(NUMBERED·SADDED)은 세지 않는다(기록이 실패하면 그 번호는 빠진 번호가 된다)
  val HOLDING = Set("BATCHED", "HELD", "CHECKED", "CLAIMED", "SLOTTED", "RELEASING", "ADMITTED")
  val inv_onePersonOneTicket = PERSONS.forall(p =>
    not(ghost.dupLost.contains(p) or ghost.admLost.contains(p)) implies
      TICKETS.filter(k => k._1 == p and HOLDING.contains(tabs.get(k).phase)).size() <= 1)

  val safety = inv_noAdmissionBeforeTurn and inv_noDuplicateNumberInGeneration and inv_staleLeaderWritesBounded and inv_onePersonOneAdmission
               and inv_onePersonOneTicket

  // ---- 결국 일어남(진행성, wbs 2.3.4): 공정성 가정 아래에서 ----
  val vars = (ev, evRep, evPend, pss, pssRep, tabs, ctl, env, ghost)
  def waiting(k: (int, int)): bool = Set("PREEMPTED", "NUMBERED", "SADDED", "BATCHED").contains(tabs.get(k).phase)
  // 진입한 탭은 결국 대기표를 받거나 끝나고(409·다시 진입 안내), 대기표를 든 탭은 결국 차례가 온다(serving이 멈추지 않으면 앞사람부터 입장 자격).
  // 장애 전환으로 잃은 번호도 RB-05의 건너뛰기가 덮어야 serving이 그 번호에 닿는다
  temporal liveness = TICKETS.forall(k => and {
    always(waiting(k) implies eventually(not(waiting(k)))),
    always(tabs.get(k).phase == "HELD" implies eventually(tabs.get(k).phase != "HELD" or tabs.get(k).seq <= ev.serving)),
  })
  // 공정성: 시스템이 하는 일(진입 ②③·묶음 기록·결과 받기·다시 진입 안내, 리더 루프와 묶음 게시, 복제, RB-05)과 시간의 흐름(선점 수명, 묶음 구간 끝)은 할 수 있는 동안
  // 결국 일어난다. RB-05는 진입 ②가 RECOVERING을 받을 때와 리더가 회차마다 1초에 한 번 부른다(새 진입이 없는 조용한 회차에도, ADR-0184).
  // 사람의 동작(진입 시작·이탈·입장 확정)과 장애 전환에는 두지 않는다
  temporal fairness = and {
    TICKETS.forall(k => and {
      weakFair(enterNumber(k._1, k._2), vars), weakFair(enterRecord(k._1, k._2), vars), weakFair(enterBatchRecord(k._1, k._2), vars),
      weakFair(takeBatchResult(k._1, k._2), vars), weakFair(batchMissing(k._1, k._2), vars),
    }),
    PERSONS.forall(p => and { weakFair(pendingExpires(p), vars), weakFair(replicatePerson(p), vars) }),
    CTRLS.forall(c => and { weakFair(acquire(c), vars), weakFair(plan(c, "ADVANCE"), vars), weakFair(plan(c, "CLOSE"), vars), weakFair(applyWrite(c), vars) }),
    weakFair(windowEnds, vars), weakFair(publishBatch, vars), weakFair(replicateEv, vars), weakFair(rb05, vars),
  }
  temporal fairLiveness = fairness implies liveness
}

// ---- 검사 모듈(specs/specs.json이 고른다) ----
// 전수 검사(TLC)는 범위를 나눈다(작은 범위 확정, 추천 적용 2026-11-02, specs/README.md):
//   진입 범위: 사람 2명(한 사람은 탭 2개, 대기표 3장), admission-ctrl 1대(교체 없음), 장애 전환 2회(회차·사람 슬롯), 입장 확정 한 걸음.
//             대기표 4장은 상태가 4천만 개를 넘어도 끝나지 않아(2026-11-02 측정) 한 장을 줄였다
//   리더 범위: 사람 1명(대기표 1장), admission-ctrl 2대, 리더 교체 2회, 회차 슬롯 장애 전환 2회
//   입장 확정 범위(PRF-120): 사람 1명(탭 2개), 묶음 없음, 장애 전환 2회, 입장 확정 네 호출
//   복제 지연 두 쓰기 범위(PRF-120): 사람 2명(탭 1개씩), 장애 전환 2회(회차 슬롯), RB-05 자체를 잃는 연속 장애 전환
//   진행성 범위(PRF-120): 사람 2명(탭 1개씩), 장애 전환 1회(회차 슬롯), 공정성 가정 아래 TLC 진행성 검사
// 정본 범위 전체(사람 2명·탭 2개씩, ctrl 2대, 장애 전환 2회, 리더 교체 2회, 입장 확정 네 호출, 설정 세대가 한 번에 3까지 오름)는 시뮬레이션이 본다(`*_full`)

// 정본에 적힌 그대로(구현과 같음): RB-05가 끝날 때까지 그 회차의 번호를 내지 않고(ADR-0181), 묶음 참가자의 선점 값은 묶음 기록으로 바꾼다(PRF-060)
module queue_canon {
  import queue(TICKETS = Set((1, 1), (1, 2), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 2, PERSON_FAILOVERS = true, MAX_LEADER_CHANGES = 0,
               LAG = 1, EPOCH_JUMPS = Set(1), OPEN_BATCH = true, ADMIT_STEPS = true,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true,
               EPOCH_MULTIPLIER = true, MISSING_CHECK = true).*
}

// 정본이 묶음 기록을 정하기 전(2026-11-02)에는 1인 1순번 장치가 없어 ⑤ 반례(결과 게시 전에 선점이 만료돼 같은 사람이 대기표를 하나 더 받음)가 나왔다.
// 지금 정본은 그 장치를 켰다(진입 범위, 입장 확정 한 걸음)
module queue_canon_batch_dup {
  import queue(TICKETS = Set((1, 1), (1, 2), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 2, PERSON_FAILOVERS = true, MAX_LEADER_CHANGES = 0,
               LAG = 1, EPOCH_JUMPS = Set(1), OPEN_BATCH = true, ADMIT_STEPS = false,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true,
               EPOCH_MULTIPLIER = true, MISSING_CHECK = true).*
}

// 진입 범위(전수 검사)
module queue_proposed {
  import queue(TICKETS = Set((1, 1), (1, 2), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 2, PERSON_FAILOVERS = true, MAX_LEADER_CHANGES = 0,
               LAG = 1, EPOCH_JUMPS = Set(1), OPEN_BATCH = true, ADMIT_STEPS = false,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true,
               EPOCH_MULTIPLIER = true, MISSING_CHECK = true).*
}

// RB-05를 기다리지 않는 변형(반례 기대): RB-05 전에도 번호를 낸다(2026-11-02 정본 그대로). 이 장치가 살아 있는지 본다(ADR-0181)
module queue_no_rb05_wait {
  import queue(TICKETS = Set((1, 1), (1, 2), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 2, PERSON_FAILOVERS = true, MAX_LEADER_CHANGES = 0,
               LAG = 1, EPOCH_JUMPS = Set(1), OPEN_BATCH = true, ADMIT_STEPS = false,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = false, ONE_PERSON_GUARDS = true,
               EPOCH_MULTIPLIER = true, MISSING_CHECK = true).*
}

// 리더 범위
module queue_leader {
  import queue(TICKETS = Set((1, 1)), CTRLS = Set(1, 2), MAX_FAILOVERS = 2, PERSON_FAILOVERS = false, MAX_LEADER_CHANGES = 2,
               LAG = 1, EPOCH_JUMPS = Set(1), OPEN_BATCH = true, ADMIT_STEPS = false,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true,
               EPOCH_MULTIPLIER = true, MISSING_CHECK = true).*
}

// 입장 확정 범위(PRF-120): 장애 전환으로 대기표를 두 장 받은 사람의 두 탭이 네 호출을 섞어 보낸다
module queue_admit {
  import queue(TICKETS = Set((1, 1), (1, 2)), CTRLS = Set(1), MAX_FAILOVERS = 2, PERSON_FAILOVERS = true, MAX_LEADER_CHANGES = 0,
               LAG = 1, EPOCH_JUMPS = Set(1), OPEN_BATCH = false, ADMIT_STEPS = true,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true,
               EPOCH_MULTIPLIER = true, MISSING_CHECK = true).*
}

// 복제 지연 두 쓰기 범위(PRF-120): RB-05의 쓰기와 그 뒤 번호를 함께 잃는 연속 장애 전환
module queue_lag2 {
  import queue(TICKETS = Set((1, 1), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 2, PERSON_FAILOVERS = false, MAX_LEADER_CHANGES = 0,
               LAG = 2, EPOCH_JUMPS = Set(1), OPEN_BATCH = true, ADMIT_STEPS = false,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true,
               EPOCH_MULTIPLIER = true, MISSING_CHECK = true).*
}

// 정본 범위 전체(시뮬레이션만)
module queue_proposed_full {
  import queue(TICKETS = Set((1, 1), (1, 2), (2, 1), (2, 2)), CTRLS = Set(1, 2), MAX_FAILOVERS = 2, PERSON_FAILOVERS = true, MAX_LEADER_CHANGES = 2,
               LAG = 1, EPOCH_JUMPS = Set(1, 3), OPEN_BATCH = true, ADMIT_STEPS = true,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true,
               EPOCH_MULTIPLIER = true, MISSING_CHECK = true).*
}

// 진행성 범위(PRF-120, TLC 진행성 검사)
module queue_live {
  import queue(TICKETS = Set((1, 1), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 1, PERSON_FAILOVERS = false, MAX_LEADER_CHANGES = 0,
               LAG = 1, EPOCH_JUMPS = Set(1), OPEN_BATCH = true, ADMIT_STEPS = false,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true,
               EPOCH_MULTIPLIER = true, MISSING_CHECK = true).*
}

// 변형(검사가 살아 있는지, V-T1): 하나씩 끄면 그 불변식의 반례가 나와야 한다
module queue_no_fencing {
  import queue(TICKETS = Set((1, 1)), CTRLS = Set(1, 2), MAX_FAILOVERS = 2, PERSON_FAILOVERS = false, MAX_LEADER_CHANGES = 2,
               LAG = 1, EPOCH_JUMPS = Set(1), OPEN_BATCH = true, ADMIT_STEPS = false,
               FENCING = false, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true,
               EPOCH_MULTIPLIER = true, MISSING_CHECK = true).*
}

module queue_no_serving_check {
  import queue(TICKETS = Set((1, 1), (1, 2), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 2, PERSON_FAILOVERS = true, MAX_LEADER_CHANGES = 0,
               LAG = 1, EPOCH_JUMPS = Set(1), OPEN_BATCH = true, ADMIT_STEPS = false,
               FENCING = true, SERVING_CHECK = false, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true,
               EPOCH_MULTIPLIER = true, MISSING_CHECK = true).*
}

module queue_no_admission_recheck {
  import queue(TICKETS = Set((1, 1), (1, 2), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 2, PERSON_FAILOVERS = true, MAX_LEADER_CHANGES = 0,
               LAG = 1, EPOCH_JUMPS = Set(1), OPEN_BATCH = true, ADMIT_STEPS = false,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = false, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true,
               EPOCH_MULTIPLIER = true, MISSING_CHECK = true).*
}

// 설정 세대 곱하기를 뺀 변형(반례 기대, PRF-120): RB-05의 쓰기와 그 뒤 번호를 함께 잃으면 다음 RB-05가 같은 번호·세대를 다시 낸다(ADR-0181 결정 4)
module queue_lag2_no_multiplier {
  import queue(TICKETS = Set((1, 1), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 2, PERSON_FAILOVERS = false, MAX_LEADER_CHANGES = 0,
               LAG = 2, EPOCH_JUMPS = Set(1), OPEN_BATCH = false, ADMIT_STEPS = false,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true,
               EPOCH_MULTIPLIER = false, MISSING_CHECK = true).*
}

// 다시 진입을 뺀 변형(진행성 반례 기대, PRF-120): SADD를 잃은 묶음 참가자가 번호도 다시 진입도 없이 남는다
module queue_live_no_missing_check {
  import queue(TICKETS = Set((1, 1), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 1, PERSON_FAILOVERS = false, MAX_LEADER_CHANGES = 0,
               LAG = 1, EPOCH_JUMPS = Set(1), OPEN_BATCH = true, ADMIT_STEPS = false,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true,
               EPOCH_MULTIPLIER = true, MISSING_CHECK = false).*
}

// 설정 세대가 한 번에 여럿 오르는 복제 지연 두 쓰기 범위(반례 기대, PRF-120 새 맥락 리뷰): 첫 장애 전환에서 설정 세대가 3 이상 오르면 곱하기 상한 3을
// 이미 다 써서, RB-05의 쓰기와 그 뒤 번호를 함께 잃은 다음 RB-05가 같은 구간을 건너뛰어 같은 번호·세대를 다시 낸다. 설정 세대 차는 잃은 RB-05 수를
// 세지 못한다(새로 만든 클러스터는 한 번에도 3 이상, ADR-0181 '측정'). 고칠 길은 docs/review/open-items.md 105번(소유자 결정 대기)
module queue_lag2_jump {
  import queue(TICKETS = Set((1, 1), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 2, PERSON_FAILOVERS = false, MAX_LEADER_CHANGES = 0,
               LAG = 2, EPOCH_JUMPS = Set(1, 3), OPEN_BATCH = false, ADMIT_STEPS = false,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true,
               EPOCH_MULTIPLIER = true, MISSING_CHECK = true).*
}
