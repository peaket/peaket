// F-10-2 악성 코드 검사 태그 해석(계획 docs/review/plans/F-10-2.md §3, ASVS v5.0.0-5.4.3·16.5.3, D-T35 ④).
// 운영 GuardDuty S3 악성코드 보호와 모의 검사기가 같은 태그를 붙인다. NO_THREATS_FOUND만 clean이다.
export const SCAN_TAG_KEY = 'GuardDutyMalwareScanStatus';

export type ScanVerdict = 'CLEAN' | 'THREATS_FOUND' | 'PENDING';

export function scanVerdict(tags: Record<string, string>): ScanVerdict {
  const value = tags[SCAN_TAG_KEY];
  if (value === 'NO_THREATS_FOUND') return 'CLEAN';
  if (value === 'THREATS_FOUND') return 'THREATS_FOUND';
  return 'PENDING';
}
