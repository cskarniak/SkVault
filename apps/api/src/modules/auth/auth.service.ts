import { ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService) {}

  /** Inscription ouverte uniquement pour créer le tout premier compte. */
  async register(email: string, password: string, name: string) {
    if ((await this.prisma.user.count()) > 0) {
      throw new ForbiddenException('Inscription fermée : un compte existe déjà');
    }
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('Un compte avec cet email existe déjà');
    }
    const user = await this.prisma.user.create({
      data: { email, password: await bcrypt.hash(password, 10), name },
    });
    return this.token(user.id, user.email);
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException('Email ou mot de passe incorrect');
    }
    return this.token(user.id, user.email);
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, createdAt: true },
    });
    if (!user) throw new UnauthorizedException();
    return user;
  }

  async hasUsers() {
    return { hasUsers: (await this.prisma.user.count()) > 0 };
  }

  private token(userId: string, email: string) {
    return { accessToken: this.jwt.sign({ sub: userId, email }), user: { id: userId, email } };
  }
}
