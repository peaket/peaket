-- F-05-7 GAT-230: 스캐너 세션에 기기 원장 이름을 둔다(docs/data.md scanner_session.device_name, ADR-0362 결정 6).
-- 기기 승인이 세션을 만들 때 기기 승인 요청의 기기 이름(예 동문-03)을 복사한다. 휴대폰의 스캐너 세션 줄(SCR-017)과 내 배정(SCR-061)이 읽는다.
-- 옛 행은 채우지 않는다(NULL, 화면은 '현장 스캐너'로 보인다). 장비 이름이라 개인정보가 아니고 세션 행과 같이 보존한다.
ALTER TABLE "scanner_session" ADD COLUMN IF NOT EXISTS "device_name" text;
