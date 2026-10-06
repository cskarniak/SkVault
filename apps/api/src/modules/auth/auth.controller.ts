import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { JwtGuard } from './jwt.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

  @Get('status')
  @ApiOperation({ summary: 'Indique si un compte existe déjà (inscription possible sinon)' })
  status() {
    return this.service.hasUsers();
  }

  @Post('register')
  @ApiOperation({ summary: 'Créer le premier compte' })
  register(@Body() body: { email: string; password: string; name: string }) {
    return this.service.register(body.email, body.password, body.name);
  }

  @Post('login')
  login(@Body() body: { email: string; password: string }) {
    return this.service.login(body.email, body.password);
  }

  @Get('me')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  me(@Req() req: Request & { user: { sub: string } }) {
    return this.service.getProfile(req.user.sub);
  }
}
