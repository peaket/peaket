// 운영 명령과 승인(목업). 명령 번호와 이름은 d5 §7.3·control-tower의 이름이다.
export type CommandState =
  | 'disabled'
  | 'pending-approval'
  | 'rejected'
  | 'propagating'
  | 'acked'
  | 'failed'
  | 'revert-pending'
  | 'reverted'
  | 'auto-expired';

export interface CommandDef {
  no: number;
  name: string;
  /** 1인 또는 2인 승인 */
  approval: 1 | 2;
}

export const COMMANDS: readonly CommandDef[] = [
  { no: 1, name: '동시 입장 목표', approval: 1 },
  { no: 2, name: '입장 일시정지', approval: 1 },
  { no: 3, name: '판매 일시정지', approval: 1 },
  { no: 4, name: '대역 차단', approval: 2 },
  { no: 5, name: '추가 검증 강화', approval: 1 },
  { no: 6, name: 'Degraded 전환·결제사 전환', approval: 2 },
  { no: 7, name: '공지', approval: 1 },
  { no: 11, name: '자동화 정지 스위치', approval: 1 },
  { no: 12, name: '대체 결제사 지정', approval: 2 },
];

/** 위 상태 바 '내 승인 대기'가 가리키는 곳(두 번째 승인자 화면, SCR-030) */
export const MY_APPROVALS_HREF = '/commands';
