import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createScanJobSchema } from '@skvault/shared';
import { JwtGuard } from '../auth/jwt.guard';
import { JobsService } from './jobs.service';

/** Côté web : machines (agents), et scans à lancer / suivre / annuler. */
@ApiTags('scans')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller()
export class JobsController {
  constructor(private readonly service: JobsService) {}

  @Get('hosts')
  hosts() {
    return this.service.hosts();
  }

  @Get('scan-jobs')
  list(@Query('limit') limit?: string) {
    return this.service.list(limit ? Math.min(100, Math.max(1, Number(limit))) : 20);
  }

  @Post('scan-jobs')
  create(@Body() body: unknown) {
    return this.service.enqueue(createScanJobSchema.parse(body));
  }

  @Post('scan-jobs/rescan/:volumeId')
  rescan(@Param('volumeId') volumeId: string) {
    return this.service.rescan(volumeId);
  }

  @Post('scan-jobs/:id/cancel')
  cancel(@Param('id') id: string) {
    return this.service.cancel(id);
  }
}
