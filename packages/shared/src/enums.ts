export const CATEGORIES = ['furniture', 'souvenir', 'receipt', 'manuscript', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  furniture: '老家具',
  souvenir: '纪念品',
  receipt: '票据',
  manuscript: '手稿',
  other: '其他',
};

export const ITEM_STATUSES = ['draft', 'published', 'archived', 'trashed'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已归档',
  trashed: '回收站',
};

export const VISIBILITIES = ['private', 'family', 'selected', 'link'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  private: '仅自己',
  family: '全家人',
  selected: '指定成员',
  link: '链接可见',
};

export const PRECISIONS = ['day', 'month', 'year', 'decade', 'unknown'] as const;
export type Precision = (typeof PRECISIONS)[number];

export const PRECISION_LABELS: Record<Precision, string> = {
  day: '精确到日',
  month: '精确到月',
  year: '精确到年',
  decade: '只知道大概十年',
  unknown: '说不清',
};

export const MEDIA_KINDS = ['image', 'audio', 'document'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_STATUSES = ['processing', 'ready', 'failed'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export const NOTE_TYPES = ['story', 'comment', 'correction'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const NOTE_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export const PERSON_ROLES = ['source', 'gifted', 'inherited', 'owner', 'mentioned'] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export const PERSON_ROLE_LABELS: Record<PersonRole, string> = {
  source: '来源',
  gifted: '赠送',
  inherited: '继承',
  owner: '原主',
  mentioned: '故事中提及',
};

export const FAMILY_ROLES = ['owner', 'admin', 'editor', 'contributor', 'viewer'] as const;
export type FamilyRole = (typeof FAMILY_ROLES)[number];

export const FAMILY_ROLE_LABELS: Record<FamilyRole, string> = {
  owner: '创建者',
  admin: '管理员',
  editor: '编辑',
  contributor: '贡献者',
  viewer: '只读',
};

export const MEMBER_STATUSES = ['active', 'disabled'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export const JOB_TYPES = [
  'media_thumbnail',
  'media_waveform',
  'export_build',
  'trash_purge',
  'storage_gc',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const AUDIT_ACTIONS = [
  'auth.register',
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'family.create',
  'family.update',
  'family.delete',
  'member.invite',
  'member.join',
  'member.update_role',
  'member.remove',
  'person.create',
  'person.update',
  'person.delete',
  'person.merge',
  'item.create',
  'item.update',
  'item.publish',
  'item.archive',
  'item.restore',
  'item.trash',
  'item.purge',
  'item.revert',
  'media.upload',
  'media.update',
  'media.delete',
  'media.retry',
  'note.create',
  'note.accept',
  'note.reject',
  'share.create',
  'share.revoke',
  'export.create',
  'export.retry',
  'export.download',
  'access.denied',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

