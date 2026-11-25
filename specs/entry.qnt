// -*- mode: Bluespec; -*-
// 입장·양도 규칙 모델 검사(BUILD_ORDER GAT-060, docs/verification.md §2.1 `entry` 행, F-05-11 계획 §3-9).
// 근거: ADR-0051, docs/features/offline-gate.md §5(입장 중 소유권 동결)·§6(스캔 판정)·§7.3(입장 기록 마감),
//       docs/features/transfer-refund.md §3.1(허용 조건·동결 끝)·§4(양도 흐름).
// 이 파일은 정본이 아니다. 정본을 읽고 정본이 정한 것만 작은 모델로 옮긴 것이다.
//
// 모형으로 줄인 것
// - 티켓 2장, 계정 2명, 회차 2개(재입장 허용/불허), 스캐너는 방향(IN/OUT)만 본다.
// - 시간은 '입장 시작(startEntry)'과 '입장 기록 마감(closeEntry)' 두 사건으로만 둔다. 기한(48시간·양도 마감)은
//   이미 서버 시험이 보고, 여기서는 동결 구간의 소유권 이전과 스캔 중복만 본다.
// - 표 상태는 ACTIVE·TRANSFER_PENDING·REFUNDED 셋이다. 키 폐기는 보유자 변경과 같은 걸음으로 본다(따로 두지 않는다).
// - 늦게 올라온 스캔은 마감 뒤에도 받을 수 있으므로 스캔 걸음은 마감 뒤에도 열어 둔다(소유권 이동은 닫는다).
module entry {
  // ---- 범위(검사 모듈이 정한다) ----
  const ACCOUNTS: Set[int]
  const TICKETS: Set[int]
  const EVENTS: Set[int]
  const REENTRY: int -> bool   // 회차별 재입장 허용
  // ---- 설계 장치(하나씩 끄면 반례가 나오는지 본다, V-T1) ----
  const FREEZE: bool           // 입장 시작~마감에 수락·돌려주기를 막는다(ADR-0051 결정 10)
  const FLAG_DUP: bool         // 재입장 불허 회차의 두 번째 IN을 이상 표시한다(offline-gate §6.4)

  type Ticket = { holder: int, payer: int, event: int, status: str, offer: str, lastIn: bool, moved: bool }

  var tickets: int -> Ticket
  var seenIn: int -> bool         // 티켓에 PASS IN이 한 번이라도 있었나
  var secondIn: int -> bool       // 두 번째 PASS IN이 있었나
  var flagged: int -> bool        // 티켓별 중복 입장 표시
  var frozen: int -> bool         // 회차별 입장 시작
  var closed: int -> bool         // 회차별 입장 기록 마감

  action init = all {
    tickets' = TICKETS.mapBy(t => { holder: 1 + (t % 2), payer: 1 + (t % 2), event: 1 + (t % 2), status: "ACTIVE", offer: "NONE", lastIn: false, moved: false }),
    seenIn' = TICKETS.mapBy(_ => false),
    secondIn' = TICKETS.mapBy(_ => false),
    flagged' = TICKETS.mapBy(_ => false),
    frozen' = EVENTS.mapBy(_ => false),
    closed' = EVENTS.mapBy(_ => false),
  }

  def eventOf(t: int): int = tickets.get(t).event
  def isFrozen(t: int): bool = frozen.get(tickets.get(t).event) and not(closed.get(tickets.get(t).event))
  def update(t: int, f: Ticket => Ticket): int -> Ticket = tickets.set(t, f(tickets.get(t)))

  // 양도 요청: 보유자 = 결제자(재양도 금지), 진행 중 요청 없음. 동결과 무관하게 요청은 만들 수 있다(수락이 막힌다).
  action offer(t: int): bool = all {
    tickets.get(t).holder == tickets.get(t).payer,
    tickets.get(t).status == "ACTIVE",
    tickets.get(t).offer == "NONE",
    tickets' = update(t, x => x.with("offer", "OFFERED").with("status", "TRANSFER_PENDING")),
    seenIn' = seenIn, secondIn' = secondIn, flagged' = flagged, frozen' = frozen, closed' = closed,
  }

  // 수락: 동결 전에만. 받는 사람은 다른 계정이다.
  action accept(t: int, rcpt: int): bool = all {
    not(rcpt == tickets.get(t).holder),
    tickets.get(t).offer == "OFFERED",
    tickets.get(t).status == "TRANSFER_PENDING",
    not(isFrozen(t)) or not(FREEZE),
    tickets' = update(t, x => { holder: rcpt, payer: x.payer, event: x.event, status: "ACTIVE", offer: "ACCEPTED", lastIn: x.lastIn, moved: x.moved or isFrozen(t) }),
    seenIn' = seenIn, secondIn' = secondIn, flagged' = flagged, frozen' = frozen, closed' = closed,
  }

  action reject(t: int): bool = all {
    tickets.get(t).offer == "OFFERED",
    tickets' = update(t, x => x.with("offer", "REJECTED").with("status", "ACTIVE")),
    seenIn' = seenIn, secondIn' = secondIn, flagged' = flagged, frozen' = frozen, closed' = closed,
  }

  action withdraw(t: int): bool = all {
    tickets.get(t).offer == "OFFERED",
    tickets' = update(t, x => x.with("offer", "WITHDRAWN").with("status", "ACTIVE")),
    seenIn' = seenIn, secondIn' = secondIn, flagged' = flagged, frozen' = frozen, closed' = closed,
  }

  // 돌려주기: 받은 보유자 → 결제자. 동결 중에는 막고, 마감 뒤에는 허용한다(동결의 끝).
  action returnTicket(t: int): bool = all {
    not(tickets.get(t).holder == tickets.get(t).payer),
    tickets.get(t).status == "ACTIVE",
    not(isFrozen(t)) or closed.get(tickets.get(t).event) or not(FREEZE),
    tickets' = update(t, x => { holder: x.payer, payer: x.payer, event: x.event, status: "ACTIVE", offer: "NONE", lastIn: x.lastIn, moved: x.moved or isFrozen(t) }),
    seenIn' = seenIn, secondIn' = secondIn, flagged' = flagged, frozen' = frozen, closed' = closed,
  }

  // 회차 취소·환급으로 끝난 표. 끝난 표는 받을 수 없다(수락의 상태 조건이 막는다).
  action refund(t: int): bool = all {
    tickets.get(t).status != "REFUNDED",
    tickets' = update(t, x => x.with("status", "REFUNDED").with("offer", "NONE")),
    seenIn' = seenIn, secondIn' = secondIn, flagged' = flagged, frozen' = frozen, closed' = closed,
  }

  action startEntry(e: int): bool = all {
    not(frozen.get(e)),
    frozen' = frozen.set(e, true), closed' = closed,
    tickets' = tickets, seenIn' = seenIn, secondIn' = secondIn, flagged' = flagged,
  }

  action closeEntry(e: int): bool = all {
    frozen.get(e),
    not(closed.get(e)),
    closed' = closed.set(e, true), frozen' = frozen,
    tickets' = tickets, seenIn' = seenIn, secondIn' = secondIn, flagged' = flagged,
  }

  // 스캔: 입장이 시작된 뒤에만. 재입장 불허 회차의 두 번째 IN(OUT 뒤 포함)은 이상 표시한다.
  action scanIn(t: int): bool = all {
    frozen.get(tickets.get(t).event),
    tickets.get(t).status == "ACTIVE",
    tickets' = update(t, x => x.with("lastIn", true)),
    seenIn' = seenIn.set(t, true),
    secondIn' = secondIn.set(t, secondIn.get(t) or seenIn.get(t)),
    flagged' = flagged.set(t, flagged.get(t) or (FLAG_DUP and seenIn.get(t) and not(REENTRY.get(tickets.get(t).event)))),
    frozen' = frozen, closed' = closed,
  }

  action scanOut(t: int): bool = all {
    frozen.get(tickets.get(t).event),
    tickets.get(t).lastIn,
    tickets' = update(t, x => x.with("lastIn", false)),
    seenIn' = seenIn, secondIn' = secondIn, flagged' = flagged, frozen' = frozen, closed' = closed,
  }

  // 한 걸음: 검사기는 이 동작으로 모든 순서를 만든다
  action step = any {
    nondet t = TICKETS.oneOf()
    nondet r = ACCOUNTS.oneOf()
    nondet e = EVENTS.oneOf()
    any {
      offer(t), accept(t, r), reject(t), withdraw(t), returnTicket(t), refund(t),
      startEntry(e), closeEntry(e), scanIn(t), scanOut(t),
    }
  }

  // ---- 불변식 ----
  // ① 입장 시작부터 마감까지 소유권 이전 0
  val inv_noFrozenTransfer = TICKETS.forall(t => not(tickets.get(t).moved))
  // ② 재입장 불허 회차의 두 번째 IN은 반드시 이상 표시가 붙는다
  val inv_secondInFlagged = TICKETS.forall(t => not(secondIn.get(t)) or REENTRY.get(tickets.get(t).event) or flagged.get(t))
}

// ---- 검사 모듈(specs/specs.json이 고른다) ----
// 지켜짐: 티켓 2장·계정 2명·회차 2개(1=재입장 허용, 2=불허)
module entry_full {
  import entry(ACCOUNTS = Set(1, 2), TICKETS = Set(1, 2), EVENTS = Set(1, 2),
               REENTRY = Map(1 -> true, 2 -> false), FREEZE = true, FLAG_DUP = true).*
}

// 지켜짐(전수): 티켓 1장·계정 2명·회차 1개(재입장 불허). 상태를 줄여 TLC가 끝까지 돈다
module entry_hold {
  import entry(ACCOUNTS = Set(1, 2), TICKETS = Set(1), EVENTS = Set(2),
               REENTRY = Map(2 -> false), FREEZE = true, FLAG_DUP = true).*
}

// 반례(V-T1): 동결을 끄면 입장 시작 뒤에 수락·돌려주기가 되어 ①이 깨진다
module entry_no_freeze {
  import entry(ACCOUNTS = Set(1, 2), TICKETS = Set(1), EVENTS = Set(2),
               REENTRY = Map(2 -> false), FREEZE = false, FLAG_DUP = true).*
}

// 반례(V-T1): 중복 표시를 끄면 재입장 불허 회차의 두 번째 IN이 표시 없이 통과해 ②가 깨진다
module entry_no_flag {
  import entry(ACCOUNTS = Set(1, 2), TICKETS = Set(1), EVENTS = Set(2),
               REENTRY = Map(2 -> false), FREEZE = true, FLAG_DUP = false).*
}
