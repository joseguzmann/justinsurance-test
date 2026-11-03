// R4 · Honest delivery: an uncertain send is UNKNOWN, never resent, and resolved only by provider evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeskService } from '../src/service.mjs';

const alpha = { id: 'agent-alpha', tenantId: 'alpha' };
// onSend decides how the fake provider answers; lookup answers Check delivery.
const fakeProvider = ({ onSend = () => ({ providerMessageId: 'p-1' }), lookup = async () => ({ state: 'not_found' }) } = {}) => {
  const sends = [];
  return { sends, lookup, send: async m => { sends.push(m); return onSend(m); } };
};
const timeout = () => { throw Object.assign(new Error('504'), { kind: 'unknown' }); };
const rejected = () => { throw Object.assign(new Error('503'), { kind: 'not_accepted' }); };
const status = async fn => { try { await fn(); return 200; } catch (e) { return e.status; } };
const approved = (s, body = 'v1 reviewed') => { s.updateDraft(alpha, 101, body); s.approveDraft(alpha, 101); };
const lastAttempt = s => s.getTicket(alpha, 101).attempts.at(-1);

test('a timeout after acceptance is recorded as UNKNOWN and a second send is refused', async () => {
  const provider = fakeProvider({ onSend: timeout });
  const s = new DeskService({ provider });
  try {
    approved(s);
    assert.equal(await status(() => s.sendReply(alpha, 101)), 502);
    assert.equal(lastAttempt(s).state, 'UNKNOWN');
    assert.equal(s.getTicket(alpha, 101).send_state, 'UNKNOWN');
    assert.equal(await status(() => s.sendReply(alpha, 101)), 409);
    assert.equal(provider.sends.length, 1);
  } finally { s.close(); }
});

test('Check delivery resolves UNKNOWN to SENT from provider evidence without resending', async () => {
  const provider = fakeProvider({ onSend: timeout, lookup: async () => ({ state: 'delivered', providerMessageId: 'p-9', count: 1 }) });
  const s = new DeskService({ provider });
  try {
    approved(s);
    await status(() => s.sendReply(alpha, 101));
    const t = await s.reconcile(alpha, 101);
    assert.equal(t.send_state, 'SENT');
    assert.equal(t.attempts.at(-1).state, 'SENT');
    assert.equal(t.attempts.at(-1).provider_id, 'p-9');
    assert.equal(provider.sends.length, 1);
  } finally { s.close(); }
});

test('not_found or a failed lookup keeps the attempt UNKNOWN', async () => {
  const provider = fakeProvider({ onSend: timeout });
  const s = new DeskService({ provider });
  try {
    approved(s);
    await status(() => s.sendReply(alpha, 101));
    await s.reconcile(alpha, 101);
    assert.equal(lastAttempt(s).state, 'UNKNOWN');
    provider.lookup = async () => { throw new Error('Lookup unavailable'); };
    await status(() => s.reconcile(alpha, 101));
    assert.equal(lastAttempt(s).state, 'UNKNOWN');
    assert.equal(provider.sends.length, 1);
  } finally { s.close(); }
});

test('an explicit rejection is a safe FAILED, and a re-approved draft can be sent', async () => {
  const provider = fakeProvider({ onSend: rejected });
  const s = new DeskService({ provider });
  try {
    approved(s);
    assert.equal(await status(() => s.sendReply(alpha, 101)), 502);
    assert.equal(lastAttempt(s).state, 'FAILED');
    const ok = fakeProvider();
    s.provider = ok;
    approved(s, 'v1 reviewed'); // re-saving creates v2, which needs its own approval
    await s.sendReply(alpha, 101);
    assert.equal(lastAttempt(s).state, 'SENT');
    assert.equal(ok.sends.length, 1);
  } finally { s.close(); }
});

test('after an explicit rejection the same version can be sent again with a new clientRef', async () => {
  const provider = fakeProvider({ onSend: rejected });
  const s = new DeskService({ provider });
  try {
    approved(s);
    await status(() => s.sendReply(alpha, 101));
    provider.send = async m => { provider.sends.push(m); return timeout(); };
    assert.equal(await status(() => s.sendReply(alpha, 101)), 502);
    const [first, second] = s.getTicket(alpha, 101).attempts;
    assert.deepEqual([first.state, second?.state], ['FAILED', 'UNKNOWN']);
    assert.notEqual(first.client_ref, second.client_ref);
    const looked = [];
    provider.lookup = async ref => { looked.push(ref); return { state: 'delivered', providerMessageId: 'p-2', count: 1 }; };
    await s.reconcile(alpha, 101);
    assert.deepEqual(looked, [second.client_ref], 'Check delivery must follow the latest attempt');
    assert.equal(await status(() => s.sendReply(alpha, 101)), 409, 'a delivered version is never sent twice');
  } finally { s.close(); }
});

test('a database created with the old one-attempt-per-version rule is upgraded on startup', async () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'desk-r4-')), 'desk.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(databasePath);
  old.exec(`CREATE TABLE attempts (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, version INTEGER NOT NULL,
    client_ref TEXT NOT NULL UNIQUE, body TEXT NOT NULL, state TEXT NOT NULL, provider_id TEXT, UNIQUE(ticket_id, version))`);
  old.close();
  const provider = fakeProvider({ onSend: rejected });
  const s = new DeskService({ databasePath, provider });
  try {
    approved(s);
    await status(() => s.sendReply(alpha, 101));
    provider.send = async m => { provider.sends.push(m); return { providerMessageId: 'p-2' }; };
    await s.sendReply(alpha, 101);
    assert.deepEqual(s.getTicket(alpha, 101).attempts.map(a => a.state), ['FAILED', 'SENT']);
  } finally { s.close(); }
});

// The send is still waiting when Check delivery confirms it; then the provider's late answer arrives.
for (const [late, answer] of [['200', () => ({ providerMessageId: 'p-1' })], ['504', timeout]]) {
  test(`a late ${late} after Check delivery confirmed the send changes nothing`, async () => {
    let answerNow;
    const provider = fakeProvider({ lookup: async () => ({ state: 'delivered', providerMessageId: 'p-1', count: 1 }) });
    provider.send = async m => { provider.sends.push(m); await new Promise(r => { answerNow = r; }); return answer(); };
    const s = new DeskService({ provider });
    try {
      approved(s);
      const sending = status(() => s.sendReply(alpha, 101));
      await new Promise(r => setImmediate(r));
      await s.reconcile(alpha, 101);
      answerNow();
      assert.equal(await sending, 200, 'the late answer is not reported as a failure');
      const t = s.getTicket(alpha, 101);
      assert.equal(t.attempts.at(-1).state, 'SENT');
      assert.equal(t.send_state, 'SENT');
      assert.deepEqual(t.audit.map(a => a.action).filter(a => a.startsWith('sen') || a.startsWith('rec')), ['reconciled_sent']);
    } finally { s.close(); }
  });
}

test('an attempt left SENDING by a restart becomes UNKNOWN and is not resent', async () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'desk-r4-')), 'desk.sqlite');
  const hanging = fakeProvider({ onSend: () => new Promise(() => {}) });
  const first = new DeskService({ databasePath, provider: hanging });
  approved(first);
  first.sendReply(alpha, 101);
  first.close();
  const provider = fakeProvider({ lookup: async () => ({ state: 'delivered', providerMessageId: 'p-1', count: 1 }) });
  const second = new DeskService({ databasePath, provider });
  try {
    assert.equal(lastAttempt(second).state, 'UNKNOWN');
    assert.equal(await status(() => second.sendReply(alpha, 101)), 409);
    assert.equal((await second.reconcile(alpha, 101)).send_state, 'SENT');
    assert.equal(hanging.sends.length + provider.sends.length, 1);
  } finally { second.close(); }
});
