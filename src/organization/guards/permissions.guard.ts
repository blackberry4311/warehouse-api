import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FastifyRequest } from 'fastify';
import { User } from '../../entities/user.entity';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { API_PERMISSION_MAP } from '../../auth/permissions.config';
import { OrganizationService } from '../organization.service';

/**
 * Global guard driven by `API_PERMISSION_MAP`. For each request it looks up
 * `"<method> <route path>"`:
 *   - not in the map            -> public, allowed.
 *   - mapped to a permission    -> the caller must be authenticated (valid access
 *     token) and either be a system admin (`is_admin`) or hold that permission.
 *
 * On success it populates `request.user` so `@CurrentUser()` keeps working.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly orgService: OrganizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    const routePath = request.routeOptions?.url ?? (request as { routerPath?: string }).routerPath;
    const key = `${request.method.toLowerCase()} ${routePath ?? ''}`;
    const required = API_PERMISSION_MAP[key];

    // Not listed => public route.
    if (!required || required.length === 0) return true;

    const authUser = this.authenticate(request);
    (request as FastifyRequest & { user: AuthenticatedUser }).user = authUser;

    const user = await this.userRepo.findOne({ where: { id: authUser.userId } });
    if (!user) throw new UnauthorizedException('User not found');

    // System super-admin bypasses all permission checks.
    if (user.isAdmin) return true;

    // A route may be granted by several permissions; holding any one suffices.
    const held = await this.orgService.getEffectivePermissionNames(user.id);
    if (!required.some((permission) => held.has(permission))) {
      throw new ForbiddenException(`Missing required permission: ${required.join(' or ')}`);
    }

    return true;
  }

  private authenticate(request: FastifyRequest): AuthenticatedUser {
    const header = request.headers.authorization;
    const [scheme, token] = header?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const payload = this.jwt.verify<{ sub: string; email: string }>(token, {
        secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      });
      return { userId: payload.sub, email: payload.email };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
