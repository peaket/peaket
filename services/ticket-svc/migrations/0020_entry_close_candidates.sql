-- F-05-6 정리 IR-03: 입장 기록 마감 후보 고르기가 매분 ticket 표 전체(100만 장 규모)를
-- group by + not exists로 훑지 않게 한다. 후보는 회차마다 한 행인 작은 목록(ticket_event_start)에서
-- (starts_at, event_id) 차례로 읽고, entry_close 기본 키와 ticket (event_id)로 거른다(docs/data.md §5.1).
--
-- - ticket_event_idx: 후보 질의의 exists(ticket) 확인과 F-05-4 스캐너 패키지 질의(ticket.event_id)가 쓴다.
-- - ticket_event_start: 회차마다 가장 이른 ticket.event_starts_at 하나. ticket INSERT와
--   event_starts_at 고침 트리거가 같은 트랜잭션에서 유지한다. 티켓 행 삭제는 이 요약을 지우지 않지만,
--   후보 질의가 event_starts_at이 있는 티켓 행을 exists로 확인하므로 죽은 회차는 후보에 들지 않는다.
--   보존 삭제는 마감이 오래 지난 회차만 지우므로 마감 행이 먼저 있다.
-- 운영 전(행이 100만 장 규모로 자라기 전)이라 색인과 채우기를 트랜잭션 안에서 한 번에 한다.
-- 이미 배포된 뒤에 같은 색인을 더할 때는 마이그레이션 러너의 트랜잭션 밖에서 CONCURRENTLY 파일로 따로 만든다.
CREATE INDEX IF NOT EXISTS ticket_event_idx ON ticket (event_id);

CREATE TABLE IF NOT EXISTS ticket_event_start (
  event_id uuid PRIMARY KEY,
  starts_at timestamptz NOT NULL
);

-- 후보 고르기의 (시작, 회차 ID) 차례. 회차 수만큼(수천~수만 행)이라 작다.
CREATE INDEX IF NOT EXISTS ticket_event_start_order_idx ON ticket_event_start (starts_at, event_id);

-- 기존 티켓에서 채운다(배포 때 한 번). 새 발권은 아래 트리거가 잇는다.
INSERT INTO ticket_event_start (event_id, starts_at)
SELECT event_id, min(event_starts_at)
FROM ticket
WHERE event_starts_at IS NOT NULL
GROUP BY event_id
ON CONFLICT (event_id) DO NOTHING;

-- 발권 INSERT: 그 회차의 가장 이른 시작만 남긴다. 같은 값이면 행을 고치지 않는다.
-- event_starts_at 고침: 그 회차 티켓의 최솟값을 다시 센다(뒤로 미루는 고침도 반영).
--   값이 모두 비면 요약 행을 지운다. 티켓 삭제(NEW 없음)는 다루지 않는다(위 주석).
CREATE OR REPLACE FUNCTION ticket_event_start_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- 빈 시작에서 채우는 고침도 목록 행을 만든다. 있는 행은 최솟값이 달라질 때만 고친다.
    INSERT INTO ticket_event_start (event_id, starts_at)
    SELECT NEW.event_id, m.starts_at
      FROM (
        SELECT min(t.event_starts_at) AS starts_at
        FROM ticket t
        WHERE t.event_id = NEW.event_id AND t.event_starts_at IS NOT NULL
      ) m
     WHERE m.starts_at IS NOT NULL
    ON CONFLICT (event_id) DO UPDATE
      SET starts_at = EXCLUDED.starts_at
      WHERE ticket_event_start.starts_at IS DISTINCT FROM EXCLUDED.starts_at;
    DELETE FROM ticket_event_start s
     WHERE s.event_id = NEW.event_id
       AND NOT EXISTS (
         SELECT 1 FROM ticket t
         WHERE t.event_id = NEW.event_id AND t.event_starts_at IS NOT NULL
       );
    RETURN NEW;
  END IF;
  IF NEW.event_starts_at IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO ticket_event_start (event_id, starts_at)
  VALUES (NEW.event_id, NEW.event_starts_at)
  ON CONFLICT (event_id) DO UPDATE
    SET starts_at = EXCLUDED.starts_at
    WHERE ticket_event_start.starts_at > EXCLUDED.starts_at;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ticket_event_start_sync ON ticket;
CREATE TRIGGER ticket_event_start_sync
AFTER INSERT OR UPDATE OF event_starts_at ON ticket
FOR EACH ROW EXECUTE FUNCTION ticket_event_start_sync();
