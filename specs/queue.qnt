// -*- mode: Bluespec; -*-
// 대기열·입장 제어 명세(wbs 0.9.1, docs/verification.md §2.1 `queue`).
// 근거: ADR-0002(순번 카운터), ADR-0041(동시 도착 구간 묶음), ADR-0056(리더 세대 펜싱, 입장 확정 때 1인 1순번 재확인),
//       docs/features/queue-admission.md §3(진입 ①②③, 묶음, 장애 전환·세대)·§5(리더 루프)·§6(입장 확정), docs/infra.md RB-05.
// 읽는 법은 specs/README.md. 이 파일은 정본이 아니다. 정본과 다르면 정본이 이기고, 이 파일을 고친다.
//
// 모형으로 줄인 것:
// - 시간: 15분 입장 기한, 판매 종료, PENDING 수명 10초, 묶음 구간 N초는 '언제든 끝날 수 있음'으로만 둔다.
// - 대기열 Redis는 회차 슬롯(`{event:E}`) 샤드 하나와 사람마다 사람 슬롯(`{pid}`: q:dup, q:adm) 샤드 하나다.
//   복제는 비동기이고 순서대로 간다. 복제 지연은 '쓰기 하나'까지로 둔다: 주 노드에 쓰면 복제본은 그 쓰기 직전 상태가 되고,
//   복제 걸음이 따라잡게 한다. 장애 전환은 복제본을 주 노드로 올려 따라잡지 못한 쓰기 하나를 잃는다(잃는 양이 더 커도
//   이 명세가 보는 반례는 쓰기 하나를 잃을 때 이미 나온다. 잃는 번호의 양은 RB-05의 K가 덮는다고 둔다).
// - 한 Lua 안의 일은 한 걸음(원자)이다. 서로 다른 슬롯에 걸친 일(진입 ①②③)은 걸음을 나눈다. 다만 ③ 실패 뒤 빠진 번호 등록, 이탈,
//   입장 확정의 회차 슬롯 확인과 사람 슬롯 재확인은 한 걸음으로 묶었다(그 사이의 장애 전환은 따로 보지 않는다).
// - 리더 쓰기는 'Lease 재확인 → (멈출 수 있음) → 세대 확인 Lua' 두 걸음이다. 그 사이에 무엇이든 끼어든다(멈췄다 깨어난 옛 리더).
//   serving 전진 폭은 1이다(더 큰 폭은 여러 번 전진한 것과 같은 serving에 닿고, ③은 폭이 아니라 반영된 쓰기 수를 센다).
// - 탭 하나는 기기 하나다. 묶음 참가자는 사전 검증 토큰 해시라(queue-admission §3) 탭마다 따로 센다(같은 기기의 두 탭이 토큰 하나를
//   나눠 쓰는 경우는 참가자 하나라 이 모형의 부분이다).
// - RB-05(장애 전환 뒤 카운터 건너뛰기·세대 올리기)의 건너뛰는 양 K는 잃은 번호를 덮는다고 둔다(정본의 가정.
//   덮지 못해 번호가 겹쳐도 세대가 달라 ②는 깨지지 않는다, queue-admission §3 '남는 한계'). RB-05는 리더가 아닌 자동 작업이다.
// 뺀 것: 로비 셔플(ADR-0064), 추가 검증(§7), 진입 Degraded 도착 시각 칸(§9), 같은 요청 ID 재시도, 리더 상태 기록(일시정지·목표,
//        ADR-0056 결정 4), 입장 자리·곧 입장(ADR-0104), 15분 기한, 진행성(specs/README.md). 필요하면 0.9.2·5.2.2·2.3.4에서 더한다.
module queue {
  // ---- 범위(작은 범위, docs/verification.md §2.1. 검사 모듈이 정한다) ----
  const TICKETS: Set[(int, int)] // (사람, 탭). 탭마다 진입 시도 하나(요청 ID 하나)
  const CTRLS: Set[int]          // admission-ctrl 파드
  const MAX_FAILOVERS: int       // 대기열 Redis 장애 전환(샤드 상관없이 합)
  const PERSON_FAILOVERS: bool   // 사람 슬롯 샤드도 장애 전환하는지
  const MAX_LEADER_CHANGES: int  // 리더 교체 횟수(첫 리더 뒤)
  // ---- 설계 장치(하나씩 끈 변형으로 검사가 살아 있는지 본다, V-T1) ----
  const FENCING: bool            // 리더 쓰기 Lua의 세대 확인(ADR-0056 결정 2)
  const SERVING_CHECK: bool      // 입장 확정의 '내 번호 ≤ serving'(queue-admission §6)
  const ADMISSION_RECHECK: bool  // 입장 확정의 q:adm 재확인(ADR-0056 결정 5)
  const ENTRY_WAITS_RB05: bool   // 장애 전환 뒤 RB-05가 끝날 때까지 번호를 내지 않음(정본에 없음, PROGRESS OPEN[13])
  // 1인 1순번 장치(정본에 없음, PROGRESS OPEN[14]의 추천안): 묶음에 넣은 뒤 사람 슬롯의 PENDING을 묶음 기록(판매 종료 수명)으로 바꾸고,
  // ③과 묶음 기록도 q:adm이 비었는지 보고, 닫힌 묶음 결과에 없는 참가는 묶음 기록을 지워 다시 진입하게 한다
  const ONE_PERSON_GUARDS: bool

  // ---- 값 ----
  type Slot = { kind: str, tab: int, seq: int, gen: int }   // q:dup·q:adm 값. kind: NONE·PENDING·REC(번호 기록)·BATCH(묶음 기록)·ADM(입장한 대기표)
  type PRec = { dup: Slot, adm: Slot }
  type Range = { start: int, end: int, gen: int }          // q:{event:E}:skipped 한 줄
  // 회차 슬롯: 카운터, serving, 리더 세대, 건너뛴 구간, 빠진 번호, 묶음 닫힘 표시와 참가자
  type Ev = { seq: int, serving: int, leader: int, skips: Set[Range], removed: Set[int],
              closed: bool, first: int, size: int, members: Set[(int, int)] }
  // 탭(브라우저와 그 요청을 처리하는 queue-svc). phase: IDLE·PREEMPTED·NUMBERED·SADDED(묶음에 넣고 기록 전)·BATCHED·HELD·ADMITTED·DONE(409·이탈로 끝남)
  type Tab = { phase: str, seq: int, gen: int }
  type Ctrl = { gen: int, op: str }                        // op: NONE·BUMP·ADVANCE·CLOSE(Lease를 확인하고 아직 Lua를 보내지 않은 쓰기)
  type Ctl = { holder: int, transitions: int, acquisitions: int, c: int -> Ctrl }
  type Env = { windowOpen: bool, rb05Due: bool, evFailovers: int, psFailovers: int }
  type Ticket = { pid: int, tab: int, seq: int, gen: int }
  type Batch = { closed: bool, first: int, size: int, gen: int }
  // 검사에만 쓰는 기록(시스템이 아는 값이 아니다). admittedBy: 사람마다 입장한 (탭, 번호, 세대), dupLost: 장애 전환으로 q:dup이 바뀐 사람,
  // early: 입장 확정 때 번호가 serving보다 컸던 적이 있음, batchTruth: 처음 닫힌 묶음(결과 파일·머클 루트가 이 값으로 게시된다)
  type Ghost = { issued: Set[Ticket], admittedBy: int -> Set[(int, int, int)], early: bool, staleApplied: int, maxGenSeen: int,
                 admLost: Set[int], dupLost: Set[int], batchTruth: Batch, maxNumber: int }

  pure val EMPTY: Slot = { kind: "NONE", tab: 0, seq: 0, gen: 0 }
  pure val NOOP: Ctrl = { gen: 0, op: "NONE" }
  pure val PERSONS: Set[int] = TICKETS.map(k => k._1)
  pure def maxI(a: int, b: int): int = if (a > b) a else b
  // 묶음 안 순서(셔플 결과). 안전성과 상관없어 (사람, 탭) 순으로 둔다
  pure def keyOf(k: (int, int)): int = k._1 * 100 + k._2
  pure def rankIn(m: Set[(int, int)], k: (int, int)): int = m.filter(q => keyOf(q) < keyOf(k)).size()

  var ev: Ev
  var evRep: Ev
  var pss: int -> PRec
  var pssRep: int -> PRec
  var tabs: (int, int) -> Tab
  var ctl: Ctl
  var env: Env
  var ghost: Ghost

  // 지금 대기표 세대 = 건너뛴 구간 줄 수 + 1(docs/data.md q:{event:E}:skipped)
  def curGen: int = ev.skips.size() + 1
  def tab(p: int, t: int): Tab = tabs.get((p, t))

  // ---- 저장소 쓰기(복제 지연 쓰기 하나) ----
  action evWrite(e2: Ev): bool = all { ev' = e2, evRep' = if (e2 == ev) evRep else ev }
  action evKeep: bool = all { ev' = ev, evRep' = evRep }
  action psWrite(p: int, r2: PRec): bool = all {
    pss' = pss.set(p, r2),
    pssRep' = if (r2 == pss.get(p)) pssRep else pssRep.set(p, pss.get(p)),
  }
  action psKeep: bool = all { pss' = pss, pssRep' = pssRep }

  action init = {
    val ev0: Ev = { seq: 0, serving: 0, leader: 0, skips: Set(), removed: Set(), closed: false, first: 0, size: 0, members: Set() }
    val p0: PRec = { dup: EMPTY, adm: EMPTY }
    all {
      ev' = ev0,
      evRep' = ev0,
      pss' = PERSONS.mapBy(p => p0),
      pssRep' = PERSONS.mapBy(p => p0),
      tabs' = TICKETS.mapBy(k => { phase: "IDLE", seq: 0, gen: 0 }),
      ctl' = { holder: 0, transitions: 0, acquisitions: 0, c: CTRLS.mapBy(c => NOOP) },
      env' = { windowOpen: true, rb05Due: false, evFailovers: 0, psFailovers: 0 },
      ghost' = { issued: Set(), admittedBy: PERSONS.mapBy(p => Set()), early: false, staleApplied: 0, maxGenSeen: 0,
                 admLost: Set(), dupLost: Set(), batchTruth: { closed: false, first: 0, size: 0, gen: 0 }, maxNumber: 0 },
    }
  }

  // 묶음 닫기(구간이 닫히는 순간 카운터를 몫만큼 떼고 표시를 남긴다. HSETNX라 표시가 있으면 아무것도 안 한다, 중간-028)
  def closeBatch(e: Ev): Ev =
    if (e.closed) e
    else e.with("closed", true).with("first", e.seq + 1).with("size", e.members.size()).with("seq", e.seq + e.members.size())
  def noteBatch(g: Ghost, e: Ev): Ghost =
    if (g.batchTruth.closed or not(e.closed)) g
    else g.with("batchTruth", { closed: true, first: e.first, size: e.size, gen: curGen })

  // ---- 진입 ① 사람 슬롯 Lua: 이미 입장했거나 다른 요청이 선점했으면 409, 비었으면 PENDING:{요청 ID}로 선점 ----
  action enterPreempt(p: int, t: int): bool = {
    val r = pss.get(p)
    all {
      tab(p, t).phase == "IDLE",
      if (r.adm.kind != "NONE" or r.dup.kind != "NONE")
        all { tabs' = tabs.set((p, t), tab(p, t).with("phase", "DONE")), psKeep }
      else
        all { psWrite(p, r.with("dup", { kind: "PENDING", tab: t, seq: 0, gen: 0 })),
              tabs' = tabs.set((p, t), tab(p, t).with("phase", "PREEMPTED")) },
      evKeep, ctl' = ctl, env' = env, ghost' = ghost,
    }
  }

  // PENDING 수명(10초)이 지남
  action pendingExpires(p: int): bool = all {
    pss.get(p).dup.kind == "PENDING",
    psWrite(p, pss.get(p).with("dup", EMPTY)),
    evKeep, tabs' = tabs, ctl' = ctl, env' = env, ghost' = ghost,
  }

  // ---- 진입 ② 회차 슬롯 Lua: 구간 안이면 묶음에 SADD(202), 아니면 표시를 보고(없으면 먼저 닫고) INCR ----
  action enterNumber(p: int, t: int): bool = all {
    tab(p, t).phase == "PREEMPTED",
    if (env.windowOpen and not(ev.closed))
      all { evWrite(ev.with("members", ev.members.union(Set((p, t))))),
            tabs' = tabs.set((p, t), tab(p, t).with("phase", if (ONE_PERSON_GUARDS) "SADDED" else "BATCHED")),
            ghost' = ghost }
    else all {
      not(env.windowOpen) or ev.closed,
      not(ENTRY_WAITS_RB05 and env.rb05Due),   // (OPEN[13]의 추천안) RB-05 전에는 503으로 다시 오게 한다
      val e1 = closeBatch(ev)
      val n = e1.seq + 1
      all {
        evWrite(e1.with("seq", n)),
        tabs' = tabs.set((p, t), { phase: "NUMBERED", seq: n, gen: curGen }),
        ghost' = noteBatch(ghost, e1).with("maxNumber", maxI(ghost.maxNumber, n)),
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
      // (OPEN[14]의 추천안) 같은 Lua에서 q:adm도 본다: 이미 입장한 사람의 멈춰 있던 다른 요청이 번호를 기록하지 못하게
      if ((r.dup.kind == "NONE" or (r.dup.kind == "PENDING" and r.dup.tab == t)) and (not(ONE_PERSON_GUARDS) or r.adm.kind == "NONE"))
        all { psWrite(p, r.with("dup", { kind: "REC", tab: t, seq: tb.seq, gen: tb.gen })),
              tabs' = tabs.set((p, t), tb.with("phase", "HELD")),
              evKeep,
              ghost' = ghost.with("issued", ghost.issued.union(Set({ pid: p, tab: t, seq: tb.seq, gen: tb.gen }))) }
      else
        all { psKeep, tabs' = tabs.set((p, t), tb.with("phase", "DONE")),
              evWrite(ev.with("removed", ev.removed.union(Set(tb.seq)))), ghost' = ghost },
      ctl' = ctl, env' = env,
    }
  }

  // (OPEN[14]의 추천안) 묶음 기록 사람 슬롯 Lua: PENDING:{내 요청 ID}이거나 비었으면 묶음 기록(판매 종료 수명)으로 바꾸고 202,
  // 아니면(그사이 수명이 지난 선점을 다른 요청이 차지했거나 이미 입장함) 409. 묶음 몫의 그 자리는 아무도 갖지 않은 번호가 된다
  // (②와 ③ 사이 틈과 같다. 결과 파일의 그 자리는 202 응답으로 받은 참가로만 쓴다고 둔다, OPEN[14])
  action enterBatchRecord(p: int, t: int): bool = {
    val r = pss.get(p)
    all {
      tab(p, t).phase == "SADDED",
      if ((r.dup.kind == "NONE" or (r.dup.kind == "PENDING" and r.dup.tab == t)) and r.adm.kind == "NONE")
        all { psWrite(p, r.with("dup", { kind: "BATCH", tab: t, seq: 0, gen: 0 })), tabs' = tabs.set((p, t), tab(p, t).with("phase", "BATCHED")) }
      else
        all { psKeep, tabs' = tabs.set((p, t), tab(p, t).with("phase", "DONE")) },
      evKeep, ctl' = ctl, env' = env, ghost' = ghost,
    }
  }

  // (OPEN[14]의 추천안) 닫힌 묶음 결과에 내 참가가 없으면(장애 전환으로 SADD를 잃음) 묶음 기록을 지우고 다시 진입하라고 안내한다.
  // 묶음 기록은 판매 종료까지 남으므로, 지우지 않으면 그 사람은 판매 종료까지 409를 받는다
  action batchMissing(p: int, t: int): bool = {
    val r = pss.get(p)
    all {
      ONE_PERSON_GUARDS,
      tab(p, t).phase == "BATCHED",
      ghost.batchTruth.closed,
      ev.closed,
      not(ev.members.contains((p, t))),
      tabs' = tabs.set((p, t), tab(p, t).with("phase", "DONE")),
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
      tabs' = tabs.set((p, t), tb.with("phase", "DONE")),
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

  // 묶음 결과 게시: 닫힌 묶음의 참가자 탭이 결과 파일의 순번을 받는다(탭마다 따로 걸음으로). 결과는 공시한 시드로 정해져
  // 두 번 써도 같으므로 세대 확인 없이 쓴다(ADR-0056 결정 2). 게시는 사람 슬롯(q:dup)을 쓰지 않는다(정본에 없다)
  action publishBatch(p: int, t: int): bool = {
    val b = ghost.batchTruth
    val n = b.first + rankIn(ev.members, (p, t))
    all {
      b.closed,
      tab(p, t).phase == "BATCHED",
      ev.members.contains((p, t)),
      tabs' = tabs.set((p, t), { phase: "HELD", seq: n, gen: b.gen }),
      psKeep,
      ghost' = ghost.with("issued", ghost.issued.union(Set({ pid: p, tab: t, seq: n, gen: b.gen })))
                    .with("maxNumber", maxI(ghost.maxNumber, b.first + b.size - 1)),
      evKeep, ctl' = ctl, env' = env,
    }
  }

  // ---- 리더 ----
  // Lease 얻기: 지금 보유자가 멈추거나 갱신하지 못하면 다른 파드가 얻는다. leaseTransitions + 1이 리더 세대다(ADR-0056 결정 1).
  // 새 리더는 진행 중인 회차의 세대부터 올린다(결정 3). 쓰기 하나를 보내는 중인 파드는 그 쓰기를 마치기 전에는 다시 얻지 않는다
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
    if (op == "ADVANCE") ev.seq > ev.serving else all { not(env.windowOpen), not(ev.closed) },
    ctl' = ctl.with("c", ctl.c.set(c, ctl.c.get(c).with("op", op))),
    evKeep, psKeep, tabs' = tabs, env' = env, ghost' = ghost,
  }

  // 세대 확인 Lua(ADR-0056 결정 2): 내 세대가 저장된 세대보다 작으면 아무것도 쓰지 않고 FENCED(파드는 루프를 멈춘다),
  // 아니면 저장된 세대를 내 세대로 올리고 쓴다. serving 전진과 묶음 카운터 전진(HSETNX)이 대상이다
  action applyWrite(c: int): bool = {
    val w = ctl.c.get(c)
    val fenced = FENCING and w.gen < ev.leader
    val e1 = ev.with("leader", maxI(ev.leader, w.gen))
    val e2 = if (w.op == "ADVANCE") e1.with("serving", e1.serving + 1)
             else if (w.op == "CLOSE") closeBatch(e1)
             else e1
    all {
      w.op != "NONE",
      ctl' = ctl.with("c", ctl.c.set(c, NOOP.with("gen", w.gen))),
      if (fenced) all { evKeep, ghost' = ghost }
      else all {
        evWrite(e2),
        ghost' = noteBatch(ghost, e2)
                   .with("staleApplied", if (w.gen < ghost.maxGenSeen) ghost.staleApplied + 1 else ghost.staleApplied)
                   .with("maxGenSeen", maxI(ghost.maxGenSeen, w.gen)),
      },
      psKeep, tabs' = tabs, env' = env,
    }
  }

  // ---- 대기열 Redis 복제와 장애 전환 ----
  action replicateEv: bool = all {
    evRep != ev,
    evRep' = ev,
    ev' = ev, psKeep, tabs' = tabs, ctl' = ctl, env' = env, ghost' = ghost,
  }

  action replicatePerson(p: int): bool = all {
    pssRep.get(p) != pss.get(p),
    pssRep' = pssRep.set(p, pss.get(p)),
    pss' = pss, evKeep, tabs' = tabs, ctl' = ctl, env' = env, ghost' = ghost,
  }

  // 회차 슬롯 샤드 장애 전환: 복제되지 않은 쓰기(카운터·serving·리더 세대·묶음 표시)를 잃는다. RB-05가 뒤따른다
  action failoverEv: bool = all {
    env.evFailovers + env.psFailovers < MAX_FAILOVERS,
    evRep != ev,
    ev' = evRep, evRep' = evRep,
    env' = env.with("evFailovers", env.evFailovers + 1).with("rb05Due", true),
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

  // RB-05(docs/infra.md): 잃은 묶음 표시를 처음 값으로 다시 쓰고(카운터는 표시 끝보다 작을 때만 올린다), 카운터를 K만큼 건너뛰고
  // 그 구간을 skipped에 한 줄 더한다(세대 + 1). K는 잃은 번호를 덮는다(정본 가정)
  action rb05: bool = {
    val b = ghost.batchTruth
    val e1 = if (b.closed and not(ev.closed))
               ev.with("closed", true).with("first", b.first).with("size", b.size).with("seq", maxI(ev.seq, b.first + b.size - 1))
             else ev
    val top = maxI(e1.seq, ghost.maxNumber) + 1
    all {
      env.rb05Due,
      evWrite(e1.with("seq", top).with("skips", e1.skips.union(Set({ start: e1.seq + 1, end: top, gen: curGen })))),
      env' = env.with("rb05Due", false),
      psKeep, tabs' = tabs, ctl' = ctl, ghost' = ghost,
    }
  }

  // ---- 입장 확정(queue-admission §6) ----
  // 회차 슬롯: 세대·serving·빠진 번호 확인(건너뛴 구간 안의 옛 세대 대기표는 받는다). 사람 슬롯: q:adm 재확인(ADR-0056 결정 5).
  // 통과하면 q:dup을 지운다(그 뒤에는 q:adm이 다시 줄 서기를 막는다)
  action admit(p: int, t: int): bool = {
    val tb = tab(p, t)
    val r = pss.get(p)
    // q:adm 값은 대기표(묶음은 참가 토큰)의 해시다. 탭(요청)까지 넣어 가린다(②가 깨진 모듈에서도 두 대기표를 하나로 세지 않게)
    val me: Slot = { kind: "ADM", tab: t, seq: tb.seq, gen: tb.gen }
    val inSkippedForMe = ev.skips.exists(g => g.start <= tb.seq and tb.seq <= g.end and tb.gen > g.gen)
    val eventOk = tb.gen <= curGen and (not(SERVING_CHECK) or tb.seq <= ev.serving)
                  and not(ev.removed.contains(tb.seq)) and not(inSkippedForMe)
    val dupAdmission = ADMISSION_RECHECK and r.adm.kind == "ADM" and r.adm != me
    all {
      tb.phase == "HELD",
      eventOk,
      if (dupAdmission)
        // 409 DUPLICATE_ADMISSION: 이 번호를 빠진 번호(1인 1순번 위반 무효화)로 돌린다
        all { tabs' = tabs.set((p, t), tb.with("phase", "DONE")), psKeep,
              evWrite(ev.with("removed", ev.removed.union(Set(tb.seq)))), ghost' = ghost }
      else
        all { tabs' = tabs.set((p, t), tb.with("phase", "ADMITTED")),
              // 입장 키는 늘 쓴다(진입 ①의 ALREADY_ADMITTED가 쓴다). 변형은 재확인 거절만 끈다
              psWrite(p, { dup: EMPTY, adm: me }),
              evKeep,
              ghost' = ghost.with("admittedBy", ghost.admittedBy.setBy(p, s => s.union(Set((t, tb.seq, tb.gen)))))
                            .with("early", ghost.early or tb.seq > ev.serving) },
      ctl' = ctl, env' = env,
    }
  }

  action step = any {
    nondet k = TICKETS.oneOf()
    any { enterPreempt(k._1, k._2), enterNumber(k._1, k._2), enterRecord(k._1, k._2), enterBatchRecord(k._1, k._2), batchMissing(k._1, k._2), leave(k._1, k._2),
          admit(k._1, k._2), publishBatch(k._1, k._2) },
    nondet p = PERSONS.oneOf()
    any { pendingExpires(p), replicatePerson(p), failoverPerson(p) },
    nondet c = CTRLS.oneOf()
    any { acquire(c), plan(c, "ADVANCE"), plan(c, "CLOSE"), applyWrite(c) },
    windowEnds, replicateEv, failoverEv, rb05,
  }

  // ---- 언제나 참(docs/verification.md §2.1 `queue` ①~④) ----
  // ① 차례 전 입장 0: 입장 확정 때 번호가 그 시각 serving 이하(QR-FS-5). 이 불변식은 입장 확정이 그 순간의 serving과 견주는지
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
  val inv_onePersonOneTicket = PERSONS.forall(p =>
    not(ghost.dupLost.contains(p) or ghost.admLost.contains(p)) implies
      TICKETS.filter(k => k._1 == p and Set("BATCHED", "HELD", "ADMITTED").contains(tabs.get(k).phase)).size() <= 1)

  val safety = inv_noAdmissionBeforeTurn and inv_noDuplicateNumberInGeneration and inv_staleLeaderWritesBounded and inv_onePersonOneAdmission
               and inv_onePersonOneTicket
}

// ---- 검사 모듈(specs/specs.json이 고른다) ----
// 전수 검사(TLC)는 범위 둘로 나눈다(작은 범위 확정, 추천 적용 2026-11-02, specs/README.md):
//   진입 범위: 사람 2명(한 사람은 탭 2개, 대기표 3장), admission-ctrl 1대(교체 없음), 장애 전환 2회(회차·사람 슬롯).
//             대기표 4장은 상태가 4천만 개를 넘어도 끝나지 않아(2026-11-02 측정) 한 장을 줄였다
//   리더 범위: 사람 1명(대기표 1장), admission-ctrl 2대, 리더 교체 2회, 회차 슬롯 장애 전환 2회
// 정본 범위 전체(사람 2명·탭 2개씩, ctrl 2대, 장애 전환 2회, 리더 교체 2회)는 시뮬레이션이 본다(`*_full`)

// 정본에 적힌 그대로: 장애 전환 뒤 RB-05 전에도 번호를 낸다(OPEN[13]은 BUILD_ORDER PRF-080이 정본에 넣는다).
// 묶음 참가자의 선점 값은 묶음 기록으로 바꾼다(OPEN[14]를 PRF-060이 2026-11-03 정본에 넣어 1인 1순번 장치를 켰다)
module queue_canon {
  import queue(TICKETS = Set((1, 1), (1, 2), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 2, PERSON_FAILOVERS = true, MAX_LEADER_CHANGES = 0,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = false, ONE_PERSON_GUARDS = true).*
}

// OPEN[13]의 추천안 + 지금 정본(OPEN[14]를 받음): queue_proposed와 같다. 정본이 묶음 기록을 정하기 전(2026-11-02)에는
// 1인 1순번 장치가 없어 ⑤ 반례(결과 게시 전에 선점이 만료돼 같은 사람이 대기표를 하나 더 받음)가 나왔다
module queue_canon_batch_dup {
  import queue(TICKETS = Set((1, 1), (1, 2), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 2, PERSON_FAILOVERS = true, MAX_LEADER_CHANGES = 0,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true).*
}

// OPEN[13]·OPEN[14]의 추천안: RB-05가 끝날 때까지 그 회차의 번호를 내지 않고, 1인 1순번 장치를 더한다(진입 범위)
module queue_proposed {
  import queue(TICKETS = Set((1, 1), (1, 2), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 2, PERSON_FAILOVERS = true, MAX_LEADER_CHANGES = 0,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true).*
}

// 리더 범위
module queue_leader {
  import queue(TICKETS = Set((1, 1)), CTRLS = Set(1, 2), MAX_FAILOVERS = 2, PERSON_FAILOVERS = false, MAX_LEADER_CHANGES = 2,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true).*
}

// 정본 범위 전체(시뮬레이션만)
module queue_proposed_full {
  import queue(TICKETS = Set((1, 1), (1, 2), (2, 1), (2, 2)), CTRLS = Set(1, 2), MAX_FAILOVERS = 2, PERSON_FAILOVERS = true, MAX_LEADER_CHANGES = 2,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true).*
}

// 변형(검사가 살아 있는지, V-T1): 하나씩 끄면 그 불변식의 반례가 나와야 한다
module queue_no_fencing {
  import queue(TICKETS = Set((1, 1)), CTRLS = Set(1, 2), MAX_FAILOVERS = 2, PERSON_FAILOVERS = false, MAX_LEADER_CHANGES = 2,
               FENCING = false, SERVING_CHECK = true, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true).*
}

module queue_no_serving_check {
  import queue(TICKETS = Set((1, 1), (1, 2), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 2, PERSON_FAILOVERS = true, MAX_LEADER_CHANGES = 0,
               FENCING = true, SERVING_CHECK = false, ADMISSION_RECHECK = true, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true).*
}

module queue_no_admission_recheck {
  import queue(TICKETS = Set((1, 1), (1, 2), (2, 1)), CTRLS = Set(1), MAX_FAILOVERS = 2, PERSON_FAILOVERS = true, MAX_LEADER_CHANGES = 0,
               FENCING = true, SERVING_CHECK = true, ADMISSION_RECHECK = false, ENTRY_WAITS_RB05 = true, ONE_PERSON_GUARDS = true).*
}
