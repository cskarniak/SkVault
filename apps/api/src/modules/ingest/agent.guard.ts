import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/** Authentifie les agents de scan par jeton partagé (header `x-agent-token`). */
@Injectable()
export class AgentGuard implements CanActivate {
  constructor(private config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.getOrThrow<string>('AGENT_TOKEN');
    const given = context.switchToHttp().getRequest<Request>().headers['x-agent-token'];
    const a = Buffer.from(typeof given === 'string' ? given : '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();
    return true;
  }
}
