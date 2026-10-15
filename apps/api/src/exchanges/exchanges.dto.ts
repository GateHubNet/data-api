import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNumberString, IsOptional, IsString } from 'class-validator';
import { Interval } from '../common/enums';
import { CommonQueryDto } from '../common/query.dto';

export class ExchangesQueryDto extends CommonQueryDto {
  @ApiPropertyOptional({ enum: Interval, description: 'Candle interval; omit for raw trades.' })
  @IsOptional()
  @IsEnum(Interval)
  interval?: Interval;
}

export class ExchangeRatesQueryDto {
  @ApiPropertyOptional({ description: 'Compute a VWAP from this ISO time.' })
  @IsOptional()
  @IsString()
  start?: string;

  @ApiPropertyOptional({ description: 'Compute a VWAP up to this ISO time.' })
  @IsOptional()
  @IsString()
  end?: string;
}

export class NormalizeQueryDto {
  @ApiPropertyOptional({ description: 'Amount to convert.', example: '100' })
  @IsOptional()
  @IsNumberString()
  amount?: string;

  @ApiPropertyOptional({ description: 'Source currency (CURRENCY or CURRENCY+ISSUER).', example: 'USD+rXXXX' })
  @IsOptional()
  @IsString()
  base?: string;

  @ApiPropertyOptional({ description: 'Target currency (CURRENCY or CURRENCY+ISSUER).', example: 'XRP' })
  @IsOptional()
  @IsString()
  counter?: string;

  @ApiPropertyOptional({ description: 'Rate as of this ISO time (default: latest).' })
  @IsOptional()
  @IsString()
  date?: string;
}

/** Parses "CURRENCY" or "CURRENCY+ISSUER" / "CURRENCY.ISSUER" into parts. */
export function parseAsset(raw: string): { currency: string; issuer: string } {
  const [currency, issuer] = raw.split(/[+.]/);
  return { currency, issuer: issuer ?? '' };
}
