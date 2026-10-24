import { exportKeyHash } from '@gatehub/data-api-shared';
import { Body, Get, Header, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam } from '@nestjs/swagger';
// `import type`: the decorated parameters below would otherwise make Nest's metadata `require('express')`, which is
// not a dependency of this app (only its types are)
import type { Request } from 'express';
import { presentedApiKey } from '../auth/presented-key';
import { RippleController, RippleRoute } from '../common/ripple-controller';
import { ExportBody, ExportsService } from './exports.service';

/**
 * `POST /v2/exports` and `GET /v2/exports/{id}` (spec #4, ticket #15). A job belongs to the API key that asked for it:
 * the `ApiKeyGuard` attaches nothing to the request, so the key is read here again and kept as its SHA-256. Neither
 * answer may be cached: the state changes, and the download link is a new one at each request.
 */
@RippleController('v2/exports')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @RippleRoute('unable to create the export')
  @ApiOperation({
    summary: 'Ask for an export of a list',
    description:
      'Queues an export of the list at `path` (any route with a CSV form, with its parameters) in `format` (`csv`). ' +
      'A list over time must name `start` and `end`. The exporter of the network makes the file in the background; ' +
      '`GET /v2/exports/{id}` reports it.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['path', 'format'],
      properties: {
        path: { type: 'string', example: '/v2/accounts/r…/transactions?start=2024-01-01&end=2024-07-01' },
        format: { type: 'string', enum: ['csv'] },
      },
    },
  })
  async create(@Body() body: unknown, @Req() req: Request): Promise<Pick<ExportBody, 'result' | 'id' | 'status'>> {
    return this.exports.create(body, exportKeyHash(presentedApiKey(req)));
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @RippleRoute('unable to retrieve the export')
  @ApiOperation({
    summary: 'Get an export',
    description:
      'The state of an export (`queued`, `running`, `done`, `failed`) for the API key that asked for it; any other ' +
      'key gets 404. When it is done, `url` downloads the file for 15 minutes; each request makes a new one.',
  })
  @ApiParam({ name: 'id', description: 'The id `POST /v2/exports` answered.' })
  async find(@Param('id') id: string, @Req() req: Request): Promise<ExportBody> {
    return this.exports.find(id, exportKeyHash(presentedApiKey(req)));
  }
}
