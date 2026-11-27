# RB-NN: <짧은 제목>

- **서비스·영역**: <queue-svc|admission-ctrl|purchase-svc|payment-svc|ticket-svc|realtime-gw|identity-svc|trust-svc|ops-svc|core-svc|게이트웨이|관측|배포·플랫폼|보안·법정|공통·운영>
- **증상 분류**: <가용성|지연|오류·정합성|포화·용량|보안·법정|변경·배포|데이터 손상·복구|관측 공백>
- **증상**: <운영자가 보는 한 줄>
- **탐지 경로**: <경보|사람|외부|경보·사람·외부>
- **심각도**: <SEV1|SEV2|SEV3|SEV1~SEV3>
- **발동 신호**: <정본 위치와 신호> — [관측 §5](../observability.md)
- **담당**: <서비스 담당|온콜|인시던트 지휘관(IC)|운영 실행자(OL)|기록·대외 공지 담당(CL)|보안 담당|플랫폼 담당|DBA|릴리스 담당>
- **목표 시간**: <미정|미측정|정본 링크>

## 즉시 조치

1. <확인>
2. <격리·되돌리기>
3. <복구>

## 에스컬레이션

- <언제 누구에게>

## 복구 확인

- <무엇이 0 또는 정상이면 끝인지>

## 포스트모템

- 인시던트로 선언하면 [RB-17](RB-17.md)에 따라 48시간 안에 비난 없는 포스트모템을 쓴다.

## 관련 정본

- [관측가능성·SLO·알림](../observability.md)
- [런북 목차](../infra.md)
- [ADR](../adr/0078-aiops-review-demand-forecast-action-exits-correlation.md)
- [기능 문서](../features/control-tower.md)

## 연습

- 미실행. 실제 인시던트와 Game Day는 F-08-6·F-08-12·F-08-13 몫이다. '연습으로 검증됨'을 주장하지 않는다.
