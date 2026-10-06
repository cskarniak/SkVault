import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { PrismaService } from '../../prisma/prisma.service';

const VALIDITY_MS = 60 * 60 * 1000;

@Injectable()
export class AgentInstallService {
  constructor(private prisma: PrismaService, private config: ConfigService) {}

  /** Fichier de l'agent (`pnpm --filter agent bundle`) : un seul .js, seul Node ≥ 20 est requis sur la machine. */
  private get bundlePath() {
    return this.config.get<string>('AGENT_BUNDLE_PATH') ?? join(__dirname, '../../../../../agent/dist/agent.js');
  }

  async createEnrollment(hostName?: string) {
    await this.prisma.agentEnrollment.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const e = await this.prisma.agentEnrollment.create({
      data: {
        code: randomBytes(24).toString('base64url'),
        hostName,
        expiresAt: new Date(Date.now() + VALIDITY_MS),
      },
    });
    return { code: e.code, expiresAt: e.expiresAt, bundleAvailable: existsSync(this.bundlePath) };
  }

  private async validCode(code: string) {
    const e = await this.prisma.agentEnrollment.findUnique({ where: { code } });
    if (!e || e.expiresAt < new Date()) throw new NotFoundException('Code d\'installation invalide ou expiré');
    return e;
  }

  /** `sh` (macOS/Linux) ou `ps1` (Windows PowerShell). */
  async renderScript(code: string, origin: string, kind: 'sh' | 'ps1' = 'sh') {
    const e = await this.validCode(code);
    const template = await readFile(join(__dirname, `../../../../assets/install-agent.${kind}`), 'utf8');
    const caFile = this.config.get<string>('ROOT_CA_FILE');
    const script = template
      .replaceAll('__ORIGIN__', origin)
      .replaceAll('__CODE__', e.code)
      .replaceAll('__TOKEN__', this.config.getOrThrow<string>('AGENT_TOKEN'))
      .replaceAll('__HOST_NAME__', e.hostName ?? '')
      .replaceAll('__HAS_CA__', caFile && existsSync(caFile) && origin.startsWith('https') ? '1' : '0');
    // Windows PowerShell 5.1 lit un .ps1 sans BOM en page de code ANSI : le BOM préserve les accents.
    return kind === 'ps1' ? '\uFEFF' + script : script;
  }

  async agentBundle(code: string) {
    await this.validCode(code);
    if (!existsSync(this.bundlePath)) {
      throw new NotFoundException('Fichier de l\'agent non construit sur le serveur (pnpm --filter agent bundle)');
    }
    return readFile(this.bundlePath);
  }

  /** Certificat de l'autorité locale (public) : permet à l'agent de vérifier le HTTPS du serveur. */
  async rootCa(code: string) {
    await this.validCode(code);
    const file = this.config.get<string>('ROOT_CA_FILE');
    if (!file || !existsSync(file)) throw new NotFoundException('Pas d\'autorité de certification configurée');
    return readFile(file);
  }
}
