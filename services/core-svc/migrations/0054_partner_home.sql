-- F-07-12(HOT-260): 파트너 공연 개요의 판. 읽기만 하고 고치기(If-Match)는 F-07-3 몫이다.
ALTER TABLE "production" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "production" ADD CONSTRAINT "production_version_check" CHECK ("production"."version" >= 1);
