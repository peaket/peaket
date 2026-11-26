// F-04-14 운영 조립의 닫힌 대역(아직 실제 원천이 없는 포트).
// 실제 FR-034 자료 요청·제출 파일·좌석 이름 원천·보상 CS 건은 뒤 기능이 붙인다(docs/lanes/lane6-cleanup.md).
import type {
  EvidenceDataRequests,
  EvidenceInventory,
  EvidenceSubmissionBuilder,
  FraudCompensationCases,
  FraudEventInfo,
  FraudInquiryReports,
  FraudSeatDirectory,
  MalwareScanner,
} from '../domain/ports.js';
import { problem } from '../domain/investigation.js';

const unavailable = (name: string): never => {
  throw problem('dependency-unavailable', 503, `${name} 경로가 아직 조립되지 않았습니다`);
};

export class UnavailableEvidenceInventory implements EvidenceInventory {
  async read(): Promise<never> {
    return unavailable('조사 원천');
  }
}

export class UnavailableEvidenceDataRequests implements EvidenceDataRequests {
  async approvedScope(): Promise<never> {
    return unavailable('기관 자료 요청');
  }
  async attachSubmission(): Promise<never> {
    return unavailable('기관 자료 요청 제출');
  }
}

export class UnavailableEvidenceSubmissionBuilder implements EvidenceSubmissionBuilder {
  async build(): Promise<never> {
    return unavailable('제출 파일 만들기');
  }
}

/** 회차 이름·시각 원천이 아직 없다. 증거 묶음 만들기·열람은 되고 내보내기만 503이다. */
export class UnavailableFraudEventInfo implements FraudEventInfo {
  async get(): Promise<null> {
    return null;
  }
}

export class UnavailableFraudSeats implements FraudSeatDirectory {
  async match(): Promise<readonly { ticketId: string; accountId: string; seatLabel: string }[]> {
    return [];
  }
}

export class UnavailableFraudInquiries implements FraudInquiryReports {
  async publicPost(): Promise<null> {
    return null;
  }
}

export class UnavailableFraudCompensation implements FraudCompensationCases {
  async open(): Promise<never> {
    return unavailable('이의 보상 CS 처리함');
  }
}

/** 악성 코드 검사 엔진이 붙기 전의 닫힌 대역. 검사 결과를 CLEAN으로 적지 않고 PENDING으로 남긴다. */
export class PendingMalwareScanner implements MalwareScanner {
  async scan(): Promise<'PENDING'> {
    return 'PENDING';
  }
}
