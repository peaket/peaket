// ops-svc 파트너 풀의 DB 역할 시작 검사(W9-fix3 F1, docs/security/authz-matrix.md §5.3 'ops-svc 구현' 끝 '시작 검사').
// 시험 담당이 컴파일에 필요한 빈 뼈대만 두었다(동작 없음). 구현 담당이 채운다.
import type { Database } from '@peaket/platform';

/** 파트너 풀의 접속 사용자가 ops_partner이고 ops_app을 겸하지 않으며 특권·표 소유자가 아닌지 본다. 어긋나면 던진다 */
export async function assertOpsPartnerRole(_database: Database): Promise<void> {}
