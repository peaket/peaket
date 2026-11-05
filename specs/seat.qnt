// -*- mode: Bluespec; -*-
// 좌석 홀드·판매 확정 명세(wbs 0.9.2, docs/verification.md §2.1 `seat`).
// 근거: ADR-0014(Soft Hold·Hard Sale), ADR-0121(좌석 Redis 장애 조치 동안 미룸, 세대 키, RB-06),
//       docs/features/seat-hold.md §3(홀드 Lua, 펜싱 토큰, 세대 키)·§4(1인 한도)·§5(TTL·연장·만료, 결제창 유지 30분과의 관계)·§6(판매 확정,
//       RB-06)·§9(장애 시 동작), docs/features/payment.md §2(결제 접수·Saga), docs/data.md §3(좌석 클러스터 키)·§4의 2번(판매 확정).
// 읽는 법은 specs/README.md. 이 파일은 정본이 아니다. 정본과 다르면 정본이 이기고, 이 파일을 고친다.
//
// 모형으로 줄인 것:
// - 시간: 홀드 TTL(7분), 연장(3분), 승인 기한은 '홀드마다 시간이 언제든 다 될 수 있음'(ttlPasses)으로만 둔다. 연장(1회 3분, POL-012)은
//   만료 시각만 미뤄 이 모형의 어떤 걸음도 바꾸지 않으므로 동작으로 두지 않는다(만료가 언제든 올 수 있다는 가정이 연장한 홀드도 덮는다).
//   결제 중으로 묶인 좌석과 팔린 좌석(판매 반영)은 만료 인덱스에 없어 시간이 다 되지 않는다.
// - 좌석 Redis는 회차 슬롯(`{event:E}`) 샤드 하나다. 복제는 비동기이고 복제 지연은 쓰기 하나다(queue.qnt와 같은 방식).
//   장애 전환은 한 걸음이라 그 사이 좌석 Redis를 쓰는 걸음이 없다. ADR-0121 결정 1 '장애 조치 동안 미룸'을 이렇게 나타낸다(미루지 않는
//   대안인 DB 비상 홀드 경로는 ADR-0121이 없애서 변형으로 두지 않는다). 종류는 둘이다: 주 노드 승격(따라잡지 못한 쓰기 하나를 잃음)과
//   클러스터 전체 유실(세대 키도 없어져 RB-06 다시 만들기 전까지 NOT_READY, 503).
// - 홀드는 시도(사람, 번호)마다 하나다. 한 홀드의 좌석은 함께 잡히고 함께 풀린다. 홀드가 거절되면(409·422) 그 시도는 끝난다.
// - 결제는 '결제 접수(홀드 확인) → (묶기, 추천안) → 판매 예약 → 승인 또는 거절'이다. 결제창 인증·결과 모름·웹훅·결제사는 `payment`가 본다.
// - 판매 예약 트랜잭션은 좌석마다 PENDING 삽입이 한 걸음이다(마지막 좌석 삽입·한도 행 갱신·커밋은 한 걸음). 다른 트랜잭션이 아직
//   커밋하지 않은 같은 좌석 행이 있으면 기다리고(PostgreSQL 유일 인덱스의 삽입 대기), 커밋된 활성 행이 있으면 유일 위반으로 끝난다.
// - 홀드 원장은 HELD 사건을 적재했는지만 본다. 해제·만료 사건은 제때 적재된다고 둔다. 적재는 주 노드에서 읽는다(복제 전 홀드도 적재될 수 있다).
// - 정본에 없어 모형이 고른 것: 펜싱 토큰은 홀드 Lua가 회차 슬롯의 카운터로 낸다(정본은 ARGV `fencing`으로만 적고 키 표에 카운터가 없다).
//   승인 거절로 PENDING을 지울 때 한도 행을 되돌린다(정본에 없음. 되돌리면 판매가 더 많아질 수 있어 ②의 검사가 더 엄격한 쪽).
//   결제가 실패하면(유일 위반·한도·승인 거절·묶기 실패) 좌석 해제는 그 시도의 홀드일 때만 푼다(seat-hold §3 '자기 홀드만'과 같은 확인).
// 뺀 것: 방금 놓은 좌석 30초, 멱등키, 자동 배정, 우선 구매 보류, 판매 일시정지·종료, 결제 일시 정지 동안 멈춤, 직접 해제(Redis에 하는 일이
//        만료와 같아 '시간이 다 됨 → 만료'로 덮는다), 세대 값(화면 맞추기에만 쓰여 세대 키가 있는지만 둔다), 원장 사건의 순서 바뀜(S-T5).
// 진행성(결국 일어남, docs/verification.md §2.1 '홀드는 판매나 만료로 끝난다', 추천 적용 2026-11-05 BUILD_ORDER PRF-150 ①): 맨 아래 `liveness`와
//   `fairness`. 공정성은 시스템이 하는 걸음과 시간의 흐름에만 걸고, 사람의 걸음(홀드 요청·결제 접수)과 장애(승격·전체 유실)에는 걸지 않는다.
//   승인·거절은 결제 쪽 결과라 결국 온다고 두는데, 그 근거는 `payment` 명세의 진행성(접수한 주문은 접수·판매 예약 상태를 벗어난다, payment_live)이다.
module seat {
  // ---- 범위(작은 범위, docs/verification.md §2.1. 검사 모듈이 정한다) ----
  const PEOPLE: Set[int]
  const SEATS: Set[int]
  const LIMIT: int                  // 1인 한도(매)
  const ATTEMPTS: Set[(int, int)]   // (사람, 시도 번호). 시도마다 홀드 하나
  const REQUESTS: Set[List[int]]    // 홀드 요청의 좌석 목록(요청 순서 그대로. 좌석 ID 순으로 넣는 것은 판매 예약이 한다)
  const MAX_FAILOVERS: int          // 좌석 Redis 장애 전환(주 노드 승격과 전체 유실의 합)
  const FULL_LOSS: bool             // 장애 전환이 클러스터 전체 유실일 수 있는지(RB-06)
  const PROMOTE: bool               // 장애 전환이 주 노드 승격일 수 있는지
  // ---- 설계 장치(하나씩 끈 변형으로 검사가 살아 있는지 본다, V-T1) ----
  const UNIQUE_INDEX: bool          // seat_sale 활성 상태 부분 유니크(①)
  const DB_QUOTA: bool              // purchase_quota 조건부 갱신(②)
  const SORTED_INSERT: bool         // 판매 예약의 PENDING을 좌석 ID 순으로 넣음(K3)
  const READY_CHECK: bool           // 세대 키가 없으면 NOT_READY(ADR-0121 결정 4)
  // 정본에 없음(PROGRESS OPEN[15]의 추천안): 판매 예약 앞에서 좌석 Redis Lua로 좌석을 '결제 중'으로 묶는다. 내 홀드면 만료하지 않게 두고,
  // 내 홀드가 만료돼 좌석이 비었으면 새 펜싱 토큰으로 다시 잡고(보유 수도 다시 셈), 다른 사람이 잡았으면 승인하지 않고 끝낸다.
  // 다시 만들기 판 번호: RB-06이 DB와 세대 키에 함께 올리는 번호다. 결제 접수와 묶기는 그때의 판 번호를 적고, 묶기 Lua는 판 번호가 같을 때만
  // 빈 좌석을 다시 잡으며(다시 만든 뒤의 '빈 좌석'은 잃은 홀드일 수 있다), 판매 예약 커밋은 적은 판 번호가 DB의 지금 판 번호와 같을 때만 한다
  // (다르면 묶기부터 다시). RB-06은 접수된 주문의 좌석을 묶음으로 되살리지 않는다: 판매 행은 묶음으로, 적재된 시도의 홀드(만료 전 원장 홀드와,
  // 주문 pinned_at으로 DB에 남은 묶인 시도의 홀드, BUILD_ORDER PRF-167)는 묶이지 않은 홀드로 되살리고 Saga의 다음 묶기가 다시 묶는다
  const PIN_BEFORE_SALE: bool
  // 정본에 없음(PROGRESS OPEN[16]의 추천안): 펜싱 토큰 = max(카운터 + 1, Redis TIME 마이크로초). 장애 전환 뒤에도 앞서 낸 토큰보다 크다
  // (세대 올리기와 같은 시계 전제, ADR-0121 결정 5). 이 전제를 모형에 그대로 넣으므로, 켜면 토큰 값은 다른 걸음에 영향이 없어
  // 카운터와 기록을 바꾸지 않는다(상태가 토큰 값만으로 갈라지지 않게). ④는 이 장치를 끈 모듈이 본다
  const TOKEN_TIME_FLOOR: bool
  // 결제가 실패한 시도의 좌석 해제(좌석 해제 사건을 받은 소비자의 Lua `releaseFailed`, seat-hold §6 '좌석 묶기와 실패 해제의 첫 구현').
  // 묶인 좌석은 만료 인덱스에서 빠져 만료로 풀리지 않으므로, 이것을 끄면 판매 예약 뒤 실패한 시도의 좌석이 끝내 남는다(진행성 변형)
  const FAIL_RELEASE: bool

  // ---- 값 ----
  type SeatR = { hid: int, pinned: bool }   // 좌석 하나: hid는 잡은 시도(0이면 비트 0), pinned는 결제 중으로 묶였거나 팔린 좌석
  // ready: 세대 키가 있음, gen: 세대 키에 둔 다시 만들기 판 번호(없으면 0), counter: 펜싱 카운터, quota: 보유 수
  type Red = { ready: bool, gen: int, counter: int, seats: int -> SeatR, quota: int -> int }
  // 시도(브라우저와 그 요청·주문을 처리하는 purchase-svc). phase: IDLE·HELD(홀드 201)·ACCEPTED(결제 접수 202)·PINNED(묶음)·
  // RESERVED(PENDING 커밋)·SOLD·FAILED(과금 없이 끝났거나 승인 거절)·DONE(홀드·접수 거절). late: 좌석 Redis의 만료 시각이 지남.
  // ins: 판매 예약 트랜잭션이 넣은(커밋 전) 좌석 수. gen: 결제 접수·묶기 때 적은 다시 만들기 판 번호(주문 DB 행)
  type Att = { phase: str, seats: List[int], late: bool, ins: int, gen: int }
  // purchase DB: sale(좌석마다 커밋된 활성 판매 행의 시도. 부분 유니크를 끈 변형에서는 둘 이상일 수 있다), unc(커밋 전 삽입 행의 시도, 0은 없음),
  // used(한도 행 purchase_quota.used), ledger(HELD 사건을 홀드 원장에 적재한 시도), gen(다시 만들기 판 번호. RB-06이 행 잠금 아래에서 올려
  // 커밋한 뒤 판매 행을 읽고, 판매 예약 트랜잭션은 이 행을 FOR SHARE로 잠가 읽는다)
  type Db = { sale: int -> Set[int], unc: int -> int, used: int -> int, ledger: Set[int], gen: int }
  type Env = { partials: int, fulls: int }  // 주 노드 승격 수, 전체 유실 수
  // 검사에만 쓰는 기록(시스템이 아는 값이 아니다). stale: 낡은 홀드로 판매 예약한 주문 수, maxTok: 지금까지 낸 가장 큰 펜싱 토큰,
  // tokBroken: 새로 낸 토큰이 앞서 낸 토큰보다 크지 않았던 적이 있음, newest: 좌석마다 가장 새 펜싱 토큰을 받은 시도(0은 없음. 그 시도의
  // 좌석이 만료·해제로 풀리면 지운다. 장애 전환으로 좌석 Redis가 잊어도 이 기록은 남는다)
  type Ghost = { stale: int, maxTok: int, tokBroken: bool, newest: int -> int }

  pure val EMPTY: SeatR = { hid: 0, pinned: false }
  pure def hidOf(k: (int, int)): int = k._1 * 10 + k._2
  pure def personOf(h: int): int = h / 10
  pure val HIDS: Set[int] = ATTEMPTS.map(k => hidOf(k))
  pure def maxI(a: int, b: int): int = if (a > b) a else b
  pure def minOf(s: Set[int]): int = s.fold(1000000, (acc, x) => if (x < acc) x else acc)
  pure def seatSet(l: List[int]): Set[int] = l.indices().map(i => l[i])
  pure def sortedList(l: List[int]): List[int] = if (l.length() == 2 and l[0] > l[1]) [l[1], l[0]] else l
  pure def putSeats(m: int -> SeatR, s: Set[int], v: SeatR): int -> SeatR = m.keys().mapBy(x => if (s.contains(x)) v else m.get(x))
  pure val SEAT0: int = minOf(SEATS)
  pure val RED0: Red = { ready: true, gen: 1, counter: 0, seats: SEATS.mapBy(s => EMPTY), quota: PEOPLE.mapBy(p => 0) }

  var red: Red
  var redRep: Red
  var atts: int -> Att
  var db: Db
  var env: Env
  var ghost: Ghost

  // ---- 좌석 Redis 쓰기(복제 지연 쓰기 하나) ----
  action redWrite(r2: Red): bool = all { red' = r2, redRep' = if (r2 == red) redRep else red }
  action redKeep: bool = all { red' = red, redRep' = redRep }

  action init = all {
    red' = RED0,
    redRep' = RED0,
    atts' = HIDS.mapBy(h => { phase: "IDLE", seats: List(), late: false, ins: 0, gen: 0 }),
    db' = { sale: SEATS.mapBy(s => Set()), unc: SEATS.mapBy(s => 0), used: PEOPLE.mapBy(p => 0), ledger: Set(), gen: 1 },
    env' = { partials: 0, fulls: 0 },
    ghost' = { stale: 0, maxTok: 0, tokBroken: false, newest: SEATS.mapBy(s => 0) },
  }

  // 좌석 Redis Lua가 쓸 수 있는지: 세대 키가 없으면 NOT_READY라 purchase-svc가 503으로 답하고 나중에 다시 한다
  def usable: bool = not(READY_CHECK) or red.ready
  def att(h: int): Att = atts.get(h)
  // 새 펜싱 토큰을 낸 뒤의 카운터와 기록(시계 하한을 켜면 바꾸지 않는다, 위 TOKEN_TIME_FLOOR)
  def nextTok: int = red.counter + 1
  def counterAfter(r: Red): int = if (TOKEN_TIME_FLOOR) r.counter else r.counter + 1
  pure def noteTok(g: Ghost, t: int): Ghost =
    if (TOKEN_TIME_FLOOR) g else g.with("tokBroken", g.tokBroken or t <= g.maxTok).with("maxTok", maxI(g.maxTok, t))
  def setQuota(r: Red, p: int, n: int): Red = r.with("quota", r.quota.set(p, maxI(0, n)))
  pure def setNewest(g: Ghost, s: Set[int], h: int): Ghost = g.with("newest", g.newest.keys().mapBy(x => if (s.contains(x)) h else g.newest.get(x)))
  pure def clearNewest(g: Ghost, s: Set[int], h: int): Ghost =
    g.with("newest", g.newest.keys().mapBy(x => if (s.contains(x) and g.newest.get(x) == h) 0 else g.newest.get(x)))

  // ---- 홀드 Lua(seat-hold §3): 모든 좌석이 비었고 보유 수 + 요청 수 ≤ 한도일 때만 비트·홀드·보유 수·펜싱 토큰을 한 번에 쓴다 ----
  action hold(h: int, l: List[int]): bool = {
    val p = personOf(h)
    val s = seatSet(l)
    val ok = s.forall(x => red.seats.get(x).hid == 0) and red.quota.get(p) + s.size() <= LIMIT
    val t = nextTok
    all {
      att(h).phase == "IDLE",
      usable,
      if (ok)
        all { redWrite(setQuota(red.with("seats", putSeats(red.seats, s, { hid: h, pinned: false })).with("counter", counterAfter(red)), p, red.quota.get(p) + s.size())),
              atts' = atts.set(h, { phase: "HELD", seats: l, late: false, ins: 0, gen: 0 }),
              ghost' = setNewest(noteTok(ghost, t), s, h) }
      else
        // 409 seat-already-held 또는 422 한도 초과: 아무 좌석도 잡지 않는다
        all { redKeep, atts' = atts.set(h, att(h).with("phase", "DONE")), ghost' = ghost },
      db' = db, env' = env,
    }
  }

  // 홀드의 만료 시각이 지남(시간이 흐름). 좌석 Redis에 그 홀드가 있거나, 다시 만들기를 기다리는데 원장에 있을 때만 본다.
  // 다시 만들기를 기다리는 동안 원장 때문에 시간이 다 되는 갈래는 묶인 시도(PINNED)에 없다(BUILD_ORDER PRF-167, 주문 pinned_at): 묶음은 좌석 Redis만이
  // 아니라 주문 pinned_at으로 DB에도 남아, 다시 만들기가 원장 만료 시각과 상관없이 그 시도의 좌석을 되살린다(docs/features/seat-hold.md §6 '주문 기준 되살리기').
  // 좌석 Redis에 그 시도의 묶이지 않은 홀드가 있으면(승격이 묶기 쓰기를 잃었거나, 다시 만들기가 되살린 홀드) 묶인 시도여도 시간이 다 될 수 있다
  action ttlPasses(h: int): bool = {
    val a = att(h)
    val inRed = seatSet(a.seats).exists(x => red.seats.get(x).hid == h)
    all {
      a.seats.length() > 0, not(a.late), a.phase != "SOLD",
      inRed or (not(red.ready) and db.ledger.contains(h) and a.phase != "PINNED"),
      not(seatSet(a.seats).exists(x => red.seats.get(x).hid == h and red.seats.get(x).pinned)),
      atts' = atts.set(h, a.with("late", true)),
      redKeep, db' = db, env' = env, ghost' = ghost,
    }
  }

  // 만료 작업의 만료 Lua(seat-hold §5): 시간이 다 된 홀드의 좌석을 풀고 보유 수를 줄인다(그 시도의 홀드일 때만)
  action expire(h: int): bool = {
    val a = att(h)
    val mine = seatSet(a.seats).filter(x => red.seats.get(x).hid == h and not(red.seats.get(x).pinned))
    all {
      usable, a.late, mine.size() > 0,
      redWrite(setQuota(red.with("seats", putSeats(red.seats, mine, EMPTY)), personOf(h), red.quota.get(personOf(h)) - mine.size())),
      atts' = atts, db' = db, env' = env, ghost' = clearNewest(ghost, mine, h),
    }
  }

  // ---- 결제 접수(payment §2, seat-hold §5 '결제창 유지 30분과의 관계'): 좌석마다 내 홀드이거나 비어 있으면 202(Saga 시작),
  //      다른 시도가 잡았으면 승인하지 않고 끝낸다(과금 없음). 홀드 확인은 읽기만 한다(정본에 묶는 단계가 없다) ----
  action accept(h: int): bool = {
    val a = att(h)
    val ok = seatSet(a.seats).forall(x => red.seats.get(x).hid == h or red.seats.get(x).hid == 0)
    all {
      a.phase == "HELD", usable,
      atts' = atts.set(h, a.with("phase", if (ok) "ACCEPTED" else "DONE").with("gen", red.gen)),
      redKeep, db' = db, env' = env, ghost' = ghost,
    }
  }

  // 묶기 Lua(추천안, OPEN[15]): Saga가 판매 예약 앞에서 부른다. 주문이 적은 판 번호를 받아 세대 키의 판 번호와 견주고, 같을 때만 빈 좌석을
  // 다시 잡는다. 성공하면 지금 판 번호를 돌려주고 Saga가 '묶음'과 함께 적는다. Lua와 그 기록은 실제로 두 걸음이지만 한 걸음으로 둔다:
  // 그 사이에 전체 유실·다시 만들기가 끼면 기록되는 판 번호가 낡아 판매 예약 커밋의 판 번호 확인이 묶기부터 다시 하게 한다. 다시 만들기는 묶음 기록
  // (주문 pinned_at, BUILD_ORDER PRF-167)을 읽으므로 그 사이에 끼면 그 시도는 아직 묶이지 않은 것으로 보인다: 원장 홀드가 만료 전이면 그것으로 되살아나고,
  // 만료가 지났으면 되살아나지 않아 다음 묶기가 STALE_GEN으로 과금 없이 끝난다(이 모형은 이 갈래를 두지 않는다. 판매가 늘지 않는 쪽이다)
  action pin(h: int): bool = {
    val a = att(h)
    val p = personOf(h)
    val s = seatSet(a.seats)
    val free = s.filter(x => red.seats.get(x).hid == 0)
    val regrab = a.gen == red.gen
    val ok = s.forall(x => red.seats.get(x).hid == h or (red.seats.get(x).hid == 0 and regrab)) and red.quota.get(p) + free.size() <= LIMIT
    val t = nextTok
    all {
      PIN_BEFORE_SALE, a.phase == "ACCEPTED", usable,
      if (ok)
        all { redWrite(setQuota(red.with("seats", putSeats(red.seats, s, { hid: h, pinned: true }))
                                   .with("counter", if (free.size() > 0) counterAfter(red) else red.counter), p, red.quota.get(p) + free.size())),
              atts' = atts.set(h, a.with("phase", "PINNED").with("late", false).with("gen", red.gen)),
              ghost' = if (free.size() > 0) setNewest(noteTok(ghost, t), free, h) else ghost }
      else
        all { redKeep, atts' = atts.set(h, a.with("phase", "FAILED")), ghost' = ghost },
      db' = db, env' = env,
    }
  }

  // ---- 판매 예약 트랜잭션(seat-hold §6, data.md §4의 2번): 좌석 ID 순으로 PENDING을 넣고, 마지막 좌석과 함께 한도 행을 조건부로 갱신해 커밋 ----
  def saleReady(h: int): bool = att(h).phase == (if (PIN_BEFORE_SALE) "PINNED" else "ACCEPTED")
  def staleAgainst(x: int, h: int): bool = {
    val n = ghost.newest.get(x)
    n != 0 and n != h and Set("ACCEPTED", "PINNED", "RESERVED", "SOLD").contains(att(n).phase)
  }
  def insertOrder(h: int): List[int] = if (SORTED_INSERT) sortedList(att(h).seats) else att(h).seats

  action saleStep(h: int): bool = {
    val a = att(h)
    val l = insertOrder(h)
    {
      // 커밋 전이 아닌 시도에서도 값을 셀 수 있게 범위 밖이면 아무 좌석이나 본다(아래 첫 확인이 걸음을 막는다)
      val x = if (a.ins < l.length()) l[a.ins] else SEAT0
      val p = personOf(h)
      val s = seatSet(l)
      val last = a.ins + 1 == l.length()
      val conflict = UNIQUE_INDEX and db.sale.get(x).size() > 0
      val blocked = UNIQUE_INDEX and db.unc.get(x) != 0 and db.unc.get(x) != h
      val quotaOk = not(DB_QUOTA) or db.used.get(p) + s.size() <= LIMIT
      val rolledBack = db.with("unc", db.unc.keys().mapBy(y => if (db.unc.get(y) == h) 0 else db.unc.get(y)))
      all {
        saleReady(h), a.ins < l.length(), not(blocked),
        if (conflict)
          // 유일 위반(경합에서 짐): 결제사 승인을 부르기 전이라 과금 없이 끝난다
          all { db' = rolledBack, atts' = atts.set(h, a.with("phase", "FAILED").with("ins", 0)), ghost' = ghost }
        else if (not(last))
          all { db' = if (UNIQUE_INDEX) db.with("unc", db.unc.set(x, h)) else db, atts' = atts.set(h, a.with("ins", a.ins + 1)), ghost' = ghost }
        else if (PIN_BEFORE_SALE and a.gen != db.gen)
          // 묶은 뒤 다시 만들기가 있었다: 커밋하지 않고 묶기부터 다시 한다(그 판의 좌석 Redis에 내 홀드가 남았는지 본다).
          // 이 확인과 커밋이 한 걸음인 것은 구현의 전제다: 판매 예약 트랜잭션은 판 번호 행을 FOR SHARE로 잠가 읽고 같은 트랜잭션에서
          // 커밋하며, RB-06은 판 번호를 올려 커밋한 뒤에 판매 행을 읽는다(잠그지 않고 읽으면 그 사이 다시 만들기가 빠져나간다, 코드 리뷰 2026-11-02)
          all { db' = rolledBack, atts' = atts.set(h, a.with("phase", "ACCEPTED").with("ins", 0)), ghost' = ghost }
        else if (not(quotaOk))
          all { db' = rolledBack, atts' = atts.set(h, a.with("phase", "FAILED").with("ins", 0)), ghost' = ghost }
        else
          all { db' = rolledBack.with("sale", db.sale.keys().mapBy(y => if (s.contains(y)) db.sale.get(y).union(Set(h)) else db.sale.get(y)))
                                .with("used", db.used.set(p, db.used.get(p) + s.size())),
                atts' = atts.set(h, a.with("phase", "RESERVED").with("ins", 0)),
                // ③: 커밋하는 순간, 그 좌석의 가장 새 펜싱 토큰을 받은 시도가 따로 있고 그 시도가 결제 접수까지 와서 살아 있으면 낡은 홀드로
                //   판매 확정한 것이다(좌석 Redis가 장애로 잊었어도 센다. 결제 접수 전에 잃은 홀드는 ADR-0121이 받아들인 손실이라 세지 않는다)
                ghost' = if (s.exists(y => staleAgainst(y, h))) ghost.with("stale", ghost.stale + 1) else ghost },
        redKeep, env' = env,
      }
    }
  }

  // 승인 성공: PENDING → SOLD(같은 활성 행)
  action approve(h: int): bool = all {
    att(h).phase == "RESERVED",
    atts' = atts.set(h, att(h).with("phase", "SOLD")),
    redKeep, db' = db, env' = env, ghost' = ghost,
  }

  // 승인 거절·기한 초과(결제 상태 T11): PENDING을 지우고 한도 행을 되돌린다
  action decline(h: int): bool = {
    val a = att(h)
    all {
      a.phase == "RESERVED",
      atts' = atts.set(h, a.with("phase", "FAILED")),
      db' = db.with("sale", db.sale.keys().mapBy(y => db.sale.get(y).exclude(Set(h))))
              .with("used", db.used.set(personOf(h), db.used.get(personOf(h)) - seatSet(a.seats).size())),
      redKeep, env' = env, ghost' = ghost,
    }
  }

  // 결제가 실패한 시도의 좌석 해제(좌석 해제 사건을 받은 소비자의 Lua): 그 시도의 홀드인 좌석만 푼다
  action releaseFailed(h: int): bool = {
    val a = att(h)
    val mine = seatSet(a.seats).filter(x => red.seats.get(x).hid == h)
    all {
      FAIL_RELEASE, a.phase == "FAILED", usable, mine.size() > 0,
      redWrite(setQuota(red.with("seats", putSeats(red.seats, mine, EMPTY)), personOf(h), red.quota.get(personOf(h)) - mine.size())),
      atts' = atts, db' = db, env' = env, ghost' = clearNewest(ghost, mine, h),
    }
  }

  // 홀드 원장 적재(Redis Stream → Kafka → seat_hold): 주 노드에 있는 홀드의 HELD 사건을 적재한다.
  // 이 모형에서 원장은 RB-06 다시 만들기만 읽으므로, 전체 유실이 없는 범위에서는 걸음을 두지 않는다
  action relay(h: int): bool = all {
    FULL_LOSS,
    not(db.ledger.contains(h)),
    seatSet(att(h).seats).exists(x => red.seats.get(x).hid == h),
    db' = db.with("ledger", db.ledger.union(Set(h))),
    redKeep, atts' = atts, env' = env, ghost' = ghost,
  }

  // ---- 좌석 Redis 복제와 장애 전환(ADR-0121) ----
  action replicate: bool = all {
    redRep != red,
    redRep' = red, red' = red,
    atts' = atts, db' = db, env' = env, ghost' = ghost,
  }

  // 주 노드 승격: 복제본이 주 노드가 되고 따라잡지 못한 쓰기 하나를 잃는다. 세대 키는 복제본에도 있어 그대로 받는다(세대 값은 화면용이라 두지 않는다)
  action promote: bool = all {
    PROMOTE,
    env.partials + env.fulls < MAX_FAILOVERS,
    redRep != red,
    red' = redRep, redRep' = redRep,
    env' = env.with("partials", env.partials + 1),
    atts' = atts, db' = db, ghost' = ghost,
  }

  // 클러스터 전체 유실: 회차 키(세대 키 포함)가 모두 사라진다
  action loseAll: bool = all {
    FULL_LOSS,
    env.partials + env.fulls < MAX_FAILOVERS,
    red' = RED0.with("ready", false).with("gen", 0), redRep' = RED0.with("ready", false).with("gen", 0),
    env' = env.with("fulls", env.fulls + 1),
    atts' = atts, db' = db, ghost' = ghost,
  }

  // RB-06 다시 만들기(seat-hold §6의 5, ADR-0121 결정 6): ① 판매(PENDING·SOLD) ② 적재된(원장에 HELD 사건이 있는) 시도 가운데 시간이 다 되지 않은
  // 시도의 홀드(빈 좌석에만, 묶이지 않은 홀드로. 운영은 만료 전 원장 홀드와, 주문 pinned_at이 있는 결제 접수 주문의 원장 HELD 행을 만료 시각과 상관없이 본다,
  // BUILD_ORDER PRF-167) ③ 보유 수 ④ 세대 키를 마지막에. 추천안(OPEN[15])은 그 앞에 DB의 다시 만들기 판 번호를 올리고 세대 키에 같은 번호를 둔다(정본 그대로의 모듈에서는
  // 그 번호를 읽는 걸음이 없어 결과가 같다). 펜싱 카운터는 정본이 다시 쓰지 않는다
  action rebuild: bool = {
    val live = db.ledger.filter(h => not(att(h).late) and Set("HELD", "ACCEPTED", "PINNED", "DONE").contains(att(h).phase))
    val seats2: int -> SeatR = SEATS.mapBy(x =>
      if (db.sale.get(x).size() > 0) { hid: minOf(db.sale.get(x)), pinned: true }
      else if (live.exists(h => seatSet(att(h).seats).contains(x))) { hid: minOf(live.filter(h => seatSet(att(h).seats).contains(x))), pinned: false }
      else EMPTY)
    val quota2 = PEOPLE.mapBy(p => SEATS.filter(x => seats2.get(x).hid != 0 and personOf(seats2.get(x).hid) == p).size())
    all {
      not(red.ready),
      redWrite({ ready: true, gen: db.gen + 1, counter: red.counter, seats: seats2, quota: quota2 }),
      db' = db.with("gen", db.gen + 1),
      atts' = atts, env' = env, ghost' = ghost,
    }
  }

  action step = any {
    nondet h = HIDS.oneOf()
    nondet l = REQUESTS.oneOf()
    any { hold(h, l), ttlPasses(h), expire(h), accept(h), pin(h), saleStep(h), approve(h), decline(h), releaseFailed(h), relay(h) },
    replicate, promote, loseAll, rebuild,
  }

  // ---- 언제나 참(docs/verification.md §2.1 `seat` ①~③과 정본이 적은 두 약속 ④⑤) ----
  // ① 좌석당 판매 1건 이하(오버셀 0): 좌석마다 활성(PENDING·SOLD) 판매 행이 하나 이하
  val inv_noOversell = SEATS.forall(x => db.sale.get(x).size() <= 1)
  // ② 1인 한도 초과 판매 0: 사람마다 판매 예약·판매된 좌석 수 ≤ 한도(POL-011)
  def soldBy(p: int): int = HIDS.filter(h => personOf(h) == p and Set("RESERVED", "SOLD").contains(att(h).phase))
                                .fold(0, (acc, h) => acc + att(h).seats.length())
  val inv_quotaNotExceeded = PEOPLE.forall(p => soldBy(p) <= LIMIT)
  // ③ 만료된 홀드(펜싱 토큰이 낡은 것)로 판매 확정: 장애 전환이 없으면 0, 있으면 주 노드 승격 한 번에 1건 이하(세는 법은 staleAgainst).
  //   정본은 0이라 적는다. 승격이 묶기 쓰기를 잃는 몫은 ADR-0121 '남는 한계'의 잃은 쓰기와 같은 종류로 두자고 묻는다(PROGRESS OPEN[15])
  val inv_staleSalesBounded = ghost.stale <= env.partials
  // ④ 펜싱 토큰은 홀드 순서대로 커진다(seat-hold §3 '엄격한 단조 증가'. 원장 적재와 델타 전파가 옛 토큰의 사건을 버리는 데 기댄다)
  val inv_fencingTokensIncrease = not(ghost.tokBroken)
  // ⑤ 판매 예약 트랜잭션끼리 교착 0(좌석 ID 정렬의 목적, seat-hold §3·§6, K3): 커밋 전 행을 서로 기다리는 둘·셋의 고리가 없다
  def waitsOn(h: int): int = {
    val a = att(h)
    val l = insertOrder(h)
    if (UNIQUE_INDEX and saleReady(h) and a.ins < l.length()) { val u = db.unc.get(l[a.ins]) if (u != h) u else 0 } else 0
  }
  val inv_noDeadlock = HIDS.forall(h => {
    val w1 = waitsOn(h)
    if (w1 == 0) true else { val w2 = waitsOn(w1) if (w2 == 0) true else not(w2 == h or waitsOn(w2) == h) }
  })

  val safety = inv_noOversell and inv_quotaNotExceeded and inv_staleSalesBounded and inv_fencingTokensIncrease and inv_noDeadlock

  // ---- 결국 일어남(docs/verification.md §2.1 `seat` '홀드는 판매나 만료로 끝난다'): 공정성 가정 아래에서 ----
  val vars = (red, redRep, atts, db, env, ghost)
  // 그 시도의 홀드가 좌석 Redis(주 노드)에 남아 있다: 좌석 가운데 하나라도 그 시도가 잡고 있다(묶였든 아니든)
  def holding(h: int): bool = seatSet(att(h).seats).exists(x => red.seats.get(x).hid == h)
  // ① 홀드는 판매(SOLD)나 풀림(만료 Lua·실패 해제)으로 끝난다. 결제 접수는 사람의 걸음이라 홀드(HELD)에 머무는 시도도 있으므로 단계가 아니라
  //    좌석 Redis의 홀드로 센다. 장애 전환으로 홀드를 잃는 것도 풀림으로 보고(ADR-0121이 받아들인 손실), 다시 만들기가 되살리면 다시 센다.
  //    판매된 좌석은 판매 반영이라 계속 남는다
  // ② 결제를 접수한 시도(ACCEPTED·PINNED·RESERVED)는 판매(SOLD)나 과금 없는 실패(FAILED)로 끝난다(묶기·판매 예약·판 번호가 바뀐 뒤
  //    묶기부터 다시·승인 결과에서 멈추지 않는다). 홀드·접수가 거절된 시도(DONE)의 남은 좌석은 ①이 본다
  temporal liveness = HIDS.forall(h => and {
    always(holding(h) implies eventually(att(h).phase == "SOLD" or not(holding(h)))),
    always(Set("ACCEPTED", "PINNED", "RESERVED").contains(att(h).phase) implies eventually(Set("SOLD", "FAILED").contains(att(h).phase))),
  })
  // 공정성: 할 수 있는 동안 결국 일어나는 걸음. 시간의 흐름(ttlPasses: 홀드 TTL 7분은 결국 지난다), 만료 작업(expire: 1초 반복, PRF-135),
  // 결제 접수 Saga의 묶기·판매 예약(pin·saleStep), 결제 결과(approve·decline: 승인 반영 또는 승인 거절·기한 초과. 결과가 결국 오는 것은
  // `payment` 명세의 진행성이 본다), 좌석 해제 사건 소비자(releaseFailed), 홀드 원장 적재(relay), 비동기 복제(replicate),
  // 다시 만들기(rebuild: 세대 키가 없는 회차를 찾는 반복이 부른다, seat-hold §6의 5·PRF-160). 사람의 걸음(hold: 홀드 요청, accept: 결제창 인증 뒤
  // 결제 접수)과 장애(promote·loseAll)에는 걸지 않는다(사람은 홀드를 잡고 떠날 수 있고, 장애는 일어나지 않을 수도 있다)
  temporal fairness = and {
    HIDS.forall(h => and {
      weakFair(ttlPasses(h), vars), weakFair(expire(h), vars), weakFair(pin(h), vars), weakFair(saleStep(h), vars),
      weakFair(approve(h), vars), weakFair(decline(h), vars), weakFair(releaseFailed(h), vars), weakFair(relay(h), vars),
    }),
    weakFair(replicate, vars), weakFair(rebuild, vars),
  }
  temporal fairLiveness = fairness implies liveness
}

// ---- 검사 모듈(specs/specs.json이 고른다) ----
// 범위(2026-11-02 측정, specs/README.md): 정본 범위(좌석 3석, 사람 3명 시도 2번씩, 1인 한도 2매, 장애 전환 1회)의 TLC는 10분 동안 상태
// 2,000만 개를 넘어도 깊이 11에 머물러 끝나지 않아, 전수 검사는 사람 2명(한 사람은 시도 2번)·요청 4가지로 줄이고 정본 범위 전체는
// 시뮬레이션이 본다(`seat_proposed_full`). 진행성은 더 줄인 범위(`seat_live`)에서 TLC만 본다

// 정본에 적힌 그대로: 결제 접수의 홀드 확인 뒤 판매 예약 전에 좌석을 묶지 않고, 펜싱 토큰은 회차 카운터다
module seat_canon {
  import seat(PEOPLE = Set(1, 2), SEATS = Set(1, 2, 3), LIMIT = 2, ATTEMPTS = Set((1, 1), (1, 2), (2, 1)), REQUESTS = Set([1], [1, 2], [2, 1], [2, 3]),
              MAX_FAILOVERS = 1, FULL_LOSS = true, PROMOTE = true, UNIQUE_INDEX = true, DB_QUOTA = true, SORTED_INSERT = true, READY_CHECK = true,
              PIN_BEFORE_SALE = false, TOKEN_TIME_FLOOR = false, FAIL_RELEASE = true).*
}

// OPEN[15]의 추천안만 더함: 펜싱 토큰은 정본 그대로(OPEN[16]의 틈만 남긴다)
module seat_canon_fencing {
  import seat(PEOPLE = Set(1, 2), SEATS = Set(1, 2, 3), LIMIT = 2, ATTEMPTS = Set((1, 1), (1, 2), (2, 1)), REQUESTS = Set([1], [1, 2], [2, 1], [2, 3]),
              MAX_FAILOVERS = 1, FULL_LOSS = true, PROMOTE = true, UNIQUE_INDEX = true, DB_QUOTA = true, SORTED_INSERT = true, READY_CHECK = true,
              PIN_BEFORE_SALE = true, TOKEN_TIME_FLOOR = false, FAIL_RELEASE = true).*
}

// OPEN[15]·OPEN[16]의 추천안(전수 검사 범위)
module seat_proposed {
  import seat(PEOPLE = Set(1, 2), SEATS = Set(1, 2, 3), LIMIT = 2, ATTEMPTS = Set((1, 1), (1, 2), (2, 1)), REQUESTS = Set([1], [1, 2], [2, 1], [2, 3]),
              MAX_FAILOVERS = 1, FULL_LOSS = true, PROMOTE = true, UNIQUE_INDEX = true, DB_QUOTA = true, SORTED_INSERT = true, READY_CHECK = true,
              PIN_BEFORE_SALE = true, TOKEN_TIME_FLOOR = true, FAIL_RELEASE = true).*
}

// 정본 범위 전체(시뮬레이션만): 좌석 3석, 사람 3명(홀드 시도 2번씩, 요청은 좌석 1~2석의 모든 목록), 1인 한도 2매, 장애 전환 1회
module seat_proposed_full {
  import seat(PEOPLE = Set(1, 2, 3), SEATS = Set(1, 2, 3), LIMIT = 2, ATTEMPTS = Set((1, 1), (1, 2), (2, 1), (2, 2), (3, 1), (3, 2)),
              REQUESTS = Set([1], [2], [3], [1, 2], [2, 1], [1, 3], [3, 1], [2, 3], [3, 2]),
              MAX_FAILOVERS = 1, FULL_LOSS = true, PROMOTE = true, UNIQUE_INDEX = true, DB_QUOTA = true, SORTED_INSERT = true, READY_CHECK = true,
              PIN_BEFORE_SALE = true, TOKEN_TIME_FLOOR = true, FAIL_RELEASE = true).*
}

// 진행성 범위(TLC 진행성 검사, 추천 적용 2026-11-05 BUILD_ORDER PRF-150 ①): 좌석 2석, 사람 2명 시도 1번씩, 겹치는 요청 [1]·[1,2], 1인 한도 2매,
// 장애 전환 1회(주 노드 승격 또는 전체 유실). 두 사람이 같은 좌석을 다투고, 승격이 묶기를 잃어 두 판매 예약이 서로 기다리거나, 전체 유실 뒤
// 다시 만들기와 판 번호가 바뀐 묶기부터 다시를 지나도 끝나는지 본다. 한 사람의 시도 2번을 더하면(시도 3개) 3분 남짓에 상태 87만 개를 넘어도
// 끝나지 않아(2026-11-05 측정) 줄였다
module seat_live {
  import seat(PEOPLE = Set(1, 2), SEATS = Set(1, 2), LIMIT = 2, ATTEMPTS = Set((1, 1), (2, 1)), REQUESTS = Set([1], [1, 2]),
              MAX_FAILOVERS = 1, FULL_LOSS = true, PROMOTE = true, UNIQUE_INDEX = true, DB_QUOTA = true, SORTED_INSERT = true, READY_CHECK = true,
              PIN_BEFORE_SALE = true, TOKEN_TIME_FLOOR = true, FAIL_RELEASE = true).*
}

// 변형(검사가 살아 있는지, V-T1): 추천안 모듈에서 하나씩 끄면 그 불변식의 반례가 나와야 한다.
// 범위는 변형마다 반례가 나오는 작은 범위로 줄였다(PR마다 도는 시뮬레이션 1만 회가 반례를 찾을 수 있게. 전수 검사의 가장 짧은 반례는 같다)

// 두 사람이 같은 1석: 승격이 앞사람의 묶기를 잃은 뒤 뒷사람도 그 좌석을 잡아 판매 예약한다
module seat_no_unique {
  import seat(PEOPLE = Set(1, 2), SEATS = Set(1, 2), LIMIT = 2, ATTEMPTS = Set((1, 1), (2, 1)), REQUESTS = Set([1]),
              MAX_FAILOVERS = 1, FULL_LOSS = false, PROMOTE = true, UNIQUE_INDEX = false, DB_QUOTA = true, SORTED_INSERT = true, READY_CHECK = true,
              PIN_BEFORE_SALE = true, TOKEN_TIME_FLOOR = true, FAIL_RELEASE = true).*
}

// 한 사람이 1석을 산 뒤 승격이 그 좌석의 묶기를 잃고, 2석을 더 산다
module seat_no_db_quota {
  import seat(PEOPLE = Set(1), SEATS = Set(1, 2, 3), LIMIT = 2, ATTEMPTS = Set((1, 1), (1, 2)), REQUESTS = Set([1], [2, 3]),
              MAX_FAILOVERS = 1, FULL_LOSS = false, PROMOTE = true, UNIQUE_INDEX = true, DB_QUOTA = false, SORTED_INSERT = true, READY_CHECK = true,
              PIN_BEFORE_SALE = true, TOKEN_TIME_FLOOR = true, FAIL_RELEASE = true).*
}

// 같은 두 좌석을 반대 순서로 요청한 두 주문이 승격 뒤 함께 판매 예약에 들어간다
module seat_unsorted {
  import seat(PEOPLE = Set(1, 2), SEATS = Set(1, 2), LIMIT = 2, ATTEMPTS = Set((1, 1), (2, 1)), REQUESTS = Set([1, 2], [2, 1]),
              MAX_FAILOVERS = 1, FULL_LOSS = false, PROMOTE = true, UNIQUE_INDEX = true, DB_QUOTA = true, SORTED_INSERT = false, READY_CHECK = true,
              PIN_BEFORE_SALE = true, TOKEN_TIME_FLOOR = true, FAIL_RELEASE = true).*
}

// 두 사람이 같은 1석: 앞사람이 묶은 뒤 클러스터가 통째로 사라지고, 다시 만들기 전에 뒷사람이 그 좌석을 잡아 결제를 접수한다.
// 장애 전환은 전체 유실만 둔다(한 번뿐인 장애 전환을 주 노드 승격이 앞쪽 걸음에서 쓰면 시뮬레이션이 이 반례에 잘 닿지 않는다)
module seat_no_ready_check {
  import seat(PEOPLE = Set(1, 2), SEATS = Set(1, 2), LIMIT = 2, ATTEMPTS = Set((1, 1), (2, 1), (2, 2)), REQUESTS = Set([1]),
              MAX_FAILOVERS = 1, FULL_LOSS = true, PROMOTE = false, UNIQUE_INDEX = true, DB_QUOTA = true, SORTED_INSERT = true, READY_CHECK = false,
              PIN_BEFORE_SALE = true, TOKEN_TIME_FLOOR = true, FAIL_RELEASE = true).*
}


// 결제 실패 해제를 끈 변형(진행성 반례 기대, V-T1): 묶인 좌석은 만료 인덱스에 없어, 판매 예약 뒤 승인이 거절된 시도의 좌석이 끝내 풀리지 않는다
module seat_live_no_fail_release {
  import seat(PEOPLE = Set(1, 2), SEATS = Set(1, 2), LIMIT = 2, ATTEMPTS = Set((1, 1), (2, 1)), REQUESTS = Set([1], [1, 2]),
              MAX_FAILOVERS = 1, FULL_LOSS = true, PROMOTE = true, UNIQUE_INDEX = true, DB_QUOTA = true, SORTED_INSERT = true, READY_CHECK = true,
              PIN_BEFORE_SALE = true, TOKEN_TIME_FLOOR = true, FAIL_RELEASE = false).*
}
