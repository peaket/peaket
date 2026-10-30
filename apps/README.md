# apps/

화면 앱이 들어갈 자리다. 팬 웹(`web`), 파트너 콘솔(`partner`), 현장 스캐너(`scanner`), 관제 콘솔 호스트(`console-host`), 포렌식 리플레이 데모(`forensics`)와 관제 원격 위젯(`widgets/queue`, `widgets/purchase`)을 둔다.

- 무엇을 어느 팀이 맡는지: [docs/architecture.md](../docs/architecture.md) §10, 앱 구조: [docs/frontend.md](../docs/frontend.md) §2
- 지금 있는 것(2026-10-31, ADR-0170): 앱 여섯과 위젯 둘의 골격, 디자인 캔버스를 옮긴 69개 화면(목업 데이터). 데이터 연결은 각 화면의 wbs 단계에서 한다.

## 띄워 보기

뿌리에서 `pnpm install` 뒤 앱 하나씩 띄운다. 앱마다 `/preview`에 화면·상태 목록이 있다(개발 서버에서만). 상태는 주소의 `?state=`(디자인 캔버스 보드의 상태 이름), 다크는 `?theme=dark`, 콘솔 역할은 `?role=`로 고른다.

| 앱 | 명령 | 주소 |
| --- | --- | --- |
| 소비자 웹 | `pnpm --filter @peaket/web dev` | http://localhost:3000/preview |
| 파트너 콘솔 | `pnpm --filter @peaket/partner dev` | http://localhost:3001/preview |
| 관제 콘솔 | `pnpm --filter @peaket/console-host dev` | http://localhost:3002/preview |
| 스캐너 | `pnpm --filter @peaket/scanner dev` | http://localhost:3003/preview |
| 대기실 경량 페이지 | `pnpm --filter @peaket/queue-room dev` | http://localhost:3004/preview |
| 포렌식 데모 | `pnpm --filter @peaket/forensics dev` | http://localhost:3005/ |
