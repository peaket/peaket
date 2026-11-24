// GAT-360 파트너 SCR-037 실제 명단·초대 값 해석. identity-svc 계약(StaffAssignment)만 읽고
// 이메일·계정 ID는 화면 값에 남기지 않는다(openapi StaffAssignment 설명, docs/security/data-classification.md).
export type StaffRole = 'gate_staff' | 'gate_lead';

export interface StaffRow {
  id: string;
  nickname: string | null;
  role: string;
  status: string;
  validity: string;
  canResend: boolean;
  canRevoke: boolean;
}

const ROLE: Record<string, string> = { gate_staff: '현장 스태프', gate_lead: '현장 책임자' };
const STATUS: Record<string, string> = { INVITED: '초대 중', ASSIGNED: '수락', REVOKED: '해제', ENDED: '종료', EXPIRED: '만료' };

const KST = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const kst = (iso: unknown): string | null => (typeof iso === 'string' && Number.isFinite(Date.parse(iso)) ? KST.format(new Date(iso)) : null);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function staffRowsOf(raw: unknown): StaffRow[] {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return [];
  const rows: StaffRow[] = [];
  for (const item of raw.items) {
    if (!isRecord(item) || typeof item.assignmentId !== 'string') continue;
    const status = typeof item.status === 'string' ? item.status : '';
    const from = kst(item.validFrom);
    const until = kst(item.validUntil);
    rows.push({
      id: item.assignmentId,
      nickname: typeof item.nickname === 'string' && item.nickname.trim() !== '' ? item.nickname : null,
      role: ROLE[String(item.role)] ?? '현장 스태프',
      status: STATUS[status] ?? status,
      validity: from && until ? `${from} ~ ${until} KST` : '',
      canResend: status === 'INVITED',
      canRevoke: status === 'INVITED' || status === 'ASSIGNED',
    });
  }
  return rows;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 초대 입력(줄 단위 이메일) → 요청 본문과 행 오류. 같은 이메일은 대소문자 무시하고 한 번만 */
export function invitationInputOf(text: string, role: StaffRole = 'gate_staff'): {
  invitations: { email: string; role: StaffRole }[];
  errors: { line: number; input: string; reason: string }[];
} {
  const rows = text.split(/\r?\n/).map((v) => v.trim());
  if (rows.every((r) => r === '')) return { invitations: [], errors: [{ line: 0, input: '', reason: '초대할 이메일을 한 개 이상 적어 주세요' }] };
  const seen = new Set<string>();
  const invitations: { email: string; role: StaffRole }[] = [];
  const errors: { line: number; input: string; reason: string }[] = [];
  rows.forEach((input, i) => {
    if (input === '') return;
    const line = i + 1;
    if (!EMAIL.test(input)) return errors.push({ line, input, reason: '이메일 형식이 아닙니다' });
    const key = input.toLowerCase();
    if (seen.has(key)) return errors.push({ line, input, reason: '같은 이메일이 이미 있습니다' });
    seen.add(key);
    invitations.push({ email: input, role });
  });
  if (invitations.length > 200) return { invitations: [], errors: [{ line: 0, input: '', reason: '한 번에 200명까지 초대할 수 있습니다' }] };
  return { invitations, errors };
}
