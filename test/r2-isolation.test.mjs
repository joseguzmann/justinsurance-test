// R2 · Customer isolation: the server-side actor decides which organization's tickets are reachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeskService } from '../src/service.mjs';

const alpha = { id: 'agent-alpha', tenantId: 'alpha' };
const beta = { id: 'agent-beta', tenantId: 'beta' };
const fakeProvider = () => {
  const sends = [];
  return { sends, send: async m => { sends.push(m); return { providerMessageId: 'p-1' }; },
    lookup: async () => ({ state: 'not_found' }) };
};
const status = async fn => { try { await fn(); return 200; } catch (e) { return e.status; } };

test('alpha cannot read a beta ticket', async () => {
  const s = new DeskService({ provider: fakeProvider() });
  try {
    assert.equal(await status(() => s.getTicket(alpha, 202)), 404);
  } finally { s.close(); }
});

test('alpha cannot change or send a beta ticket, and nothing is written or delivered', async () => {
  const provider = fakeProvider();
  const s = new DeskService({ provider });
  try {
    s.updateDraft(beta, 202, 'Beta reply'); s.approveDraft(beta, 202);
    const snapshot = () => JSON.stringify(s.getTicket(beta, 202));
    const before = snapshot();
    assert.equal(await status(() => s.updateDraft(alpha, 202, 'written by alpha')), 404);
    assert.equal(await status(() => s.approveDraft(alpha, 202)), 404);
    assert.equal(await status(() => s.handoff(alpha, 202)), 404);
    assert.equal(await status(() => s.sendReply(alpha, 202)), 404);
    assert.equal(await status(() => s.sendReply(alpha, 202, { automatic: true })), 404);
    assert.equal(await status(() => s.reconcile(alpha, 202)), 404);
    assert.equal(snapshot(), before, 'beta ticket changed');
    assert.equal(provider.sends.length, 0, 'alpha delivered a message on a beta ticket');
  } finally { s.close(); }
});

test('beta can still work on its own ticket', async () => {
  const provider = fakeProvider();
  const s = new DeskService({ provider });
  try {
    s.updateDraft(beta, 202, 'Beta reply'); s.approveDraft(beta, 202);
    await s.sendReply(beta, 202);
    assert.equal(provider.sends.length, 1);
  } finally { s.close(); }
});
