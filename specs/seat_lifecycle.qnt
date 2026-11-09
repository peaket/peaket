// -*- mode: Bluespec; -*-
// 홀드의 해제·연장·주문 뒤 집합·결제 정지 멈춤·되돌리기 명세(BUILD_ORDER HOT-358 리뷰 V3, docs/verification.md §2.1).
// 근거: ADR-0085(결제 정지 동안 남은 시간 멈춤), ADR-0254(옮기기·되돌리기·최대 체류), ADR-0121(다시 만들기), docs/features/seat-hold.md §5.
// `seat`(specs/seat.qnt)는 모델 기반 시험에 물려 있고 해제·연장·정지를 뺐다. 같은 불변식을 이 전이까지 넣어 더 작은 범위에서 본다.
// 이 파일은 정본이 아니다. 정본과 다르면 정본이 이기고, 이 파일을 고친다.
//
// 모형으로 줄인 것:
// - 시간: 좌석마다 '만료 시각이 지남'(late)이 언제든 일어날 수 있다. 연장(1회)은 만료가 언제든 올 수 있다는 가정에 덮여 좌석 상태를 바꾸지 않고 한 번만 할 수 있다는 것만 둔다.
// - 집합 하나를 좌석의 자리(where)로 둔다: HELD(expiry만), ORDERED(expiry + ordered), PAUSED(paused만), PINNED(결제 중, 만료 대상 아님).
// - 정지 조회: on(정지 중)과 known(답을 받았다). known이 거짓인 동안은 UNSETTLED(조회 실패 10초 안)이라 옮기기·되돌리기를 하지 않고 주문 뒤 홀드를 만료로 풀지 않는다.
//   10초가 넘으면 열린 것으로 보는 것은 pauseEnd(known과 상관없이 할 수 있다)로 덮는다.
// - preLate: 정지가 시작될 때 이미 시간이 지난 좌석(정지와 상관없이 풀린다).
// - 결제 승인·거절은 결과만 둔다(`payment`가 본다). 복제 지연은 두지 않는다(`seat`가 본다). 다시 만들기는 ordered·paused를 비운다(L12).
module seat_lifecycle {
  // ---- 범위(검사 모듈이 정한다) ----
  const HOLDS: Set[int]
  const SEATS: Set[int]
  const REQS: int -> Set[int]     // 홀드마다 잡으려는 좌석
  const MAX_LOSS: int             // 좌석 Redis 전체 유실 횟수
  // ---- 설계 장치(하나씩 끈 변형으로 검사가 살아 있는지 본다, V-T1) ----
  const UNIQUE_INDEX: bool        // seat_sale 활성 상태 부분 유니크
  const EXPIRE_SKIPS_PAUSE: bool  // 만료 Lua가 정지 중 주문 뒤 홀드를 건너뛴다(frozenWait)
  const MAX_STAY_THAW: bool       // 최대 체류에 닿은 멈춘 홀드를 expiry로 돌려놓는다

  type Seat = { hid: int, where: str, late: bool, preLate: bool }
  type Hold = { phase: str, maxDue: bool, extended: bool }   // phase: IDLE·HELD·ACCEPTED·RESERVED·SOLD·FAILED·GONE
  type Pause = { on: bool, known: bool }

  pure val FREE: Seat = { hid: 0, where: "NONE", late: false, preLate: false }
  pure def minOf(s: Set[int]): int = s.fold(1000000, (acc, x) => if (x < acc) x else acc)

  var seats: int -> Seat
  var holds: int -> Hold
  var pause: Pause
  var sale: int -> Set[int]   // 좌석마다 커밋된 활성 판매 행의 홀드
  var losses: int
  var ready: bool
  var frozenLost: int         // 검사 기록: 멈춰야 할 좌석을 시간으로 푼 횟수

  action init = all {
    seats' = SEATS.mapBy(x => FREE),
    holds' = HOLDS.mapBy(h => { phase: "IDLE", maxDue: false, extended: false }),
    pause' = { on: false, known: true },
    sale' = SEATS.mapBy(x => Set()),
    losses' = 0,
    ready' = true,
    frozenLost' = 0,
  }

  def hold_(h: int): Hold = holds.get(h)
  def mine(h: int): Set[int] = SEATS.filter(x => seats.get(x).hid == h)
  def setSeats(s: Set[int], f: Seat => Seat): int -> Seat = seats.keys().mapBy(x => if (s.contains(x)) f(seats.get(x)) else seats.get(x))
  def setPhase(h: int, p: str): int -> Hold = holds.set(h, hold_(h).with("phase", p))

  // 홀드 Lua: 모든 좌석이 비었을 때만 잡는다
  action hold(h: int): bool = all {
    ready, hold_(h).phase == "IDLE",
    REQS.get(h).forall(x => seats.get(x).hid == 0),
    seats' = setSeats(REQS.get(h), s => { hid: h, where: "HELD", late: false, preLate: false }),
    holds' = setPhase(h, "HELD"),
    pause' = pause, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
  }

  // 주문 뒤 표시 Lua(ordered에 넣는다)
  action markOrdered(h: int): bool = {
    val todo = mine(h).filter(x => seats.get(x).where == "HELD" and not(seats.get(x).late))
    all {
      ready, hold_(h).phase == "HELD", todo.size() > 0,
      seats' = setSeats(todo, s => s.with("where", "ORDERED")),
      holds' = holds, pause' = pause, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
    }
  }

  // 시간이 흐름: 멈췄거나 묶인 좌석은 시간이 흐르지 않는다
  action ttlPasses(h: int, x: int): bool = {
    val s = seats.get(x)
    all {
      s.hid == h, Set("HELD", "ORDERED").contains(s.where), not(s.late),
      seats' = seats.set(x, s.with("late", true)),
      holds' = holds, pause' = pause, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
    }
  }

  // 만료 Lua가 이 좌석을 풀어도 되는가(expire-lua의 frozenWait)
  def mayExpire(h: int, s: Seat): bool =
    s.where == "HELD" or (s.where == "ORDERED" and ((not(pause.on) and pause.known) or s.preLate or hold_(h).maxDue))

  action expire(h: int, x: int): bool = {
    val s = seats.get(x)
    val rest = mine(h).exclude(Set(x))
    val wrongful = s.where == "ORDERED" and not(mayExpire(h, s))
    all {
      ready, s.hid == h, s.late, s.where != "PINNED", s.where != "PAUSED",
      not(EXPIRE_SKIPS_PAUSE) or mayExpire(h, s),
      seats' = seats.set(x, FREE),
      holds' = if (rest.size() == 0 and hold_(h).phase == "HELD") setPhase(h, "GONE") else holds,
      frozenLost' = if (wrongful) frozenLost + 1 else frozenLost,
      pause' = pause, sale' = sale, losses' = losses, ready' = ready,
    }
  }

  // ---- 결제 정지 ----
  action pauseStart: bool = all {
    not(pause.on),
    pause' = { on: true, known: true },
    seats' = seats.keys().mapBy(x => seats.get(x).with("preLate", seats.get(x).late)),
    holds' = holds, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
  }
  // 열림(연속 두 번·1초 판정의 결과) 또는 조회가 10초 넘게 끊겨 열린 것으로 봄
  action pauseEnd: bool = all {
    pause.on,
    pause' = { on: false, known: true },
    seats' = seats.keys().mapBy(x => seats.get(x).with("preLate", false)),
    holds' = holds, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
  }
  action pauseBlind: bool = all {
    pause.known, pause' = pause.with("known", false),
    seats' = seats, holds' = holds, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
  }
  action pauseSeen: bool = all {
    not(pause.known), pause' = pause.with("known", true),
    seats' = seats, holds' = holds, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
  }

  // 옮기기 Lua: 남은 시간이 있고 최대 체류 전이면 paused로 옮긴다. 아니면 ordered에서만 뺀다
  action freeze(h: int, x: int): bool = {
    val s = seats.get(x)
    val keeps = not(s.preLate) and not(hold_(h).maxDue)
    all {
      ready, pause.on, pause.known, s.hid == h, s.where == "ORDERED",
      seats' = seats.set(x, if (keeps) s.with("where", "PAUSED").with("late", false) else s.with("where", "HELD")),
      holds' = holds, pause' = pause, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
    }
  }

  // 되돌리기 Lua: 남은 시간에서 이어 센다(ordered에 다시 넣는다)
  action thaw(h: int, x: int): bool = {
    val s = seats.get(x)
    all {
      ready, not(pause.on), pause.known, s.hid == h, s.where == "PAUSED",
      seats' = seats.set(x, s.with("where", "ORDERED").with("late", false)),
      holds' = holds, pause' = pause, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
    }
  }

  action maxStayPasses(h: int): bool = all {
    hold_(h).phase == "HELD", not(hold_(h).maxDue), mine(h).size() > 0,
    holds' = holds.set(h, hold_(h).with("maxDue", true)),
    seats' = seats, pause' = pause, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
  }

  // 최대 체류에 닿은 멈춘 좌석을 expiry로 돌려놓는다(ordered에 넣지 않는다, 다음 만료 Lua가 푼다)
  action maxThaw(h: int, x: int): bool = {
    val s = seats.get(x)
    all {
      MAX_STAY_THAW, ready, hold_(h).maxDue, s.hid == h, s.where == "PAUSED",
      seats' = seats.set(x, s.with("where", "HELD").with("late", true)),
      holds' = holds, pause' = pause, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
    }
  }

  // ---- 사람의 동작 ----
  // 연장(1회): 시간이 지나지 않은 홀드만. 좌석마다 멈춤을 나눠 처리한다(M5)
  action extend(h: int): bool = all {
    ready, hold_(h).phase == "HELD", not(hold_(h).extended), mine(h).size() > 0,
    mine(h).forall(x => not(seats.get(x).late) and seats.get(x).where != "PINNED"),
    holds' = holds.set(h, hold_(h).with("extended", true)),
    seats' = seats, pause' = pause, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
  }

  // 해제 Lua: 묶인 좌석이 있으면 거절(PINNED), 아니면 전부 푼다(시간이 지났어도 Hash가 있으면 푼다)
  action release(h: int): bool = all {
    ready, hold_(h).phase == "HELD", mine(h).size() > 0,
    mine(h).forall(x => seats.get(x).where != "PINNED"),
    seats' = setSeats(mine(h), s => FREE),
    holds' = setPhase(h, "GONE"),
    pause' = pause, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
  }

  // 결제 접수: 잡은 좌석이 그대로면 묶고, 일부를 잃었으면 과금 없이 끝낸다
  action accept(h: int): bool = {
    val ok = REQS.get(h).forall(x => seats.get(x).hid == h)
    all {
      ready, hold_(h).phase == "HELD",
      seats' = if (ok) setSeats(mine(h), s => s.with("where", "PINNED").with("late", false)) else seats,
      holds' = setPhase(h, if (ok) "ACCEPTED" else "FAILED"),
      pause' = pause, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
    }
  }

  action saleStep(h: int): bool = {
    val conflict = UNIQUE_INDEX and REQS.get(h).exists(x => sale.get(x).size() > 0)
    all {
      hold_(h).phase == "ACCEPTED",
      sale' = if (conflict) sale else sale.keys().mapBy(x => if (REQS.get(h).contains(x)) sale.get(x).union(Set(h)) else sale.get(x)),
      holds' = setPhase(h, if (conflict) "FAILED" else "RESERVED"),
      seats' = seats, pause' = pause, losses' = losses, ready' = ready, frozenLost' = frozenLost,
    }
  }
  action approve(h: int): bool = all {
    hold_(h).phase == "RESERVED",
    holds' = setPhase(h, "SOLD"),
    seats' = seats, pause' = pause, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
  }
  action decline(h: int): bool = all {
    hold_(h).phase == "RESERVED",
    holds' = setPhase(h, "FAILED"),
    sale' = sale.keys().mapBy(x => sale.get(x).exclude(Set(h))),
    seats' = seats, pause' = pause, losses' = losses, ready' = ready, frozenLost' = frozenLost,
  }
  action releaseFailed(h: int): bool = all {
    ready, hold_(h).phase == "FAILED", mine(h).size() > 0,
    seats' = setSeats(mine(h), s => FREE),
    holds' = holds, pause' = pause, sale' = sale, losses' = losses, ready' = ready, frozenLost' = frozenLost,
  }

  // ---- 좌석 Redis 전체 유실과 다시 만들기(ordered·paused는 비운다, L12) ----
  action loseAll: bool = all {
    losses < MAX_LOSS, ready,
    seats' = SEATS.mapBy(x => FREE), ready' = false, losses' = losses + 1,
    holds' = holds, pause' = pause, sale' = sale, frozenLost' = frozenLost,
  }
  action rebuild: bool = {
    val live = HOLDS.filter(h => hold_(h).phase == "HELD")
    all {
      not(ready),
      seats' = SEATS.mapBy(x =>
        if (sale.get(x).size() > 0) { hid: minOf(sale.get(x)), where: "PINNED", late: false, preLate: false }
        else if (live.exists(h => REQS.get(h).contains(x))) { hid: minOf(live.filter(h => REQS.get(h).contains(x))), where: "HELD", late: false, preLate: false }
        else FREE),
      ready' = true,
      holds' = holds, pause' = pause, sale' = sale, losses' = losses, frozenLost' = frozenLost,
    }
  }

  action step = any {
    nondet h = HOLDS.oneOf()
    nondet x = SEATS.oneOf()
    any {
      hold(h), markOrdered(h), ttlPasses(h, x), expire(h, x), freeze(h, x), thaw(h, x), maxStayPasses(h), maxThaw(h, x),
      extend(h), release(h), accept(h), saleStep(h), approve(h), decline(h), releaseFailed(h),
    },
    pauseStart, pauseEnd, pauseBlind, pauseSeen, loseAll, rebuild,
  }

  // ---- 언제나 참 ----
  // ① 좌석당 활성 판매 1건 이하(이중 판매 0)
  val inv_noDoubleSale = SEATS.forall(x => sale.get(x).size() <= 1)
  // ② 정지 동안 주문 뒤 홀드를 시간으로 풀지 않는다(S-T23 ①, 최대 체류·정지 전 만료는 예외)
  val inv_noFrozenLost = frozenLost == 0
  // ③ 멈춘 좌석은 잡은 홀드가 있고, 그 홀드는 결제 접수 전이거나(일부 좌석을 잃어 실패한 시도라면) 해제를 기다린다. 묶인 뒤에는 멈추지 않는다
  val inv_pausedBelongs = SEATS.forall(x => seats.get(x).where != "PAUSED" or (seats.get(x).hid != 0 and Set("HELD", "FAILED").contains(hold_(seats.get(x).hid).phase)))

  // ---- 결국 일어남: 묶이거나 멈춘 좌석이 영원히 남지 않는다 ----
  val vars = (seats, holds, pause, sale, losses, ready, frozenLost)
  def holding(h: int): bool = mine(h).size() > 0
  temporal liveness = HOLDS.forall(h => and {
    always(holding(h) implies eventually(hold_(h).phase == "SOLD" or not(holding(h)))),
  })
  // 공정성은 시간의 흐름과 시스템이 하는 걸음에만 건다. 사람의 동작(홀드·해제·연장·결제 접수)과 정지·유실에는 걸지 않는다(정지가 끝나지 않아도 최대 체류가 끝낸다)
  temporal fairness = and {
    HOLDS.forall(h => and {
      weakFair(maxStayPasses(h), vars), weakFair(saleStep(h), vars), weakFair(approve(h), vars), weakFair(decline(h), vars), weakFair(releaseFailed(h), vars),
      SEATS.forall(x => and {
        weakFair(ttlPasses(h, x), vars), weakFair(expire(h, x), vars), weakFair(freeze(h, x), vars), weakFair(thaw(h, x), vars), weakFair(maxThaw(h, x), vars),
      }),
    }),
    weakFair(rebuild, vars),
  }
  temporal fairLiveness = fairness implies liveness
}

// ---- 검사 모듈(specs/specs.json이 고른다) ----
// 두 홀드가 한 좌석을 다툰다: 홀드 1은 좌석 1·2, 홀드 2는 좌석 1
module seat_lifecycle_check {
  import seat_lifecycle(HOLDS = Set(1, 2), SEATS = Set(1, 2), REQS = Map(1 -> Set(1, 2), 2 -> Set(1)), MAX_LOSS = 1,
                        UNIQUE_INDEX = true, EXPIRE_SKIPS_PAUSE = true, MAX_STAY_THAW = true).*
}
// 진행성 범위: 홀드 하나
module seat_lifecycle_live {
  import seat_lifecycle(HOLDS = Set(1), SEATS = Set(1, 2), REQS = Map(1 -> Set(1, 2)), MAX_LOSS = 0,
                        UNIQUE_INDEX = true, EXPIRE_SKIPS_PAUSE = true, MAX_STAY_THAW = true).*
}
// 변형(V-T1): 하나씩 끄면 반례가 나와야 한다
module seat_lifecycle_no_unique {
  import seat_lifecycle(HOLDS = Set(1, 2), SEATS = Set(1), REQS = Map(1 -> Set(1), 2 -> Set(1)), MAX_LOSS = 1,
                        UNIQUE_INDEX = false, EXPIRE_SKIPS_PAUSE = true, MAX_STAY_THAW = true).*
}
module seat_lifecycle_no_skip {
  import seat_lifecycle(HOLDS = Set(1), SEATS = Set(1), REQS = Map(1 -> Set(1)), MAX_LOSS = 0,
                        UNIQUE_INDEX = true, EXPIRE_SKIPS_PAUSE = false, MAX_STAY_THAW = true).*
}
module seat_lifecycle_no_max_thaw {
  import seat_lifecycle(HOLDS = Set(1), SEATS = Set(1), REQS = Map(1 -> Set(1)), MAX_LOSS = 0,
                        UNIQUE_INDEX = true, EXPIRE_SKIPS_PAUSE = true, MAX_STAY_THAW = false).*
}
