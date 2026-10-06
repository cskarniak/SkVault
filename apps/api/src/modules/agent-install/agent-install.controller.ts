import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { createEnrollmentSchema } from '@skvault/shared';
import type { Request, Response } from 'express';
import { JwtGuard } from '../auth/jwt.guard';
import { AgentInstallService } from './agent-install.service';

@Controller()
export class AgentInstallController {
  constructor(private readonly service: AgentInstallService) {}

  /** Côté web (connecté) : génère un code d'installation valable 1 h. */
  @ApiTags('scans')
  @ApiBearerAuth()
  @UseGuards(JwtGuard)
  @Post('agent-enrollments')
  create(@Body() body: unknown) {
    return this.service.createEnrollment(createEnrollmentSchema.parse(body ?? {}).hostName);
  }

  // ── Routes publiques, protégées par le code (appelées par curl depuis la machine à installer) ──

  @ApiExcludeEndpoint()
  @Get('agent-install/:code/install.sh')
  async script(@Param('code') code: string, @Req() req: Request, @Res() res: Response) {
    res.type('text/x-shellscript').send(await this.service.renderScript(code, originOf(req)));
  }

  @ApiExcludeEndpoint()
  @Get('agent-install/:code/install.ps1')
  async scriptWindows(@Param('code') code: string, @Req() req: Request, @Res() res: Response) {
    res.type('text/plain; charset=utf-8').send(await this.service.renderScript(code, originOf(req), 'ps1'));
  }

  @ApiExcludeEndpoint()
  @Get('agent-install/:code/agent.js')
  async bundle(@Param('code') code: string, @Res() res: Response) {
    res.type('application/javascript').send(await this.service.agentBundle(code));
  }

  @ApiExcludeEndpoint()
  @Get('agent-install/:code/rootCA.pem')
  async ca(@Param('code') code: string, @Res() res: Response) {
    res.type('application/x-pem-file').send(await this.service.rootCa(code));
  }
}

/** Origine publique vue par le client (nginx transmet Host et X-Forwarded-Proto). */
function originOf(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
  return `${proto}://${host}`;
}
