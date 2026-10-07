import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { AgentGuard } from './agent.guard';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';

@Module({ imports: [CatalogModule], controllers: [IngestController], providers: [IngestService, AgentGuard] })
export class IngestModule {}
