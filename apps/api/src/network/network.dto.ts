import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsInt, IsOptional, IsString } from 'class-validator';

export class VolumeQueryDto {
  @ApiPropertyOptional({ description: 'Currency to measure volume for (default XRP).' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ description: 'Issuer address (required for non-XRP currencies).' })
  @IsOptional()
  @IsString()
  issuer?: string;

  @ApiPropertyOptional({ description: 'Inclusive start time (ISO-8601).' })
  @IsOptional()
  @IsDateString()
  start?: string;

  @ApiPropertyOptional({ description: 'Inclusive end time (ISO-8601).' })
  @IsOptional()
  @IsDateString()
  end?: string;
}

export class TopCurrenciesQueryDto {
  @ApiPropertyOptional({ description: 'Sort by trustline count descending when true.', default: true })
  @IsOptional()
  @IsBoolean()
  @Transform(({ obj, key }) => obj[key] === 'true' || obj[key] === '1' || obj[key] === true)
  descending = true;

  @ApiPropertyOptional({ description: 'Max rows.', default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit = 100;
}
