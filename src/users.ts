import type { Client } from './db.js';
import { conflict } from './errors.js';

export interface UserRow {
  id: string;
  phone: string;
  name: string;
  family_id: string;
  /** Admin of their own family. */
  is_admin: boolean;
  /** From the family: adds to the shared caller-ID names and spam labels. */
  trusted: boolean;
  status: string | null;
  share_contacts: boolean;
  protection: Record<string, unknown>;
  watched: boolean;
  fcm_token: string | null;
  device_name: string | null;
  last_seen_at: Date | null;
  shared_contact_count?: number;
}

export const USER_SELECT = `SELECT u.*, f.trusted,
  (SELECT count(*) FROM contacts c WHERE c.user_id = u.id) AS shared_contact_count
  FROM users u JOIN families f ON f.id = u.family_id`;

export function toUser(row: UserRow) {
  const p = row.protection ?? {};
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    isAdmin: row.is_admin,
    isTrusted: row.trusted,
    status: row.status,
    shareContacts: row.share_contacts,
    sharedContactCount: row.shared_contact_count ?? 0,
    protection: {
      screening: p.screening === true,
      overlay: p.overlay === true,
      recording: p.recording === true,
      reportedAt: typeof p.reportedAt === 'string' ? p.reportedAt : null,
    },
    watched: row.watched,
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
  };
}

export async function getUser(db: Client, id: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(`${USER_SELECT} WHERE u.id = $1`, [id]);
  return rows[0] ?? null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Throws `409 last_admin` unless the member's family still has an admin after the change.
 * Demoting: the target can't be the only admin. Removing: the only admin may
 * go only when nobody else is left. Call under lockCircle so concurrent
 * membership changes can't race past it.
 */
export async function assertKeepsAnAdmin(
  db: Client,
  change: { demoting: string } | { removing: string },
): Promise<void> {
  const id = 'demoting' in change ? change.demoting : change.removing;
  const { rows } = await db.query<{ target_admin: boolean | null; admins: number; others: number }>(
    `SELECT bool_or(is_admin) FILTER (WHERE id = $1) AS target_admin,
       count(*) FILTER (WHERE is_admin) AS admins,
       count(*) FILTER (WHERE id <> $1) AS others
     FROM users WHERE family_id = (SELECT family_id FROM users WHERE id = $1)`,
    [id],
  );
  const r = rows[0];
  if (!r.target_admin || r.admins > 1) return;
  if ('removing' in change && r.others === 0) return;
  throw conflict('last_admin', 'The family needs at least one admin');
}
