import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AgentGuard } from '../ingest/agent.guard';
import { AgentController } from './agent.controller';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({
  imports: [AuthModule],
  controllers: [JobsController, AgentController],
  providers: [JobsService, AgentGuard],
})
export class JobsModule {}
