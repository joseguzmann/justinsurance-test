// R5 · Human takeover: once a human owns the ticket, automation may not send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeskService } from '../src/service.mjs';

const alpha = { id: 'agent-alpha', tenantId: 'alpha' };
const fakeProvider = () => {
  const sends = [];
  return { sends, lookup: async () => ({ state: 'not_found' }),
    send: async m => { sends.push(m); return { providerMessageId: 'p-' + sends.length }; } };
};
const status = async fn => { try { await fn(); return 200; } catch (e) { return e.status; } };
const approved = s => { s.updateDraft(alpha, 101, 'Approved reply'); s.approveDraft(alpha, 101); };

test('automation can send an approved reply before takeover', async () => {
  const provider = fakeProvider();
  const s = new DeskService({ provider });
  try {
    approved(s);
    await s.sendReply(alpha, 101, { automatic: true });
    assert.equal(provider.sends.length, 1);
  } finally { s.close(); }
});

test('after takeover, automation is refused and nothing is sent', async () => {
  const provider = fakeProvider();
  const s = new DeskService({ provider });
  try {
    approved(s);
    s.handoff(alpha, 101);
    assert.equal(await status(() => s.sendReply(alpha, 101, { automatic: true })), 409);
    assert.equal(provider.sends.length, 0);
    assert.equal(s.getTicket(alpha, 101).attempts.length, 0);
  } finally { s.close(); }
});

test('after takeover, the human can still send the approved reply', async () => {
  const provider = fakeProvider();
  const s = new DeskService({ provider });
  try {
    approved(s);
    s.handoff(alpha, 101);
    await s.sendReply(alpha, 101);
    assert.equal(provider.sends.length, 1);
  } finally { s.close(); }
});

test('an automation dispatch in flight at takeover is audited as automation, before the handoff', async () => {
  let answerNow;
  const provider = fakeProvider();
  provider.send = async m => { provider.sends.push(m); await new Promise(r => { answerNow = r; }); return { providerMessageId: 'p-1' }; };
  const s = new DeskService({ provider });
  try {
    approved(s);
    const sending = s.sendReply(alpha, 101, { automatic: true });
    s.handoff(alpha, 101); // the human takes over while the provider is still answering
    answerNow();
    await sending;
    const ref = s.getTicket(alpha, 101).attempts[0].client_ref;
    const audit = s.getTicket(alpha, 101).audit;
    const dispatch = audit.findIndex(a => a.detail.includes(ref));
    const handoff = audit.findIndex(a => a.action === 'human_handoff');
    assert.ok(dispatch >= 0 && dispatch < handoff, 'the dispatch is recorded before the handoff');
    assert.match(audit[dispatch].detail, /^automation:/);
  } finally { s.close(); }
});
