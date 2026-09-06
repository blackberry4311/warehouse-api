create schema wh;

create table wh.users
(
    id            uuid                     default gen_random_uuid() not null
        primary key,
    email         varchar                                            not null,
    password_hash varchar                                            not null,
    display_name  varchar                                            not null,
    is_admin      boolean                  default false             not null,
    created_at    timestamp with time zone default now()             not null,
    updated_at    timestamp with time zone
);

create unique index user_unique on wh.users (email);

create table wh.refresh_tokens
(
    id         uuid                     default gen_random_uuid() not null
        primary key,
    user_id    uuid                                               not null
        references wh.users
            on update cascade on delete cascade,
    token_hash varchar                                            not null,
    user_agent varchar,
    ip_address varchar,
    expires_at timestamp with time zone                           not null,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone default now()
);

create table wh.organizations
(
    id         uuid                     default gen_random_uuid() not null
        primary key,
    name       varchar(255)                                       not null,
    created_at timestamp with time zone default now()             not null,
    updated_at timestamp with time zone
);

create table wh.users_orgs
(
    user_id_fk uuid                                   not null
        references wh.users on update cascade on delete cascade,
    org_id_fk  uuid                                   not null
        references wh.organizations on update cascade on delete cascade,
    created_at timestamp with time zone default now() not null,
    primary key (user_id_fk, org_id_fk)
);

create index users_orgs_org_id_idx on wh.users_orgs (org_id_fk);

create table wh.org_groups
(
    id         uuid                     default gen_random_uuid() not null
        primary key,
    name       varchar(255)                                       not null,
    org_id_fk  uuid                                               not null
        references wh.organizations on update cascade on delete cascade,
    created_at timestamp with time zone default now()             not null,
    updated_at timestamp with time zone
);

create unique index org_group_unique on wh.org_groups (name, org_id_fk);
create index org_groups_org_id_idx on wh.org_groups (org_id_fk);

create table wh.permissions
(
    id          uuid                     default gen_random_uuid() not null
        primary key,
    name        varchar(255)                                       not null,
    description text                                               not null,
    created_at  timestamp with time zone default now()             not null,
    updated_at  timestamp with time zone
);

create unique index permission_unique on wh.permissions (name);

create table wh.user_groups
(
    user_id_fk  uuid                                   not null
        references wh.users on update cascade on delete cascade,
    group_id_fk uuid                                   not null
        references wh.org_groups on update cascade on delete cascade,
    created_at  timestamp with time zone default now() not null,
    primary key (user_id_fk, group_id_fk)
);

create index user_groups_group_id_idx on wh.user_groups (group_id_fk);

create table wh.group_permissions
(
    group_id_fk      uuid                                   not null
        references wh.org_groups on update cascade on delete cascade,
    permission_id_fk uuid                                   not null
        references wh.permissions on update cascade on delete cascade,
    created_at       timestamp with time zone default now() not null,
    primary key (group_id_fk, permission_id_fk)
);

create index group_permissions_permission_id_idx on wh.group_permissions (permission_id_fk);

insert into wh.permissions (name, description)
values ('add_user', 'Create a user and attach them to an organization'),
       ('manage_organizations', 'Create organizations'),
       ('view_organizations', 'List and view organizations'),
       ('manage_org_members', 'Add or remove organization members'),
       ('view_org_members', 'List organization members'),
       ('view_user_permissions', 'View a user''s effective permissions'),
       ('manage_groups', 'Create or delete groups within an organization'),
       ('view_groups', 'List groups within an organization'),
       ('manage_group_members', 'Assign or remove users from groups'),
       ('manage_group_permissions', 'Grant or revoke a group permissions'),
       ('view_group_permissions', 'List a group''s permissions'),
       ('manage_permissions', 'Create entries in the permission catalog'),
       ('view_permissions', 'List the permission catalog')
on conflict (name) do nothing;
