import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AgentInstallController } from './agent-install.controller';
import { AgentInstallService } from './agent-install.service';

@Module({ imports: [AuthModule], controllers: [AgentInstallController], providers: [AgentInstallService] })
export class AgentInstallModule {}
