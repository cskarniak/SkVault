import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { agentIdentitySchema, jobFinishSchema, jobProgressSchema } from '@skvault/shared';
import { AgentGuard } from '../ingest/agent.guard';
import { JobsService } from './jobs.service';

/** Appelé par le démon de l'agent : hello au démarrage, heartbeat, poll d'un job, progression, fin. */
@ApiExcludeController()
@Controller('ingest/agent')
@UseGuards(AgentGuard)
export class AgentController {
  constructor(private readonly service: JobsService) {}

  @Post('hello')
  hello(@Body() body: unknown) {
    return this.service.agentHello(agentIdentitySchema.parse(body));
  }

  @Post('heartbeat')
  heartbeat(@Body() body: unknown) {
    return this.service.agentHeartbeat(agentIdentitySchema.parse(body));
  }

  @Post('poll')
  poll(@Body() body: unknown) {
    return this.service.agentPoll(agentIdentitySchema.parse(body));
  }

  @Post('jobs/:id/progress')
  progress(@Param('id') id: string, @Body() body: unknown) {
    return this.service.agentProgress(id, jobProgressSchema.parse(body));
  }

  @Post('jobs/:id/finish')
  finish(@Param('id') id: string, @Body() body: unknown) {
    return this.service.agentFinish(id, jobFinishSchema.parse(body));
  }
}
