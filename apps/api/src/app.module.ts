import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { IngestModule } from './modules/ingest/ingest.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { AgentInstallModule } from './modules/agent-install/agent-install.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env', '../../.env.local'] }),
    PrismaModule,
    AuthModule,
    IngestModule,
    CatalogModule,
    JobsModule,
    AgentInstallModule,
  ],
})
export class AppModule {}
