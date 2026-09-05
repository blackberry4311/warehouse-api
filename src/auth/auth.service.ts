import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { User } from '../entities/user.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(RefreshToken) private refreshRepo: Repository<RefreshToken>,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.userRepo.findOne({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = this.userRepo.create({
      email: dto.email,
      passwordHash,
      displayName: dto.displayName ?? dto.email,
    });
    await this.userRepo.save(user);
    return { id: user.id, email: user.email };
  }

  async login(dto: LoginDto, userAgent?: string, ip?: string) {
    const user = await this.userRepo.findOne({ where: { email: dto.email } });
    if (!user) throw new BadRequestException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new BadRequestException('Invalid credentials');

    return this.issueTokens(user, userAgent, ip);
  }

  async refresh(userId: string, refToken: string, userAgent?: string, ip?: string) {
    const tokenHash = this.hashToken(refToken);
    const stored = await this.refreshRepo.findOne({
      where: { tokenHash, revokedAt: IsNull() },
      relations: { user: true },
    });

    if (!stored || stored.user.id !== userId || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // revoke old, issue new (rotation)
    stored.revokedAt = new Date();
    await this.refreshRepo.save(stored);

    return this.issueTokens(stored.user, userAgent, ip);
  }

  async logout(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    await this.refreshRepo.update({ tokenHash }, { revokedAt: new Date() });
  }

  private async issueTokens(user: User, userAgent?: string, ip?: string) {
    const payload = { sub: user.id, email: user.email };

    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get('JWT_ACCESS_EXPIRY'),
    });

    const refreshToken = this.jwt.sign(payload, {
      secret: this.config.get('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get('JWT_REFRESH_EXPIRY'),
    });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // match JWT_REFRESH_EXPIRY

    const entry = this.refreshRepo.create({
      user,
      tokenHash: this.hashToken(refreshToken),
      userAgent,
      ipAddress: ip,
      expiresAt,
    });
    await this.refreshRepo.save(entry);

    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
