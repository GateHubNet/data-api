import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { CommonQueryDto } from '../common/query.dto';

const toBoolean = ({ obj, key }: { obj: Record<string, unknown>; key: string }): boolean =>
  obj[key] === 'true' || obj[key] === '1' || obj[key] === true;

export class TransactionsQueryDto extends CommonQueryDto {
  @ApiPropertyOptional({ description: 'XRPL transaction type, e.g. Payment, OfferCreate.' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ description: 'Transaction engine result, e.g. tesSUCCESS.' })
  @IsOptional()
  @IsString()
  result?: string;
}

export class TransactionHashQueryDto {
  @ApiPropertyOptional({ description: 'Return binary (hex) tx/meta instead of JSON.', default: false })
  @IsOptional()
  @IsBoolean()
  @Transform(toBoolean)
  binary = false;
}
