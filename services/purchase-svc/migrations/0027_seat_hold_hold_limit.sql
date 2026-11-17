-- 1인 한도 되살리기(W9-fix2, BAT-051 정리 HOT-252, docs/features/seat-hold.md §6 '1인 한도 되살리기', docs/data.md seat_hold.hold_limit).
-- seat_hold.hold_limit: 홀드 때 쓴 1인 한도(SeatEvent HELD의 holdLimit = 홀드 Hash lim, 팬 홀드만, 1 이상). 홀드 원장 적재가 쓰고 전체 유실 뒤 다시 만들기가 lim으로 되살린다.
-- 빈 값 허용이고 옛 행은 채우지 않는다(운영 데이터가 없고, 빈 값이면 판매 예약이 지금처럼 회차 설정 한도를 쓴다).
-- 파티션 부모에 더하므로 있는 월 파티션에 퍼지고, ensureMonthlyPartitions가 새로 만드는 파티션은 LIKE … INCLUDING CONSTRAINTS로 칸과 CHECK를 옮긴다.
ALTER TABLE "seat_hold" ADD COLUMN "hold_limit" integer;--> statement-breakpoint
ALTER TABLE "seat_hold" ADD CONSTRAINT "seat_hold_hold_limit_check" CHECK ("seat_hold"."hold_limit" is null or "seat_hold"."hold_limit" >= 1);