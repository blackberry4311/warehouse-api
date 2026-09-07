import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Organization } from '../entities/organization.entity';
import { UserOrg } from '../entities/user-org.entity';
import { OrgGroup } from '../entities/org-group.entity';
import { Permission } from '../entities/permission.entity';
import { UserGroup } from '../entities/user-group.entity';
import { GroupPermission } from '../entities/group-permission.entity';
import { User } from '../entities/user.entity';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { CreateGroupDto } from './dto/create-group.dto';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { CreateUserDto } from './dto/create-user.dto';

/**
 * Manages everything under an organization: membership, groups (roles),
 * the global permission catalog, and the group/permission wiring that
 * resolves what a user is allowed to do.
 */
@Injectable()
export class OrganizationService {
  constructor(
    @InjectRepository(Organization) private orgRepo: Repository<Organization>,
    @InjectRepository(UserOrg) private userOrgRepo: Repository<UserOrg>,
    @InjectRepository(OrgGroup) private groupRepo: Repository<OrgGroup>,
    @InjectRepository(Permission) private permissionRepo: Repository<Permission>,
    @InjectRepository(UserGroup) private userGroupRepo: Repository<UserGroup>,
    @InjectRepository(GroupPermission) private groupPermRepo: Repository<GroupPermission>,
    @InjectRepository(User) private userRepo: Repository<User>,
  ) {}

  // --- Organizations -------------------------------------------------------

  createOrganization(dto: CreateOrganizationDto) {
    const org = this.orgRepo.create({ name: dto.name });
    return this.orgRepo.save(org);
  }

  listOrganizations() {
    return this.orgRepo.find({ order: { createdAt: 'DESC' } });
  }

  async getOrganization(orgId: string) {
    const org = await this.orgRepo.findOne({ where: { id: orgId } });
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  async deleteOrganization(orgId: string) {
    await this.getOrganization(orgId);
    // FKs cascade on delete (users_orgs, org_groups → group_permissions,
    // user_groups), so removing the org removes its membership and group wiring.
    await this.orgRepo.delete({ id: orgId });
    return { deleted: true };
  }

  // --- Membership ----------------------------------------------------------

  async addMember(orgId: string, userId: string) {
    await this.getOrganization(orgId);
    await this.ensureUserExists(userId);

    const existing = await this.userOrgRepo.findOne({ where: { orgId, userId } });
    if (existing) throw new ConflictException('User is already a member of this organization');

    const membership = this.userOrgRepo.create({ orgId, userId });
    return this.userOrgRepo.save(membership);
  }

  async listMembers(orgId: string) {
    await this.getOrganization(orgId);
    return this.userOrgRepo.find({ where: { orgId }, relations: { user: true } });
  }

  async removeMember(orgId: string, userId: string) {
    const result = await this.userOrgRepo.delete({ orgId, userId });
    if (!result.affected) throw new NotFoundException('Membership not found');
    return { removed: true };
  }

  // --- Groups (roles) ------------------------------------------------------

  async createGroup(orgId: string, dto: CreateGroupDto) {
    await this.getOrganization(orgId);
    const existing = await this.groupRepo.findOne({ where: { orgId, name: dto.name } });
    if (existing) throw new ConflictException('A group with this name already exists in the org');

    const group = this.groupRepo.create({ orgId, name: dto.name });
    return this.groupRepo.save(group);
  }

  async listGroups(orgId: string) {
    await this.getOrganization(orgId);
    return this.groupRepo.find({ where: { orgId }, order: { createdAt: 'DESC' } });
  }

  async getGroup(orgId: string, groupId: string) {
    const group = await this.groupRepo.findOne({ where: { id: groupId, orgId } });
    if (!group) throw new NotFoundException('Group not found');
    return group;
  }

  async deleteGroup(orgId: string, groupId: string) {
    await this.getGroup(orgId, groupId);
    await this.groupRepo.delete({ id: groupId });
    return { deleted: true };
  }

  // --- User <-> group assignment ------------------------------------------

  async assignUserToGroup(orgId: string, groupId: string, userId: string) {
    await this.getGroup(orgId, groupId);
    await this.ensureUserExists(userId);

    const membership = await this.userOrgRepo.findOne({ where: { orgId, userId } });
    if (!membership) throw new ConflictException('User must be a member of the org first');

    const existing = await this.userGroupRepo.findOne({ where: { groupId, userId } });
    if (existing) throw new ConflictException('User is already in this group');

    return this.userGroupRepo.save(this.userGroupRepo.create({ groupId, userId }));
  }

  async removeUserFromGroup(orgId: string, groupId: string, userId: string) {
    await this.getGroup(orgId, groupId);
    const result = await this.userGroupRepo.delete({ groupId, userId });
    if (!result.affected) throw new NotFoundException('Assignment not found');
    return { removed: true };
  }

  async listUserGroups(orgId: string, userId: string): Promise<OrgGroup[]> {
    const orgGroups = await this.groupRepo.find({ where: { orgId }, select: { id: true } });
    const orgGroupIds = orgGroups.map((g) => g.id);
    if (orgGroupIds.length === 0) return [];

    const userGroups = await this.userGroupRepo.find({
      where: { userId, groupId: In(orgGroupIds) },
    });
    const groupIds = userGroups.map((ug) => ug.groupId);
    if (groupIds.length === 0) return [];

    return this.groupRepo.find({ where: { id: In(groupIds) }, order: { createdAt: 'DESC' } });
  }

  // --- Permissions (global catalog) ---------------------------------------

  async createPermission(dto: CreatePermissionDto) {
    const existing = await this.permissionRepo.findOne({ where: { name: dto.name } });
    if (existing) throw new ConflictException('Permission already exists');
    return this.permissionRepo.save(
      this.permissionRepo.create({ name: dto.name, description: dto.description }),
    );
  }

  listPermissions() {
    return this.permissionRepo.find({ where: { isGroupPermission: true }, order: { name: 'ASC' } });
  }

  // --- Group <-> permission grants ----------------------------------------

  async grantPermissionToGroup(orgId: string, groupId: string, permissionId: string) {
    await this.getGroup(orgId, groupId);
    const permission = await this.permissionRepo.findOne({ where: { id: permissionId } });
    if (!permission) throw new NotFoundException('Permission not found');

    const existing = await this.groupPermRepo.findOne({ where: { groupId, permissionId } });
    if (existing) throw new ConflictException('Group already has this permission');

    return this.groupPermRepo.save(this.groupPermRepo.create({ groupId, permissionId }));
  }

  async revokePermissionFromGroup(orgId: string, groupId: string, permissionId: string) {
    await this.getGroup(orgId, groupId);
    const result = await this.groupPermRepo.delete({ groupId, permissionId });
    if (!result.affected) throw new NotFoundException('Grant not found');
    return { revoked: true };
  }

  async listGroupPermissions(orgId: string, groupId: string) {
    await this.getGroup(orgId, groupId);
    const grants = await this.groupPermRepo.find({
      where: { groupId },
      relations: { permission: true },
    });
    return grants.map((g) => g.permission);
  }

  // --- Permission resolution ----------------------------------------------

  /**
   * Resolve the effective set of permissions a user has within an org:
   * user -> user_groups -> group_permissions -> permissions,
   * scoped to groups that belong to `orgId`.
   */
  async getUserPermissions(orgId: string, userId: string): Promise<Permission[]> {
    const orgGroups = await this.groupRepo.find({ where: { orgId }, select: { id: true } });
    const orgGroupIds = orgGroups.map((g) => g.id);
    if (orgGroupIds.length === 0) return [];

    const userGroups = await this.userGroupRepo.find({
      where: { userId, groupId: In(orgGroupIds) },
    });
    const groupIds = userGroups.map((ug) => ug.groupId);
    if (groupIds.length === 0) return [];

    const grants = await this.groupPermRepo.find({
      where: { groupId: In(groupIds) },
      relations: { permission: true },
    });

    const byId = new Map<string, Permission>();
    for (const grant of grants) byId.set(grant.permission.id, grant.permission);
    return [...byId.values()];
  }

  /**
   * Effective permission *names* a user holds across all their groups (any org).
   * Used by the global `PermissionsGuard` to authorize requests via API_PERMISSION_MAP.
   */
  async getEffectivePermissionNames(userId: string): Promise<Set<string>> {
    const userGroups = await this.userGroupRepo.find({ where: { userId } });
    const groupIds = userGroups.map((ug) => ug.groupId);
    if (groupIds.length === 0) return new Set();

    const grants = await this.groupPermRepo.find({
      where: { groupId: In(groupIds) },
      relations: { permission: true },
    });
    return new Set(grants.map((grant) => grant.permission.name));
  }

  /**
   * Full access tree for a user, for the frontend to render UI after login:
   * the orgs they belong to → the groups they're in per org → the permissions
   * of each group, plus a flattened union of all permission names.
   */
  async getUserAccess(userId: string) {
    const user = await this.ensureUserExists(userId);

    const [memberships, userGroups] = await Promise.all([
      this.userOrgRepo.find({ where: { userId }, relations: { organization: true } }),
      this.userGroupRepo.find({ where: { userId }, relations: { group: true } }),
    ]);

    const groupIds = userGroups.map((ug) => ug.groupId);
    const grants = groupIds.length
      ? await this.groupPermRepo.find({
          where: { groupId: In(groupIds) },
          relations: { permission: true },
        })
      : [];

    // permission names per group
    const permsByGroup = new Map<string, string[]>();
    for (const grant of grants) {
      const list = permsByGroup.get(grant.groupId) ?? [];
      list.push(grant.permission.name);
      permsByGroup.set(grant.groupId, list);
    }

    // the user's groups per org
    const groupsByOrg = new Map<string, { id: string; name: string; permissions: string[] }[]>();
    for (const ug of userGroups) {
      const list = groupsByOrg.get(ug.group.orgId) ?? [];
      list.push({
        id: ug.group.id,
        name: ug.group.name,
        permissions: permsByGroup.get(ug.groupId) ?? [],
      });
      groupsByOrg.set(ug.group.orgId, list);
    }

    const organizations = memberships.map((m) => ({
      id: m.orgId,
      name: m.organization.name,
      groups: groupsByOrg.get(m.orgId) ?? [],
    }));

    // Admins bypass all permission checks, so hand the FE the full catalog to
    // render everything; everyone else gets their effective (group-derived) set.
    const permissions = user.isAdmin
      ? (await this.permissionRepo.find({ select: { name: true } })).map((p) => p.name)
      : [...new Set(grants.map((grant) => grant.permission.name))];

    return { userId: user.id, isAdmin: user.isAdmin, organizations, permissions };
  }

  // --- User provisioning ---------------------------------------------------

  /**
   * Create a user and attach them to `dto.orgId` / `dto.groupId`. The frontend
   * always sends the org and group the acting user is managing. The only guard
   * needed is that the acting user actually belongs to that org (admins excepted),
   * so a hand-crafted request can't attach users to an org the caller isn't in.
   */
  async createUser(actingUserId: string, dto: CreateUserDto) {
    const actor = await this.ensureUserExists(actingUserId);

    // Validate the target org, and that a non-admin caller belongs to it.
    await this.getOrganization(dto.orgId);
    if (!actor.isAdmin) {
      const membership = await this.userOrgRepo.findOne({
        where: { userId: actingUserId, orgId: dto.orgId },
      });
      if (!membership) throw new ForbiddenException('You do not belong to this organization');
    }

    // Validate the group belongs to that org (throws 404 otherwise).
    await this.getGroup(dto.orgId, dto.groupId);

    const existing = await this.userRepo.findOne({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.userRepo.save(
      this.userRepo.create({
        email: dto.email,
        passwordHash,
        displayName: dto.displayName ?? dto.email,
      }),
    );

    await this.userOrgRepo.save(this.userOrgRepo.create({ orgId: dto.orgId, userId: user.id }));
    await this.userGroupRepo.save(
      this.userGroupRepo.create({ groupId: dto.groupId, userId: user.id }),
    );

    return { id: user.id, email: user.email };
  }

  private async ensureUserExists(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}
