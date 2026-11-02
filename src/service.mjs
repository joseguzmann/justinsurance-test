import { randomUUID } from 'node:crypto';
import { openStore, record, tx, ticketView, DeskError } from './store.mjs';

// This inherited implementation is intentionally incomplete. See README acceptance criteria.
export class DeskService {
  constructor({ databasePath = ':memory:', provider }) {
    this.db = openStore(databasePath);
    this.provider = provider;
  }
  close() { this.db.close(); }
  listTickets(actor) {
    return this.db.prepare('SELECT * FROM tickets WHERE tenant_id = ? ORDER BY id').all(actor.tenantId);
  }
  // The organization comes from the server-resolved actor only; a foreign ticket looks like a missing one.
  row(actor, id) {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?').get(id, actor.tenantId);
    if (!row) throw new DeskError(404, 'Ticket not found');
    return row;
  }
  getTicket(actor, id) { return ticketView(this.db, this.row(actor, id)); }
  receiveWebhook(event) {
    const t = this.db.prepare('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?')
      .get(event.ticketId, event.tenantId);
    if (!t || !event.eventId || typeof event.body !== 'string') throw new DeskError(400, 'Invalid event');
    // Event identity is (tenant, eventId); the primary key turns a replay into a no-op.
    return tx(this.db, () => {
      const seen = this.db.prepare('INSERT OR IGNORE INTO inbound_events(tenant_id, event_id, ticket_id) VALUES (?, ?, ?)')
        .run(t.tenant_id, event.eventId, t.id);
      if (!seen.changes) return { accepted: true, duplicate: true };
      this.db.prepare('INSERT INTO messages(ticket_id, event_id, body) VALUES (?, ?, ?)')
        .run(t.id, event.eventId, event.body);
      record(this.db, t.id, 'inbound', event.eventId);
      return { accepted: true };
    });
  }
  updateDraft(actor, id, body) {
    this.row(actor, id);
    if (typeof body !== 'string' || !body.trim()) throw new DeskError(400, 'A reply is required');
    this.db.prepare("UPDATE tickets SET draft = ?, version = version + 1, send_state = 'DRAFT' WHERE id = ?")
      .run(body, id);
    record(this.db, id, 'draft_updated', actor.id);
    return this.getTicket(actor, id);
  }
  approveDraft(actor, id) {
    const t = this.row(actor, id);
    if (!t.draft) throw new DeskError(400, 'No draft');
    this.db.prepare('UPDATE tickets SET approved_version = version WHERE id = ?').run(id);
    record(this.db, id, 'approved', actor.id);
    return this.getTicket(actor, id);
  }
  handoff(actor, id) {
    this.row(actor, id);
    this.db.prepare("UPDATE tickets SET owner = 'human' WHERE id = ?").run(id);
    record(this.db, id, 'human_handoff', actor.id);
    return this.getTicket(actor, id);
  }
  async sendReply(actor, id, { automatic = false } = {}) {
    const t = this.row(actor, id);
    // Only the exact saved version a human approved may leave; every edit bumps the version.
    if (t.approved_version !== t.version) throw new DeskError(409, 'Approve the current draft first');
    if (this.openAttempt(id)) throw new DeskError(409, 'A delivery is still uncertain: use Check delivery before sending again');
    // Claim this version before calling the provider: UNIQUE(ticket_id, version) stops a second send.
    const clientRef = randomUUID();
    try {
      this.db.prepare("INSERT INTO attempts(ticket_id, version, client_ref, body, state) VALUES (?, ?, ?, ?, 'SENDING')")
        .run(id, t.version, clientRef, t.draft);
    } catch (e) {
      if (!/UNIQUE/.test(e.message)) throw e;
      throw new DeskError(409, 'This version was already sent or is in progress');
    }
    const by = automatic ? 'automation' : actor.id;
    let result;
    try {
      result = await this.provider.send({ clientRef, ticketId: id, body: t.draft });
    } catch (e) {
      // 503 means definitely not accepted; anything else (504, connection loss) may have been delivered.
      if (e.kind === 'not_accepted') {
        this.settle(id, clientRef, 'FAILED', null, 'send_failed', `${by}: provider rejected ${clientRef}; re-save and approve to retry`);
        throw new DeskError(502, 'Provider rejected the message; it was not delivered');
      }
      this.settle(id, clientRef, 'UNKNOWN', null, 'send_unknown', `${by}: no confirmation for ${clientRef}; do not resend`);
      throw new DeskError(502, 'Delivery is uncertain: do not resend, use Check delivery');
    }
    this.settle(id, clientRef, 'SENT', result.providerMessageId, 'sent', `${by}: ${result.providerMessageId}`);
    return this.getTicket(actor, id);
  }
  // Resolves the open attempt only from provider evidence; it never sends.
  async reconcile(actor, id) {
    this.row(actor, id);
    const a = this.openAttempt(id);
    if (!a) throw new DeskError(409, 'No uncertain delivery to check');
    let found;
    try {
      found = await this.provider.lookup(a.client_ref);
    } catch {
      record(this.db, id, 'reconcile_failed', `${actor.id}: lookup unavailable for ${a.client_ref}; still UNKNOWN`);
      return this.getTicket(actor, id);
    }
    if (found.state === 'delivered')
      this.settle(id, a.client_ref, 'SENT', found.providerMessageId, 'reconciled_sent', `${actor.id}: provider confirmed ${found.providerMessageId}`);
    else // not_found is inconclusive: it does not prove the message was never delivered.
      record(this.db, id, 'reconcile_not_found', `${actor.id}: provider has no record of ${a.client_ref} yet; still UNKNOWN`);
    return this.getTicket(actor, id);
  }
  openAttempt(id) {
    return this.db.prepare("SELECT * FROM attempts WHERE ticket_id = ? AND state IN ('SENDING', 'UNKNOWN') ORDER BY id DESC")
      .get(id);
  }
  settle(id, clientRef, state, providerId, action, detail) {
    tx(this.db, () => {
      this.db.prepare('UPDATE attempts SET state = ?, provider_id = ? WHERE client_ref = ?').run(state, providerId, clientRef);
      this.db.prepare('UPDATE tickets SET send_state = ? WHERE id = ?').run(state, id);
      record(this.db, id, action, detail);
    });
  }
}
