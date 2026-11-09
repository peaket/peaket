// -*- mode: Bluespec; -*-
// 결제 명세(wbs 0.9.3, docs/verification.md §2.1 `payment`).
// 근거: ADR-0015(결제사 2단계 승인), ADR-0044(결제사 선택·고정·전환), ADR-0106(승인 뒤 발권 재시도, 보상은 두 경우만),
//       ADR-0107(접수하지 않은 주문의 만료), ADR-0140(결과 당기기), docs/features/payment.md §2(흐름)·§2.1(어댑터 계약, 결과 코드)·
//       §2.2(결제사 선택·고정·전환)·§3(상태 전이)·§4·§4.2(실패·보상, 시나리오 1·2·4·5·6·11·12·13·17·21)·§5(웹훅)·§8(대사),
//       docs/features/transfer-refund.md §5(발권 대기 주문), docs/api/proto/peaket/ticket/v1/ticket.proto `IssueTickets`(주문 ID로 멱등).
// 읽는 법은 specs/README.md. 이 파일은 정본이 아니다. 정본과 다르면 정본이 이기고, 이 파일을 고친다.
//
// 모형으로 줄인 것:
// - 결제사는 둘이다(1 = 기본 토스페이먼츠, 2 = 대체 포트원. 결제사 지정은 회차 칸이고 두 주문은 같은 회차다). 결제사 쪽 상태는
//   (결제사, 주문)마다 하나다. 결제사는 같은 주문을 한 번만 승인한다(토스 orderId는 승인 뒤 다시 쓸 수 없고, 포트원 pay-{orderId}는 성공이
//   한 번뿐이다, payment §2.1 '주문 식별자 재사용'). 결제창 인증은 결제 시도의 결제사에 '인증됨'을 남긴다.
// - 시간: 승인 기한(토스 10분, 포트원 추정 10분), 결제 시도 만료(40분), 주문 만료, 발권 기한(30분)은 '언제든 지날 수 있음'으로만 둔다.
//   승인 기한이 지나면 우리는 승인 요청을 새로 보내지 않는다. 기한 전에 보낸 요청은 결제사가 기한 뒤에 처리해도 승인될 수 있고
//   (정본은 '기한 안에 confirm을 부르지 않으면 만료'만 적는다), 처리할 요청이 없는 인증만 결제사가 만료(EXPIRED)로 바꾼다(코드 리뷰 2026-11-02)
// - 좌석 경합은 `seat`가 본다. 판매 예약은 성공하거나 과금 없이 실패(T8)하는 한 걸음이다.
// - 결과 사건(trade.payments)과 당기기(BatchGetPayments)는 결제 원장의 지금 상태를 읽어 주문 전이 함수로 반영하는 한 걸음이다
//   (옛 사건은 순번 거르기와 전이 함수가 막는다, ADR-0140). 주문의 UNKNOWN(T12)은 결제 원장의 결과 모름을 비추는 표시라 RESERVED에 둔다.
// - 웹훅은 정본대로 결제 기록의 결제사 경로일 때 조회를 부르는 신호다(§5). 그래서 '조회는 결과가 정해졌을 때 언제든 몇 번이든
//   일어날 수 있음'이 웹훅의 중복·지연·순서 바뀜을 덮는다(조회 결과는 결제사의 지금 상태라 웹훅 순서와 상관없다). 웹훅 걸음은 웹훅 본문을
//   믿는 변형에만 둔다. 대사(§8)는 불일치를 찾아 결과 모름 해소로 넘기는 일이라 조회가 덮는다(불변식은 불일치가 생기는 순간을 센다).
// - 승인 호출은 'CONFIRM_SENT 표시를 남기고 부름(send) → 결제사가 처리(pgProcess) → 응답(respond) 또는 시간 초과(timeout)·재시작(restart)'이다.
//   같은 멱등키로 다시 보내는 것은 결제사가 처음 요청을 늦게 처리하는 것과 결과가 같아(멱등) 따로 두지 않는다.
// - 발권은 '부름(issue) → ticket-svc 처리(ticketSvc, 주문 ID로 멱등) → purchase-svc가 답을 받음(issueAck)'이다. 답을 기다리다 그만두면
//   (DEADLINE_EXCEEDED) 실패로 받고, 그 요청은 ticket-svc에서 나중에 처리될 수 있다(티켓이 생긴다). ticket-svc가 그 주문을 끝내 발권하지
//   못하는 경우(발권 기한을 넘기는 장애나 발권 불가 오류, ticketBreaks)도 둔다. 발권 실패는 모두 다시 보낼 수 있는 오류로 둔다.
//   ticket-svc는 결국 다시 살아나 다른 호출(추천안의 발권 막기)에는 답한다고 둔다. 끝내 살아나지 않으면 추천안의 보상(환불)도 끝나지 않는다
//   (막기에 그 가정을 빼면 진행성 반례가 나온다. 코드 리뷰 2026-11-02, PROGRESS OPEN[17]의 대가)
// - 보상은 '시작(주문을 보상 중으로, 큐 행 지움) → (발권 막기, 추천안) → 결제사 취소와 COMPENSATED'다. 정본은 순서를 적지 않아, 발권 재시도를
//   멈추는 트랜잭션이 먼저이고 결제사 취소는 그 뒤(Outbox로)라고 둔다. 결제사 취소는 멱등키로 결국 성공한다고 두고 한 걸음으로 끝낸다.
// - 정본에 없어 모형이 고른 것: 결제 접수 본문의 결제사·결제 참조는 활성 시도와 같다(다르면 409, 시나리오 18. 보안 확인이라 뺀다).
// 뺀 것: 가상계좌, 금액 대조·위변조(승인 금액이 다를 때의 바로 취소, §4.2 10. 결과 모름을 풀 때, 곧 주문이 승인을 반영하기 전에 끝난다고
//        둔다. 발권 뒤 대사에서 금액 불일치로 자동 취소하면 ③·④가 `payment_canon`과 같은 모양으로 깨진다), 판매 일시정지·새 결제 일시 정지, 채널 상한과 재시도 큐의 순서,
//        발권 뒤 예매 취소(POL-032, `entry` 쪽), 부분 취소, 결제 수단 연결값, 멱등키 보관 기한(포트원 3시간),
//        purchase-svc 재시작(상태가 DB·Outbox·발권 큐에 있어 이어 간다).
module payment {
  // ---- 범위(작은 범위, docs/verification.md §2.1. 검사 모듈이 정한다) ----
  const ORDERS: Set[int]
  const MAX_ATTEMPTS: int       // 주문마다 결제 시도 수(결제창을 닫고 다시 시도, 이전 시도 대체)
  const MAX_SWITCHES: int       // 대체 결제사 전환(명령 6)을 켜고 끈 횟수
  const MAX_TIMEOUTS: int       // 승인 응답 시간 초과(읽기 60초)
  const MAX_RESTARTS: int       // payment-svc 재시작(승인 결과를 원장에 쓰기 전)
  const MAX_WEBHOOKS: int       // 웹훅 본문을 믿는 변형에서만 쓴다(정본은 웹훅이 조회를 부르는 신호라 조회가 덮는다)
  const EVENT_CANCEL: bool      // 회차 취소가 확정될 수 있는지
  const TICKET_BREAK: bool      // ticket-svc가 어떤 주문을 끝내 발권하지 못할 수 있는지(발권 불가 → CS 확인 → 보상 경로)
  // ---- 설계 장치(하나씩 끈 변형으로 검사가 살아 있는지 본다, V-T1) ----
  const PG_PINNED: bool              // ② 접수 뒤 승인 명령·조회·취소는 결제 기록의 결제사로만(끄면 그때 고른 결제사로, payment §2.2)
  const ONE_PAYMENT_PER_ORDER: bool  // ① 결제 원장 payment.order_id 유일, 승인 명령은 주문 ID로 멱등(§2·§9)
  const NO_ASSUME: bool              // ⑤ 승인 응답을 잃으면(시간 초과·재시작) 결과를 가정하지 않고 조회로 확정(§4, §4.2 4·5)
  const WEBHOOK_QUERY: bool          // ③ 웹훅 본문을 믿지 않고 조회 결과로만 바꿈(§5. 토스 결제 웹훅에는 서명이 없다)
  const FORWARD_RECOVERY: bool       // ④ 승인 뒤 발권 실패에 결제를 취소하지 않고 같은 주문 ID로 다시 발권(ADR-0106 결정 1)
  const ISSUE_RETRY: bool            // 진행성: 발권 재시도 큐(ADR-0106 결정 2. 끄면 실패한 발권을 다시 하지 않는다)
  const CS_PATH: bool                // 진행성: 발권 기한을 넘긴 건을 CS가 확인해 결제 취소를 승인함(ADR-0106 결정 3)
  const ACK_CONDITIONAL: bool        // ⑥ 발권 성공 답은 주문이 APPROVED일 때만 CONFIRMED로 바꾼다(주문 전이 함수의 조건부 갱신, ADR-0113)
  // 정본에 없음(PROGRESS OPEN[17]의 추천안): 보상(회차 취소 확정·CS 확인 뒤 결제 취소)은 주문을 보상 중으로 바꾼 뒤(늦게 온 발권 성공 답이
  // CONFIRMED를 쓰지 못하게), 결제사 취소 전에 ticket-svc에 주문 단위 '발권 막기'를 한다. 그 주문의 티켓이 이미 있으면 폐기하고, 없으면 앞으로
  // 오는 IssueTickets(같은 주문 ID)를 FAILED_PRECONDITION으로 거절하게 남긴다(ticket-svc가 주문 ID 행 잠금으로 발권과 줄 세움). 정본은
  // '발권 재시도를 멈추고 결제를 취소'만 적어(transfer-refund §5, ADR-0106 결정 3), 응답을 잃은 발권이나 진행 중인 발권 호출이 만든 티켓이
  // 결제 취소 뒤에도 남는다
  const ISSUE_FENCE: bool

  // ---- 값 ----
  pure val PGS: Set[int] = Set(1, 2)
  pure val PRIMARY: int = 1
  pure val FALLBACK: int = 2
  pure val KS: Set[int] = 1.to(MAX_ATTEMPTS)
  // 주문(purchase-svc DB). st: CREATED·ACCEPTED(접수 202)·RESERVED(판매 예약 PENDING)·APPROVED(승인 반영, 발권 전)·CONFIRMED(발권)·
  // FAILED(접수 뒤 과금 없이 실패)·EXPIRED(접수하지 않고 끝남)·COMPENSATING(보상 시작, 결제사 취소 전)·COMPENSATED(승인 뒤 보상)·
  // REFUNDED(발권 뒤 회차 취소 환불). apg: 접수 때 고정한 결제사(0은 없음), job: 발권 재시도 큐 행(ticket_issue_job),
  // over: 발권 기한을 넘겨 CS 건(TICKET_NOT_ISSUED)이 됨, cs: CS가 확인해 결제 취소를 승인함('시스템 잘못이 확인된 환불')
  type Ord = { st: str, apg: int, job: bool, over: bool, cs: bool }
  // 결제 시도(purchase-svc payment_attempt). st: NONE(아직 없음)·READY·ACCEPTED·SUPERSEDED·EXPIRED
  type Att = { pg: int, st: str }
  // 발권(주문마다). tk: ticket-svc의 그 주문 티켓(NONE·ISSUED·REVOKED), closed: ticket-svc가 그 주문의 발권을 막음(ISSUE_FENCE),
  // req: ticket-svc가 아직 처리하지 않은 IssueTickets 요청이 있음, wait: purchase-svc 쪽(NONE·WAIT 답 기다림·OK·ERR 답이 옴),
  // broken: ticket-svc가 그 주문을 끝내 발권하지 못함
  type Tk = { tk: str, closed: bool, req: bool, wait: str, broken: bool }
  // env: sw(대체 결제사 전환이 켜짐), 쓴 횟수들, canceled(회차 취소 확정)
  type Env = { sw: bool, switches: int, timeouts: int, restarts: int, hooks: int, canceled: bool }
  // 검사에만 쓰는 기록(시스템이 아는 값이 아니다). offPg: 접수 뒤 고정한 결제사가 아닌 곳으로 결제 원장을 만들거나 호출함,
  // badRefund: 회차 취소 확정도 CS 확인도 없이 결제사 취소가 일어남
  type Ghost = { offPg: bool, badRefund: bool }

  var ord: int -> Ord
  var att: (int, int) -> Att      // (주문, 시도 번호)
  var pgs: (int, int) -> str      // (결제사, 주문): NONE·AUTH(인증됨)·APPROVED·DECLINED·EXPIRED(인증 만료)·CANCELED(승인 뒤 취소)
  var req: (int, int) -> bool     // (결제사, 주문): 결제사가 아직 처리하지 않은 승인 요청이 있음
  var pay: (int, int) -> str      // (주문, 결제사): payment-svc 결제 원장. NONE·ACCEPTED(승인 명령 기록)·SENT(CONFIRM_SENT, 응답 기다림)·
                                  //   UNKNOWN(결과 모름)·APPROVED·FAILED·CANCELED
  var late: int -> bool           // 주문의 승인 기한이 지남
  var tks: int -> Tk
  var env: Env
  var ghost: Ghost

  pure val ORD0: Ord = { st: "CREATED", apg: 0, job: false, over: false, cs: false }
  pure val ATT0: Att = { pg: 0, st: "NONE" }
  pure val TK0: Tk = { tk: "NONE", closed: false, req: false, wait: "NONE", broken: false }
  pure val ATT_KEYS: Set[(int, int)] = tuples(ORDERS, KS)
  pure val PO_KEYS: Set[(int, int)] = tuples(PGS, ORDERS)
  pure val OP_KEYS: Set[(int, int)] = tuples(ORDERS, PGS)

  action init = all {
    ord' = ORDERS.mapBy(o => ORD0),
    att' = ATT_KEYS.mapBy(k => ATT0),
    pgs' = PO_KEYS.mapBy(k => "NONE"),
    req' = PO_KEYS.mapBy(k => false),
    pay' = OP_KEYS.mapBy(k => "NONE"),
    late' = ORDERS.mapBy(o => false),
    tks' = ORDERS.mapBy(o => TK0),
    env' = { sw: false, switches: 0, timeouts: 0, restarts: 0, hooks: 0, canceled: false },
    ghost' = { offPg: false, badRefund: false },
  }

  def o_(o: int): Ord = ord.get(o)
  def t_(o: int): Tk = tks.get(o)
  // 결제사 선택기(§2.2): 전환이 켜져 있으면 대체, 아니면 회차의 기본
  def selected: int = if (env.sw) FALLBACK else PRIMARY
  // 접수 뒤 결제사로 가는 길: 정본은 결제 기록(접수 때 고정한 결제사)으로만 간다
  def route(o: int, rowPg: int): int = if (PG_PINNED) rowPg else selected
  def rows(o: int): Set[int] = PGS.filter(p => pay.get((o, p)) != "NONE")
  pure def noteRoute(g: Ghost, fixed: int, p: int): Ghost = g.with("offPg", g.offPg or p != fixed)
  def refundGhost(o: int): Ghost = ghost.with("badRefund", ghost.badRefund or not(env.canceled or o_(o).cs))
  // 결제사 취소(멱등키 cancel-…): 승인된 결제를 취소한다
  def cancelAt(p: int, o: int): (int, int) -> str = if (pgs.get((p, o)) == "APPROVED") pgs.set((p, o), "CANCELED") else pgs
  def payCanceled(o: int): (int, int) -> str = OP_KEYS.mapBy(k => if (k._1 == o and pay.get(k) == "APPROVED") "CANCELED" else pay.get(k))

  // 결제 쪽만 바꾸는 걸음의 나머지
  action keepOrderSide: bool = all { ord' = ord, att' = att, late' = late, tks' = tks }

  // ---- 브라우저: 결제 시도 시작(POST /orders/{id}/payments). 접수 전의 이전 시도는 SUPERSEDED, 새 시도는 그때의 규칙으로 결제사를 고른다 ----
  action newAttempt(o: int): bool = {
    val k = 1 + KS.filter(x => att.get((o, x)).st != "NONE").size()
    all {
      o_(o).st == "CREATED", k <= MAX_ATTEMPTS,
      att' = ATT_KEYS.mapBy(key => if (key == (o, k)) { pg: selected, st: "READY" }
                                   else if (key._1 == o and att.get(key).st == "READY") att.get(key).with("st", "SUPERSEDED")
                                   else att.get(key)),
      ord' = ord, pgs' = pgs, req' = req, pay' = pay, late' = late, tks' = tks, env' = env, ghost' = ghost,
    }
  }

  // 결제창 인증(T3): 대체된 시도의 결제창도 아직 열려 있으면 인증할 수 있다(시나리오 17)
  action auth(o: int, k: int): bool = {
    val a = att.get((o, k))
    all {
      o_(o).st == "CREATED", Set("READY", "SUPERSEDED").contains(a.st), pgs.get((a.pg, o)) == "NONE",
      pgs' = pgs.set((a.pg, o), "AUTH"),
      ord' = ord, att' = att, req' = req, pay' = pay, late' = late, tks' = tks, env' = env, ghost' = ghost,
    }
  }

  // 결제 접수 202(T4, §2.2 '결제사 고정'): 활성 시도만 받고(대체된 시도의 늦은 접수는 409) 결제사를 고정한다. 주문 상태 전이가
  // CREATED에서만 되므로 같은 주문의 두 번째 접수는 409다(주문당 활성 결제 1건, 시나리오 2)
  action accept(o: int, k: int): bool = {
    val a = att.get((o, k))
    all {
      o_(o).st == "CREATED", a.st == "READY", pgs.get((a.pg, o)) == "AUTH",
      att' = att.set((o, k), a.with("st", "ACCEPTED")),
      ord' = ord.set(o, o_(o).with("st", "ACCEPTED").with("apg", a.pg)),
      pgs' = pgs, req' = req, pay' = pay, late' = late, tks' = tks, env' = env, ghost' = ghost,
    }
  }

  // 결제 시도 만료(READY가 40분 지남, ADR-0107)
  action expireAttempt(o: int, k: int): bool = all {
    att.get((o, k)).st == "READY",
    att' = att.set((o, k), att.get((o, k)).with("st", "EXPIRED")),
    ord' = ord, pgs' = pgs, req' = req, pay' = pay, late' = late, tks' = tks, env' = env, ghost' = ghost,
  }

  // 접수하지 않은 주문의 만료(T5·T6, ADR-0107): 활성 결제 시도가 없고 구매 세션·홀드가 끝남. CREATED에서만 바꾸는 조건부 UPDATE
  action expireOrder(o: int): bool = all {
    o_(o).st == "CREATED", KS.forall(k => att.get((o, k)).st != "READY"),
    ord' = ord.set(o, o_(o).with("st", "EXPIRED")),
    att' = att, pgs' = pgs, req' = req, pay' = pay, late' = late, tks' = tks, env' = env, ghost' = ghost,
  }

  // ---- purchase-svc Saga 1: 판매 예약(T7) 또는 좌석이 이미 팔려 과금 없이 실패(T8) ----
  action reserve(o: int): bool = all {
    o_(o).st == "ACCEPTED",
    any { ord' = ord.set(o, o_(o).with("st", "RESERVED")), ord' = ord.set(o, o_(o).with("st", "FAILED")) },
    att' = att, pgs' = pgs, req' = req, pay' = pay, late' = late, tks' = tks, env' = env, ghost' = ghost,
  }

  // 승인 명령(gRPC, 접수만 기다림): payment-svc가 결제 원장에 ACCEPTED와 승인 명령을 한 트랜잭션으로 적는다. 접수되지 않은 명령은
  // 같은 주문 ID로 다시 보내고, payment-svc는 주문 ID로 멱등하다(이미 결제가 있으면 그대로 둔다, §9 'payment-svc 내부 지연')
  action command(o: int): bool = {
    val p = route(o, o_(o).apg)
    all {
      o_(o).st == "RESERVED", pay.get((o, p)) == "NONE",
      not(ONE_PAYMENT_PER_ORDER) or rows(o) == Set(),
      pay' = pay.set((o, p), "ACCEPTED"),
      ghost' = noteRoute(ghost, o_(o).apg, p),
      pgs' = pgs, req' = req, env' = env, keepOrderSide,
    }
  }

  // ---- payment-svc 승인 호출 ----
  // CONFIRM_SENT 표시를 payment_event에 남긴 뒤 결제 원장의 결제사로 승인 API를 부른다(멱등키 confirm-{orderId}, 시나리오 5)
  action send(o: int, p: int): bool = all {
    pay.get((o, p)) == "ACCEPTED", not(late.get(o)),
    pay' = pay.set((o, p), "SENT"), req' = req.set((p, o), true),
    pgs' = pgs, env' = env, ghost' = ghost, keepOrderSide,
  }

  // 승인 기한이 지난 승인 명령은 부르지 않고 과금 없이 실패(§4 '인증 후 승인 유효기한 초과')
  action expireCommand(o: int, p: int): bool = all {
    pay.get((o, p)) == "ACCEPTED", late.get(o),
    pay' = pay.set((o, p), "FAILED"),
    pgs' = pgs, req' = req, env' = env, ghost' = ghost, keepOrderSide,
  }

  // 결제사가 승인 요청을 처리한다(우리 쪽이 기다리기를 그만둔 뒤에도, 승인 기한 뒤에도 처리할 수 있다). 인증되어 있으면 승인 또는 거절,
  // 이미 승인했으면 그대로(ALREADY_APPROVED), 인증이 없거나 끝났으면 승인하지 않는다
  action pgProcess(o: int, p: int): bool = all {
    req.get((p, o)),
    req' = req.set((p, o), false),
    if (pgs.get((p, o)) == "AUTH") any { pgs' = pgs.set((p, o), "APPROVED"), pgs' = pgs.set((p, o), "DECLINED") }
    else pgs' = pgs,
    pay' = pay, env' = env, ghost' = ghost, keepOrderSide,
  }

  // 결제사가 승인한 결제를 결제사 쪽에서 전액 취소함(환경, PRF-182가 넘긴 것). 승인을 기록하지 못해 결과 모름으로 남은 결제만 본다(승인을 기록한 뒤의 취소는 취소 단계 몫이라 뺀다).
  // 조회가 CANCELED로 끝내고(대사가 닫는 행, payment §8) 주문은 과금 없이 실패로 끝난다(T15, BUILD_ORDER HOT-153)
  action pgCancel(o: int, p: int): bool = all {
    pgs.get((p, o)) == "APPROVED", pay.get((o, p)) == "UNKNOWN",
    pgs' = pgs.set((p, o), "CANCELED"),
    req' = req, pay' = pay, env' = env, ghost' = ghost, keepOrderSide,
  }

  // 결제사의 인증 만료: 승인 기한이 지났고 처리할 승인 요청이 없는 인증(토스 EXPIRED)
  action pgExpire(o: int, p: int): bool = all {
    pgs.get((p, o)) == "AUTH", late.get(o), not(req.get((p, o))),
    pgs' = pgs.set((p, o), "EXPIRED"),
    req' = req, pay' = pay, env' = env, ghost' = ghost, keepOrderSide,
  }

  // 승인 응답을 받아 원장에 쓴다(승인이면 APPROVED, 아니면 FAILED)
  action respond(o: int, p: int): bool = all {
    pay.get((o, p)) == "SENT", not(req.get((p, o))),
    pay' = pay.set((o, p), if (pgs.get((p, o)) == "APPROVED") "APPROVED" else "FAILED"),
    pgs' = pgs, req' = req, env' = env, ghost' = ghost, keepOrderSide,
  }

  // 결과를 모름: 읽기 시간 초과·5xx(§4.2 4). 정본은 UNKNOWN으로 두고 조회로 확정한다(요청은 결제사에서 계속 처리될 수 있다)
  pure def lost(s: str): str = if (s != "SENT") s else if (NO_ASSUME) "UNKNOWN" else "FAILED"
  action timeout(o: int, p: int): bool = all {
    pay.get((o, p)) == "SENT", env.timeouts < MAX_TIMEOUTS,
    pay' = pay.set((o, p), lost("SENT")), env' = env.with("timeouts", env.timeouts + 1),
    pgs' = pgs, req' = req, ghost' = ghost, keepOrderSide,
  }

  // payment-svc 재시작(§4.2 5): 응답을 기다리던 호출은 끊긴다. 다시 뜨면 CONFIRM_SENT가 있고 결과가 없는 결제를 조회로 맞춘다.
  // 승인 명령만 적고 부르지 않은 결제(ACCEPTED)는 그대로 이어 간다
  action restart: bool = all {
    env.restarts < MAX_RESTARTS, OP_KEYS.exists(k => pay.get(k) == "SENT"),
    pay' = OP_KEYS.mapBy(k => lost(pay.get(k))), env' = env.with("restarts", env.restarts + 1),
    pgs' = pgs, req' = req, ghost' = ghost, keepOrderSide,
  }

  // 결과 모름 해소(단독 결제 조회 API, 웹훅도 이 조회를 부른다): 결제사가 결과를 정했을 때만 원장이 바뀐다
  // (인증만 된 채면 처리 중이거나 아직 만료 전이라 다음에 다시 묻는다)
  action query(o: int, p: int): bool = {
    val q = route(o, p)
    val s = pgs.get((q, o))
    val res = if (s == "APPROVED") "APPROVED" else if (s == "CANCELED") "CANCELED" else "FAILED"
    all {
      pay.get((o, p)) == "UNKNOWN", s != "AUTH",
      pay' = pay.set((o, p), res),
      ghost' = noteRoute(ghost, o_(o).apg, q),
      pgs' = pgs, req' = req, env' = env, keepOrderSide,
    }
  }

  // 웹훅 본문을 그대로 믿는 변형만: 서명 없는 토스 결제 웹훅이나 늦게 온 옛 웹훅의 본문으로 결제 원장을 바꾼다
  action webhook(o: int, p: int, body: str): bool = all {
    not(WEBHOOK_QUERY), env.hooks < MAX_WEBHOOKS, Set("SENT", "UNKNOWN").contains(pay.get((o, p))),
    pay' = pay.set((o, p), body), env' = env.with("hooks", env.hooks + 1),
    pgs' = pgs, req' = req, ghost' = ghost, keepOrderSide,
  }

  // 승인 기한이 지남(시간이 흐름): 접수한 주문의 결과가 아직 정해지지 않았을 때만 본다
  action deadlinePasses(o: int): bool = all {
    Set("ACCEPTED", "RESERVED").contains(o_(o).st), not(late.get(o)),
    PGS.forall(p => not(Set("APPROVED", "FAILED", "CANCELED").contains(pay.get((o, p))))),
    late' = late.set(o, true),
    ord' = ord, att' = att, pgs' = pgs, req' = req, pay' = pay, tks' = tks, env' = env, ghost' = ghost,
  }

  // ---- purchase-svc: 결과 반영(사건 또는 당기기, 사건과 같은 처리기) ----
  // 승인: seat_sale SOLD + 주문 APPROVED + 발권 재시도 큐 행 + Outbox(한 트랜잭션, ADR-0106). 실패: PENDING 삭제·좌석 해제·주문 FAILED.
  // 결제사 전액 취소로 닫힌 결제(CANCELED, 주문은 T12의 결과 모름을 비춘 RESERVED)도 실패와 같이 끝난다(T15, BUILD_ORDER HOT-153)
  action applyResult(o: int, p: int): bool = all {
    o_(o).st == "RESERVED", Set("APPROVED", "FAILED", "CANCELED").contains(pay.get((o, p))),
    ord' = ord.set(o, if (pay.get((o, p)) == "APPROVED") o_(o).with("st", "APPROVED").with("job", true) else o_(o).with("st", "FAILED")),
    att' = att, pgs' = pgs, req' = req, pay' = pay, late' = late, tks' = tks, env' = env, ghost' = ghost,
  }

  // ---- 발권(ADR-0106) ----
  // 큐 행이 있는 승인 주문에 IssueTickets를 보낸다(주문 ID로 멱등. 큐는 한 행을 한 파드만 잡는다)
  action issue(o: int): bool = all {
    o_(o).st == "APPROVED", o_(o).job, t_(o).wait == "NONE",
    tks' = tks.set(o, t_(o).with("req", true).with("wait", "WAIT")),
    ord' = ord, att' = att, pgs' = pgs, req' = req, pay' = pay, late' = late, env' = env, ghost' = ghost,
  }

  // ticket-svc가 요청을 처리한다: 막은 주문(ISSUE_FENCE)이나 발권할 수 없는 주문이면 거절, 아니면 발권(이미 있으면 그 티켓) 또는 일시 실패.
  // purchase-svc가 이미 기다리기를 그만뒀으면 답은 버려진다
  action ticketSvc(o: int): bool = {
    val t = t_(o)
    val okAns = if (t.wait == "WAIT") "OK" else t.wait
    val errAns = if (t.wait == "WAIT") "ERR" else t.wait
    all {
      t.req,
      if (t.closed or t.broken) tks' = tks.set(o, t.with("req", false).with("wait", errAns))
      else any {
        tks' = tks.set(o, t.with("req", false).with("wait", okAns).with("tk", if (t.tk == "NONE") "ISSUED" else t.tk)),
        tks' = tks.set(o, t.with("req", false).with("wait", errAns)),
      },
      ord' = ord, att' = att, pgs' = pgs, req' = req, pay' = pay, late' = late, env' = env, ghost' = ghost,
    }
  }

  // purchase-svc가 발권 실패를 받음
  action issueFailed(o: int): bool =
    if (FORWARD_RECOVERY)
      // 다시 보낼 수 있는 오류: 큐 행을 두고 다음 시도 시각을 미룬다(ISSUE_RETRY를 끄면 큐에서 뺀다)
      all { ord' = ord.set(o, o_(o).with("job", ISSUE_RETRY)), pgs' = pgs, pay' = pay, ghost' = ghost }
    else
      // 옛 Saga 방식(변형): 발권이 실패하면 바로 결제를 취소한다
      all { ord' = ord.set(o, o_(o).with("st", "COMPENSATED").with("job", false)),
            pgs' = cancelAt(route(o, o_(o).apg), o), pay' = payCanceled(o),
            ghost' = noteRoute(refundGhost(o), o_(o).apg, route(o, o_(o).apg)) }

  // purchase-svc가 답을 받는다(답을 기다리다 그만두면 DEADLINE_EXCEEDED라 실패로 받는다). 성공이면 주문 CONFIRMED와 큐 행 지우기(한 트랜잭션,
  // APPROVED에서만 바꾸는 조건부 갱신). 주문이 이미 APPROVED가 아니면(보상 중 등) 답을 버린다
  action issueAck(o: int): bool = {
    val t = t_(o)
    all {
      t.wait != "NONE",
      tks' = tks.set(o, t.with("wait", "NONE")),
      // 조건부 갱신을 뺀 변형: 보상 중인 주문에도 늦게 온 성공 답이 CONFIRMED를 쓴다
      if (not(ACK_CONDITIONAL) and t.wait == "OK" and o_(o).st == "COMPENSATING")
        all { ord' = ord.set(o, o_(o).with("st", "CONFIRMED").with("job", false)), pgs' = pgs, pay' = pay, ghost' = ghost }
      else if (o_(o).st != "APPROVED") all { ord' = ord, pgs' = pgs, pay' = pay, ghost' = ghost }
      else if (t.wait == "OK") all { ord' = ord.set(o, o_(o).with("st", "CONFIRMED").with("job", false)), pgs' = pgs, pay' = pay, ghost' = ghost }
      else issueFailed(o),
      att' = att, req' = req, late' = late, env' = env,
    }
  }

  // ticket-svc가 그 주문을 끝내 발권하지 못하게 됨(긴 장애·발권 불가, 환경)
  action ticketBreaks(o: int): bool = all {
    TICKET_BREAK, o_(o).st == "APPROVED", not(t_(o).broken),
    tks' = tks.set(o, t_(o).with("broken", true)),
    ord' = ord, att' = att, pgs' = pgs, req' = req, pay' = pay, late' = late, env' = env, ghost' = ghost,
  }

  // 발권 기한(승인 뒤 30분)을 넘김: SEV1과 CS 처리함 TICKET_NOT_ISSUED. 재시도는 이어 간다
  action overdue(o: int): bool = all {
    o_(o).st == "APPROVED", o_(o).job, not(o_(o).over),
    ord' = ord.set(o, o_(o).with("over", true)),
    att' = att, pgs' = pgs, req' = req, pay' = pay, late' = late, tks' = tks, env' = env, ghost' = ghost,
  }

  // CS가 확인해 승인 업무 '시스템 잘못이 확인된 환불'로 결제 취소를 승인함(ADR-0106 결정 3, transfer-refund §3.2)
  action csConfirm(o: int): bool = all {
    CS_PATH, o_(o).st == "APPROVED", o_(o).over, not(o_(o).cs),
    ord' = ord.set(o, o_(o).with("cs", true)),
    att' = att, pgs' = pgs, req' = req, pay' = pay, late' = late, tks' = tks, env' = env, ghost' = ghost,
  }

  // 보상(T20) 시작: 회차 취소가 확정됐거나(일괄 환불 작업이 발권 대기 주문도 넣는다, transfer-refund §5) CS가 확인했을 때만.
  // 발권 재시도를 멈추고(큐 행 지움) 주문을 보상 중으로 바꾼다(APPROVED에서만 바꾸는 조건부 갱신)
  action compStart(o: int): bool = all {
    o_(o).st == "APPROVED", env.canceled or o_(o).cs,
    ord' = ord.set(o, o_(o).with("st", "COMPENSATING").with("job", false)),
    att' = att, pgs' = pgs, req' = req, pay' = pay, late' = late, tks' = tks, env' = env, ghost' = ghost,
  }

  // 추천안(ISSUE_FENCE): ticket-svc의 주문 단위 발권 막기. 티켓이 있으면 폐기하고, 없으면 뒤에 오는 발권을 거절하게 남긴다
  action compFence(o: int): bool = all {
    ISSUE_FENCE, o_(o).st == "COMPENSATING", not(t_(o).closed),
    tks' = tks.set(o, t_(o).with("closed", true).with("tk", if (t_(o).tk == "ISSUED") "REVOKED" else t_(o).tk)),
    ord' = ord, att' = att, pgs' = pgs, req' = req, pay' = pay, late' = late, env' = env, ghost' = ghost,
  }

  // 보상 끝: 결제사에 취소를 보내고(멱등키) 주문 COMPENSATED. 추천안은 발권 막기의 답을 받은 뒤에만 한다
  action compCancel(o: int): bool = {
    val p = route(o, o_(o).apg)
    all {
      o_(o).st == "COMPENSATING", not(ISSUE_FENCE) or t_(o).closed,
      ord' = ord.set(o, o_(o).with("st", "COMPENSATED")),
      pgs' = cancelAt(p, o), pay' = payCanceled(o),
      ghost' = noteRoute(refundGhost(o), o_(o).apg, p),
      att' = att, req' = req, late' = late, tks' = tks, env' = env,
    }
  }

  // 회차 취소 확정(commander 판정 + 1인 승인)
  action eventCancel: bool = all {
    EVENT_CANCEL, not(env.canceled),
    env' = env.with("canceled", true),
    ord' = ord, att' = att, pgs' = pgs, req' = req, pay' = pay, late' = late, tks' = tks, ghost' = ghost,
  }

  // 발권된 주문의 회차 취소 일괄 환불(T24): 티켓 키를 먼저 폐기하고 결제사에 취소를 보낸다(§4.1과 같은 순서)
  action eventRefund(o: int): bool = {
    val p = route(o, o_(o).apg)
    all {
      env.canceled, o_(o).st == "CONFIRMED",
      tks' = tks.set(o, t_(o).with("tk", "REVOKED")),
      ord' = ord.set(o, o_(o).with("st", "REFUNDED")),
      pgs' = cancelAt(p, o), pay' = payCanceled(o),
      ghost' = noteRoute(refundGhost(o), o_(o).apg, p),
      att' = att, req' = req, late' = late, env' = env,
    }
  }

  // 대체 결제사 전환(명령 6)을 켜거나 끈다: 새 결제 시도부터 적용된다
  action toggleSwitch: bool = all {
    env.switches < MAX_SWITCHES,
    env' = env.with("sw", not(env.sw)).with("switches", env.switches + 1),
    ord' = ord, att' = att, pgs' = pgs, req' = req, pay' = pay, late' = late, tks' = tks, ghost' = ghost,
  }

  action step = {
    nondet o = ORDERS.oneOf()
    nondet p = PGS.oneOf()
    nondet k = KS.oneOf()
    nondet b = Set("APPROVED", "FAILED").oneOf()
    any {
      newAttempt(o), auth(o, k), accept(o, k), expireAttempt(o, k), expireOrder(o),
      reserve(o), command(o), send(o, p), expireCommand(o, p), pgProcess(o, p), pgExpire(o, p), pgCancel(o, p), respond(o, p), timeout(o, p), query(o, p),
      webhook(o, p, b), deadlinePasses(o), applyResult(o, p),
      issue(o), ticketSvc(o), issueAck(o), ticketBreaks(o), overdue(o), csConfirm(o), compStart(o), compFence(o), compCancel(o), eventRefund(o),
      restart, eventCancel, toggleSwitch,
    }
  }

  // ---- 언제나 참(docs/verification.md §2.1 `payment` ①~④와 정본이 적은 약속 ⑤⑥) ----
  // ① 주문당 승인된 결제 1건 이하(이중 결제 0): 그 주문을 승인한(뒤에 취소했어도) 결제사가 하나 이하
  val inv_noDoublePayment = ORDERS.forall(o => PGS.filter(p => Set("APPROVED", "CANCELED").contains(pgs.get((p, o)))).size() <= 1)
  // ② 결제 접수 뒤 결제사 바뀜 0: 결제 원장과 결제사로 가는 호출(승인 명령·조회·취소)이 늘 접수 때 고정한 결제사다
  val inv_pgPinnedAfterAccept = not(ghost.offPg)
  // ③ 승인 없는 발권 0: ticket-svc에 유효 티켓이 있으면 그 주문을 승인하고 취소하지 않은 결제사가 있다(payment §8)
  val inv_noTicketWithoutApproval = ORDERS.forall(o => t_(o).tk == "ISSUED" implies PGS.exists(p => pgs.get((p, o)) == "APPROVED"))
  // ④ 회차 취소 확정·CS 확인 없는 승인 뒤 환불 0(ADR-0106 결정 3)
  val inv_noRefundWithoutCause = not(ghost.badRefund)
  // ⑤ 과금 없음으로 끝난 주문(FAILED: 접수 뒤 과금 없이 실패, EXPIRED: 접수하지 않고 끝남)에 결제사 승인이 남지 않는다(payment §3·§8)
  val inv_noChargeOnFailedOrder = ORDERS.forall(o => Set("FAILED", "EXPIRED").contains(o_(o).st) implies PGS.forall(p => pgs.get((p, o)) != "APPROVED"))
  // ⑥ 발권 완료(CONFIRMED, T18)로 끝난 주문에는 유효 티켓이 있다(산 사람이 표 없이 '발권 완료'로 남지 않는다)
  val inv_confirmedHasTicket = ORDERS.forall(o => o_(o).st == "CONFIRMED" implies t_(o).tk == "ISSUED")

  val safety = inv_noDoublePayment and inv_pgPinnedAfterAccept and inv_noTicketWithoutApproval and inv_noRefundWithoutCause
               and inv_noChargeOnFailedOrder and inv_confirmedHasTicket

  // ---- 결국 일어남(docs/verification.md §2.1 `payment`): 공정성 가정 아래에서 ----
  val vars = (ord, att, pgs, req, pay, late, tks, env, ghost)
  def pgApproved(o: int): bool = PGS.exists(p => pgs.get((p, o)) == "APPROVED")
  // 끝: 유효 티켓이 있는 발권 완료, 또는 결제사 승인이 남지 않은 보상·환불·실패(결제사 전액 취소로 끝난 FAILED)
  def settled(o: int): bool =
    (o_(o).st == "CONFIRMED" and t_(o).tk == "ISSUED") or (Set("COMPENSATED", "REFUNDED", "FAILED").contains(o_(o).st) and not(pgApproved(o)))
  def unknown(o: int): bool = PGS.exists(p => pay.get((o, p)) == "UNKNOWN")
  // 승인된 주문은 결국 발권되거나 보상·환불로 끝나고, 결과 모름은 결국 풀리고, 접수하지 않은 주문은 결국 CREATED를 벗어나고(만료 또는 접수),
  // 접수한 주문은 결국 접수·판매 예약 상태를 벗어난다(승인 반영 또는 과금 없는 실패로 좌석을 풂, T9·T11·T15. 코드 리뷰 2026-11-02)
  temporal liveness = ORDERS.forall(o => and {
    always(pgApproved(o) implies eventually(settled(o))),
    always(unknown(o) implies eventually(not(unknown(o)))),
    always(o_(o).st == "CREATED" implies eventually(o_(o).st != "CREATED")),
    always(Set("ACCEPTED", "RESERVED").contains(o_(o).st) implies eventually(not(Set("ACCEPTED", "RESERVED").contains(o_(o).st)))),
  })
  // 공정성: 시스템이 하는 일(주문마다)과 시간의 흐름(결제 시도 만료, 주문 만료, 승인 기한·인증 만료, 발권 기한)은 할 수 있는 동안 결국
  // 일어나고, CS는 TICKET_NOT_ISSUED 건을 결국 확인한다. 발권이 결국 성공한다는 가정은 두지 않는다(답을 기다리다 그만두는 쪽이 늘 먼저일 수
  // 있고, 발권 불가가 될 수 있다). 사람의 동작(결제 시도·인증·접수), 회차 취소, 결제사 전환, 시간 초과·재시작, 발권 불가에는 두지 않는다
  temporal fairness = ORDERS.forall(o => and {
    KS.forall(k => weakFair(expireAttempt(o, k), vars)),
    weakFair(expireOrder(o), vars), weakFair(reserve(o), vars), weakFair(command(o), vars),
    PGS.forall(p => and {
      weakFair(send(o, p), vars), weakFair(expireCommand(o, p), vars), weakFair(pgProcess(o, p), vars), weakFair(pgExpire(o, p), vars),
      weakFair(respond(o, p), vars), weakFair(query(o, p), vars), weakFair(applyResult(o, p), vars),
    }),
    weakFair(deadlinePasses(o), vars), weakFair(issue(o), vars), weakFair(ticketSvc(o), vars), weakFair(issueAck(o), vars),
    weakFair(overdue(o), vars), weakFair(csConfirm(o), vars), weakFair(compStart(o), vars), weakFair(compFence(o), vars),
    weakFair(compCancel(o), vars), weakFair(eventRefund(o), vars),
  })
  temporal fairLiveness = fairness implies liveness
}

// ---- 검사 모듈(specs/specs.json이 고른다) ----
// 범위(2026-11-02 측정, specs/README.md): 정본 범위(주문 2건 결제 시도 2번씩, 결제사 2곳·전환 1회, 시간 초과 1회, 재시작 1회, 회차 취소,
// 발권 불가)는 주문 1건 결제 시도 2번이 상태 30,364개, 주문 2건 결제 시도 1번씩이 6,115,232개(3.2분)라 둘을 합치면 1억 개 안팎으로
// 추정되어(재지 않음) 전수 검사를 두 범위로 나눈다: 주문 2건 결제 시도 1번씩(주문 둘이 전환·시간 초과·재시작 몫을 나눠 씀)과
// 주문 1건 결제 시도 2번(이전 시도 대체, 전환 사이에 두 결제사 인증). 정본 범위 전체는
// 시뮬레이션이 본다(`payment_proposed_full`). 주문 둘은 서로를 기다리지 않아 진행성은 주문 1건으로 본다

// 정본에 적힌 그대로: 보상은 발권 재시도를 멈추고 결제를 취소한다(ticket-svc의 발권은 막지 않는다)
module payment_canon {
  import payment(ORDERS = Set(1, 2), MAX_ATTEMPTS = 1, MAX_SWITCHES = 1, MAX_TIMEOUTS = 1, MAX_RESTARTS = 1, MAX_WEBHOOKS = 0, EVENT_CANCEL = true,
                 TICKET_BREAK = true, PG_PINNED = true, ONE_PAYMENT_PER_ORDER = true, NO_ASSUME = true, WEBHOOK_QUERY = true,
                 FORWARD_RECOVERY = true, ISSUE_RETRY = true, CS_PATH = true, ACK_CONDITIONAL = true, ISSUE_FENCE = false).*
}

// OPEN[17]의 추천안(보상을 시작한 뒤 결제사 취소 전에 ticket-svc의 발권 막기): 주문 2건 결제 시도 1번씩
module payment_proposed {
  import payment(ORDERS = Set(1, 2), MAX_ATTEMPTS = 1, MAX_SWITCHES = 1, MAX_TIMEOUTS = 1, MAX_RESTARTS = 1, MAX_WEBHOOKS = 0, EVENT_CANCEL = true,
                 TICKET_BREAK = true, PG_PINNED = true, ONE_PAYMENT_PER_ORDER = true, NO_ASSUME = true, WEBHOOK_QUERY = true,
                 FORWARD_RECOVERY = true, ISSUE_RETRY = true, CS_PATH = true, ACK_CONDITIONAL = true, ISSUE_FENCE = true).*
}

// 같은 추천안: 주문 1건 결제 시도 2번(결제창을 닫고 다시 시도, 전환 사이에 두 결제사에서 인증)
module payment_proposed_attempts {
  import payment(ORDERS = Set(1), MAX_ATTEMPTS = 2, MAX_SWITCHES = 1, MAX_TIMEOUTS = 1, MAX_RESTARTS = 1, MAX_WEBHOOKS = 0, EVENT_CANCEL = true,
                 TICKET_BREAK = true, PG_PINNED = true, ONE_PAYMENT_PER_ORDER = true, NO_ASSUME = true, WEBHOOK_QUERY = true,
                 FORWARD_RECOVERY = true, ISSUE_RETRY = true, CS_PATH = true, ACK_CONDITIONAL = true, ISSUE_FENCE = true).*
}

// 정본 범위 전체(시뮬레이션만): 주문 2건 결제 시도 2번씩
module payment_proposed_full {
  import payment(ORDERS = Set(1, 2), MAX_ATTEMPTS = 2, MAX_SWITCHES = 1, MAX_TIMEOUTS = 1, MAX_RESTARTS = 1, MAX_WEBHOOKS = 0, EVENT_CANCEL = true,
                 TICKET_BREAK = true, PG_PINNED = true, ONE_PAYMENT_PER_ORDER = true, NO_ASSUME = true, WEBHOOK_QUERY = true,
                 FORWARD_RECOVERY = true, ISSUE_RETRY = true, CS_PATH = true, ACK_CONDITIONAL = true, ISSUE_FENCE = true).*
}

// 진행성(같은 추천안, 주문 1건 결제 시도 2번)
module payment_live {
  import payment(ORDERS = Set(1), MAX_ATTEMPTS = 2, MAX_SWITCHES = 1, MAX_TIMEOUTS = 1, MAX_RESTARTS = 1, MAX_WEBHOOKS = 0, EVENT_CANCEL = true,
                 TICKET_BREAK = true, PG_PINNED = true, ONE_PAYMENT_PER_ORDER = true, NO_ASSUME = true, WEBHOOK_QUERY = true,
                 FORWARD_RECOVERY = true, ISSUE_RETRY = true, CS_PATH = true, ACK_CONDITIONAL = true, ISSUE_FENCE = true).*
}

// 변형(검사가 살아 있는지, V-T1): 추천안 모듈에서 하나씩 끄면 그 약속의 반례가 나와야 한다.
// 범위는 변형마다 반례가 나오는 작은 범위로 줄였다(PR마다 도는 시뮬레이션이 반례를 찾을 수 있게. 전수 검사의 가장 짧은 반례는 같다)

// 토스로 접수한 뒤 전환이 켜지고, 승인 명령이 그때 고른 포트원으로 간다
module payment_no_pin {
  import payment(ORDERS = Set(1), MAX_ATTEMPTS = 1, MAX_SWITCHES = 1, MAX_TIMEOUTS = 0, MAX_RESTARTS = 0, MAX_WEBHOOKS = 0, EVENT_CANCEL = false,
                 TICKET_BREAK = false, PG_PINNED = false, ONE_PAYMENT_PER_ORDER = true, NO_ASSUME = true, WEBHOOK_QUERY = true,
                 FORWARD_RECOVERY = true, ISSUE_RETRY = true, CS_PATH = true, ACK_CONDITIONAL = true, ISSUE_FENCE = true).*
}

// 결제사 고정과 결제 원장의 주문당 1건을 함께 뺌(둘 중 하나만 있어도 막힌다): 두 결제사에서 인증한 사람의 주문이 전환을 켜고 끄는 사이
// 승인 명령을 두 결제사로 보내 둘 다 승인된다
module payment_double {
  import payment(ORDERS = Set(1), MAX_ATTEMPTS = 2, MAX_SWITCHES = 2, MAX_TIMEOUTS = 0, MAX_RESTARTS = 0, MAX_WEBHOOKS = 0, EVENT_CANCEL = false,
                 TICKET_BREAK = false, PG_PINNED = false, ONE_PAYMENT_PER_ORDER = false, NO_ASSUME = true, WEBHOOK_QUERY = true,
                 FORWARD_RECOVERY = true, ISSUE_RETRY = true, CS_PATH = true, ACK_CONDITIONAL = true, ISSUE_FENCE = true).*
}

// 승인 응답을 잃으면(시간 초과·재시작) 실패로 가정: 결제사는 승인했는데 주문은 과금 없이 실패로 끝난다
module payment_assume {
  import payment(ORDERS = Set(1), MAX_ATTEMPTS = 1, MAX_SWITCHES = 0, MAX_TIMEOUTS = 1, MAX_RESTARTS = 1, MAX_WEBHOOKS = 0, EVENT_CANCEL = false,
                 TICKET_BREAK = false, PG_PINNED = true, ONE_PAYMENT_PER_ORDER = true, NO_ASSUME = false, WEBHOOK_QUERY = true,
                 FORWARD_RECOVERY = true, ISSUE_RETRY = true, CS_PATH = true, ACK_CONDITIONAL = true, ISSUE_FENCE = true).*
}

// 웹훅 본문을 믿음: 서명 없는 '승인됨' 웹훅으로 결제사 승인 없이 발권한다
module payment_trust_webhook {
  import payment(ORDERS = Set(1), MAX_ATTEMPTS = 1, MAX_SWITCHES = 0, MAX_TIMEOUTS = 0, MAX_RESTARTS = 0, MAX_WEBHOOKS = 1, EVENT_CANCEL = false,
                 TICKET_BREAK = false, PG_PINNED = true, ONE_PAYMENT_PER_ORDER = true, NO_ASSUME = true, WEBHOOK_QUERY = false,
                 FORWARD_RECOVERY = true, ISSUE_RETRY = true, CS_PATH = true, ACK_CONDITIONAL = true, ISSUE_FENCE = true).*
}

// 옛 Saga 방식(ADR-0106 전): 승인 뒤 발권이 한 번 실패하면 바로 결제를 취소한다
module payment_backward {
  import payment(ORDERS = Set(1), MAX_ATTEMPTS = 1, MAX_SWITCHES = 0, MAX_TIMEOUTS = 0, MAX_RESTARTS = 0, MAX_WEBHOOKS = 0, EVENT_CANCEL = false,
                 TICKET_BREAK = false, PG_PINNED = true, ONE_PAYMENT_PER_ORDER = true, NO_ASSUME = true, WEBHOOK_QUERY = true,
                 FORWARD_RECOVERY = false, ISSUE_RETRY = true, CS_PATH = true, ACK_CONDITIONAL = true, ISSUE_FENCE = true).*
}

// 발권 재시도 큐 없음(진행성 변형): 발권이 한 번 실패하면 승인된 주문이 발권도 보상도 없이 남는다
module payment_no_issue_retry {
  import payment(ORDERS = Set(1), MAX_ATTEMPTS = 1, MAX_SWITCHES = 0, MAX_TIMEOUTS = 0, MAX_RESTARTS = 0, MAX_WEBHOOKS = 0, EVENT_CANCEL = false,
                 TICKET_BREAK = false, PG_PINNED = true, ONE_PAYMENT_PER_ORDER = true, NO_ASSUME = true, WEBHOOK_QUERY = true,
                 FORWARD_RECOVERY = true, ISSUE_RETRY = false, CS_PATH = true, ACK_CONDITIONAL = true, ISSUE_FENCE = true).*
}

// CS 확인 경로 없음(진행성 변형): ticket-svc가 끝내 발권하지 못하는 승인 주문이 보상으로 끝나지 못한다
module payment_no_cs_refund {
  import payment(ORDERS = Set(1), MAX_ATTEMPTS = 1, MAX_SWITCHES = 0, MAX_TIMEOUTS = 0, MAX_RESTARTS = 0, MAX_WEBHOOKS = 0, EVENT_CANCEL = false,
                 TICKET_BREAK = true, PG_PINNED = true, ONE_PAYMENT_PER_ORDER = true, NO_ASSUME = true, WEBHOOK_QUERY = true,
                 FORWARD_RECOVERY = true, ISSUE_RETRY = true, CS_PATH = false, ACK_CONDITIONAL = true, ISSUE_FENCE = true).*
}

// 발권 성공 답의 조건부 갱신을 뺌: 보상이 발권을 막아 티켓을 폐기한 뒤 늦게 온 성공 답이 주문을 CONFIRMED로 바꾼다(결제는 승인된 채 티켓 없음)
module payment_unconditional_ack {
  import payment(ORDERS = Set(1), MAX_ATTEMPTS = 1, MAX_SWITCHES = 0, MAX_TIMEOUTS = 0, MAX_RESTARTS = 0, MAX_WEBHOOKS = 0, EVENT_CANCEL = true,
                 TICKET_BREAK = false, PG_PINNED = true, ONE_PAYMENT_PER_ORDER = true, NO_ASSUME = true, WEBHOOK_QUERY = true,
                 FORWARD_RECOVERY = true, ISSUE_RETRY = true, CS_PATH = true, ACK_CONDITIONAL = false, ISSUE_FENCE = true).*
}
