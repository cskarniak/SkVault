import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { pushFilesSchema, pushHashesSchema, pushProjectsSchema, startScanSchema } from '@skvault/shared';
import { AgentGuard } from './agent.guard';
import { IngestService } from './ingest.service';

/** Protocole d'un scan : start → files (par lots) → pending-hashes ⇄ hashes → finish. */
@ApiExcludeController()
@Controller('ingest/scans')
@UseGuards(AgentGuard)
export class IngestController {
  constructor(private readonly service: IngestService) {}

  @Post()
  start(@Body() body: unknown) {
    return this.service.start(startScanSchema.parse(body));
  }

  @Post(':id/files')
  files(@Param('id') id: string, @Body() body: unknown) {
    return this.service.pushFiles(id, pushFilesSchema.parse(body).files);
  }

  @Post(':id/projects')
  projects(@Param('id') id: string, @Body() body: unknown) {
    return this.service.pushProjects(id, pushProjectsSchema.parse(body).projects);
  }

  @Get(':id/pending-hashes')
  pending(@Param('id') id: string) {
    return this.service.pendingHashes(id);
  }

  @Post(':id/hashes')
  hashes(@Param('id') id: string, @Body() body: unknown) {
    return this.service.pushHashes(id, pushHashesSchema.parse(body).hashes);
  }

  @Post(':id/finish')
  finish(@Param('id') id: string) {
    return this.service.finish(id);
  }
}
