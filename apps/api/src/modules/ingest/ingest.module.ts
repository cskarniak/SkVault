import { Module } from '@nestjs/common';
import { AgentGuard } from './agent.guard';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';

@Module({ controllers: [IngestController], providers: [IngestService, AgentGuard] })
export class IngestModule {}
