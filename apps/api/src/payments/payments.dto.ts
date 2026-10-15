import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { CommonQueryDto } from '../common/query.dto';

export class PaymentsQueryDto extends CommonQueryDto {
  @ApiPropertyOptional({ description: 'Filter by currency code (e.g. XRP, USD).' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ description: 'Filter by issuer address (for IOU currencies).' })
  @IsOptional()
  @IsString()
  issuer?: string;
}
