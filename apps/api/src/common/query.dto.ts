import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ResponseFormat } from './enums';

const toBoolean = ({ obj, key }: { obj: Record<string, unknown>; key: string }): boolean =>
  obj[key] === 'true' || obj[key] === '1' || obj[key] === true;

/** Shared list query parameters: time window, paging, sort, format. */
export class CommonQueryDto {
  @ApiPropertyOptional({ description: 'Inclusive start time (ISO-8601).', example: '2024-01-01T00:00:00Z' })
  @IsOptional()
  @IsDateString()
  start?: string;

  @ApiPropertyOptional({ description: 'Inclusive end time (ISO-8601).', example: '2024-12-31T23:59:59Z' })
  @IsOptional()
  @IsDateString()
  end?: string;

  @ApiPropertyOptional({ description: 'Max rows to return (1–1000).', default: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit = 200;

  @ApiPropertyOptional({ description: 'Sort newest-first when true.', default: false })
  @IsOptional()
  @IsBoolean()
  @Transform(toBoolean)
  descending = false;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor returned as `marker` in the previous response.' })
  @IsOptional()
  @IsString()
  marker?: string;

  @ApiPropertyOptional({ enum: ResponseFormat, default: ResponseFormat.JSON })
  @IsOptional()
  @IsEnum(ResponseFormat)
  format: ResponseFormat = ResponseFormat.JSON;
}
