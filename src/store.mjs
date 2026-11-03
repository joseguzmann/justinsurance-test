import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class DeskError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, contact TEXT NOT NULL,
      subject TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'automation',
      draft TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
      approved_version INTEGER, send_state TEXT NOT NULL DEFAULT 'DRAFT'
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, event_id TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, action TEXT NOT NULL,
      detail TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, version INTEGER NOT NULL,
      client_ref TEXT NOT NULL UNIQUE, body TEXT NOT NULL,
      state TEXT NOT NULL, provider_id TEXT
    );
    CREATE TABLE IF NOT EXISTS inbound_events (
      tenant_id TEXT NOT NULL, event_id TEXT NOT NULL, ticket_id INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, event_id)
    );
    INSERT OR IGNORE INTO tickets(id, tenant_id, contact, subject) VALUES
      (101, 'alpha', 'Jordan Demo', 'Cannot resume my practice exam'),
      (202, 'beta', 'Casey Example', 'Course completion is missing');
    -- A send still SENDING at startup may or may not have reached the provider: never resend it.
    INSERT INTO audit(ticket_id, action, detail) SELECT ticket_id, 'send_unknown',
      'restart: v' || version || ' was in flight as ' || client_ref || '; do not resend, use Check delivery'
      FROM attempts WHERE state = 'SENDING';
    UPDATE tickets SET send_state = 'UNKNOWN' WHERE id IN (SELECT ticket_id FROM attempts WHERE state = 'SENDING');
    UPDATE attempts SET state = 'UNKNOWN' WHERE state = 'SENDING';
  `);
  allowRetryAfterFailure(db);
  return db;
}

// One live attempt per version (SENDING, UNKNOWN or SENT); a FAILED one was never accepted, so it may be retried.
// Older stores declare UNIQUE(ticket_id, version) on the table, which SQLite cannot drop: rebuild once, keeping rows.
function allowRetryAfterFailure(db) {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attempts'").get();
  if (/UNIQUE\s*\(\s*ticket_id\s*,\s*version\s*\)/i.test(sql)) tx(db, () => db.exec(`
    CREATE TABLE attempts_new (
      id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, version INTEGER NOT NULL,
      client_ref TEXT NOT NULL UNIQUE, body TEXT NOT NULL,
      state TEXT NOT NULL, provider_id TEXT
    );
    INSERT INTO attempts_new SELECT id, ticket_id, version, client_ref, body, state, provider_id FROM attempts;
    DROP TABLE attempts;
    ALTER TABLE attempts_new RENAME TO attempts;
  `));
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS attempts_live_once ON attempts(ticket_id, version) WHERE state <> 'FAILED'");
}

// All writes inside fn commit together or not at all.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
}

export function record(db, id, action, detail) {
  db.prepare('INSERT INTO audit(ticket_id, action, detail) VALUES (?, ?, ?)')
    .run(id, action, detail);
}

export function ticketView(db, row) {
  const attempts = db.prepare('SELECT * FROM attempts WHERE ticket_id = ? ORDER BY id').all(row.id);
  return {
    ...row,
    next_action: nextAction(row, attempts),
    messages: db.prepare('SELECT * FROM messages WHERE ticket_id = ? ORDER BY id').all(row.id),
    audit: db.prepare('SELECT * FROM audit WHERE ticket_id = ? ORDER BY id').all(row.id),
    attempts
  };
}

// The one safe step an agent should take next, checked in order of risk.
export function nextAction(t, attempts) {
  const open = attempts.findLast(a => a.state === 'SENDING' || a.state === 'UNKNOWN');
  if (open) return `Delivery of v${open.version} is uncertain. Do not resend: use Check delivery. If the provider has no record yet, check again later.`;
  if (!t.draft) return 'Write and save a reply draft.';
  if (t.approved_version !== t.version) return `Review and approve draft v${t.version} before sending.`;
  const last = attempts.findLast(a => a.version === t.version);
  if (last?.state === 'SENT') return `Reply v${t.version} was delivered. Wait for the customer or save a new draft.`;
  if (last?.state === 'FAILED') return `The provider rejected v${t.version}; it was not delivered. It is safe to send it again.`;
  return t.owner === 'human' ? `Approved v${t.version} is ready to send: use Send manually.`
    : `Approved v${t.version} is ready to send. Take over first if a person should handle this ticket.`;
}

// Synthetic identities only. Treat server-side identity as authoritative.
export const actors = {
  'demo-alpha-token': { id: 'agent-alpha', tenantId: 'alpha' },
  'demo-beta-token': { id: 'agent-beta', tenantId: 'beta' }
};
