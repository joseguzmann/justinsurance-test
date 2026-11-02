// R6 · Usable handoff: the ticket tells the agent the true delivery state and the next safe action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeskService } from '../src/service.mjs';

const alpha = { id: 'agent-alpha', tenantId: 'alpha' };
const fakeProvider = (onSend = () => ({ providerMessageId: 'p-1' })) =>
  ({ lookup: async () => ({ state: 'not_found' }), send: async m => onSend(m) });
const timeout = () => { throw Object.assign(new Error('504'), { kind: 'unknown' }); };
const rejected = () => { throw Object.assign(new Error('503'), { kind: 'not_accepted' }); };
const approved = s => { s.updateDraft(alpha, 101, 'Approved reply'); s.approveDraft(alpha, 101); };
const next = s => s.getTicket(alpha, 101).next_action;

test('an uncertain delivery stays visible after the draft is edited', async () => {
  const s = new DeskService({ provider: fakeProvider(timeout) });
  try {
    approved(s);
    await s.sendReply(alpha, 101).catch(() => {});
    s.updateDraft(alpha, 101, 'Edited after the timeout');
    assert.equal(s.getTicket(alpha, 101).send_state, 'UNKNOWN');
    assert.equal(s.listTickets(alpha)[0].send_state, 'UNKNOWN');
    assert.match(next(s), /Check delivery/);
  } finally { s.close(); }
});

test('next_action names the next safe step in each state', async () => {
  const s = new DeskService({ provider: fakeProvider() });
  try {
    assert.match(next(s), /Write and save/);
    s.updateDraft(alpha, 101, 'Draft');
    assert.match(next(s), /approve draft v1/);
    s.approveDraft(alpha, 101);
    assert.match(next(s), /ready to send/);
    await s.sendReply(alpha, 101);
    assert.match(next(s), /delivered/);
    s.provider = fakeProvider(rejected);
    approved(s);
    await s.sendReply(alpha, 101).catch(() => {});
    assert.match(next(s), /rejected.*not delivered/);
  } finally { s.close(); }
});

test('the audit names versions and records restart recovery', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'desk-r6-')), 'desk.sqlite');
  const first = new DeskService({ databasePath, provider: fakeProvider(() => new Promise(() => {})) });
  approved(first);
  first.sendReply(alpha, 101);
  first.close();
  const second = new DeskService({ databasePath, provider: fakeProvider() });
  try {
    const audit = second.getTicket(alpha, 101).audit.map(a => `${a.action} ${a.detail}`);
    assert.ok(audit.some(a => /^draft_updated .*v1/.test(a)), audit.join('\n'));
    assert.ok(audit.some(a => /^approved .*v1/.test(a)), audit.join('\n'));
    assert.ok(audit.some(a => /^send_unknown .*restart/.test(a)), audit.join('\n'));
  } finally { second.close(); }
});

test('the inbox never renders untrusted text as HTML', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});
