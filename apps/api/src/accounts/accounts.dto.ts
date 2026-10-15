import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString } from 'class-validator';
import { CommonQueryDto } from '../common/query.dto';

export class AccountPaymentsQueryDto extends CommonQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() currency?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() issuer?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() source_tag?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() destination_tag?: number;

  @ApiPropertyOptional({ description: "'sent' | 'received' | 'both'", default: 'both' })
  @IsOptional()
  @IsString()
  type?: 'sent' | 'received' | 'both';
}

export class AccountTransactionsQueryDto extends CommonQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() type?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() result?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() min_ledger?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() max_ledger?: number;
}

export class AccountBalanceChangesQueryDto extends CommonQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() currency?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() counterparty?: string;
}

export class AccountBalancesQueryDto {
  @ApiPropertyOptional({ description: 'Ledger index or hash (default: validated/current).' })
  @IsOptional()
  @IsString()
  ledger?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() currency?: string;
}

export class AccountOrdersQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() ledger?: string;
  @ApiPropertyOptional({ default: 200 }) @IsOptional() @Type(() => Number) @IsInt() limit = 200;
}

export class AccountReportsQueryDto {
  @ApiPropertyOptional({ description: 'Start (ISO).' }) @IsOptional() @IsString() start?: string;
  @ApiPropertyOptional({ description: 'End (ISO).' }) @IsOptional() @IsString() end?: string;
}
