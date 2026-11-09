// 받는 층: 공연 등록 1단계의 아티스트·공연장 찾기(openapi listPartnerArtists·listPartnerPlaces, FR-022, ADR-0242). 파트너 소속 계정만 부른다.
import { Controller, Get } from '@nestjs/common';
import { ContractQuery, Roles } from '@peaket/platform';
import { z } from 'zod';
import { type DirectoryPage, PartnerDirectory } from '../application/partner-directory.js';

/** 계약의 q(1~50자)·Cursor·Limit(1~100) */
export const DirectoryQuerySchema = z
  .object({
    q: z.string().min(1).max(50),
    cursor: z.string().optional(),
    // 플랫폼이 계약대로 JSON 숫자 문법의 문자열만 숫자로 바꿔 준다('05'·'0x10'은 문자열로 남아 400이다, guidelines §1)
    limit: z.int().min(1).max(100).optional(),
  })
  .strict();

type Query = z.output<typeof DirectoryQuerySchema>;

@Controller('v1/partner')
export class PartnerDirectoryController {
  constructor(private readonly directory: PartnerDirectory) {}

  @Get('artists')
  @Roles(['partner_admin', 'partner_member'])
  listArtists(@ContractQuery(DirectoryQuerySchema) q: Query): Promise<DirectoryPage<{ artistId: string; name: string }>> {
    return this.directory.artists(q);
  }

  @Get('places')
  @Roles(['partner_admin', 'partner_member'])
  listPlaces(@ContractQuery(DirectoryQuerySchema) q: Query): Promise<DirectoryPage<{ placeId: string; name: string; address: string }>> {
    return this.directory.places(q);
  }
}
