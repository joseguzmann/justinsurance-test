// R3 · Exact approval: only the approved version is sent, and only once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeskService } from '../src/service.mjs';

const alpha = { id: 'agent-alpha', tenantId: 'alpha' };
const fakeProvider = (delayMs = 0) => {
  const sends = [];
  return { sends, lookup: async () => ({ state: 'not_found' }),
    send: async m => { sends.push(m); await new Promise(r => setTimeout(r, delayMs)); return { providerMessageId: 'p-' + sends.length }; } };
};
const status = async fn => { try { await fn(); return 200; } catch (e) { return e.status; } };

test('editing an approved draft invalidates the approval', async () => {
  const provider = fakeProvider();
  const s = new DeskService({ provider });
  try {
    s.updateDraft(alpha, 101, 'v1 reviewed'); s.approveDraft(alpha, 101);
    s.updateDraft(alpha, 101, 'v2 never approved');
    assert.equal(await status(() => s.sendReply(alpha, 101)), 409);
    assert.equal(provider.sends.length, 0);
  } finally { s.close(); }
});

test('re-approving the edited draft sends the new text', async () => {
  const provider = fakeProvider();
  const s = new DeskService({ provider });
  try {
    s.updateDraft(alpha, 101, 'v1 reviewed'); s.approveDraft(alpha, 101);
    s.updateDraft(alpha, 101, 'v2 reviewed'); s.approveDraft(alpha, 101);
    await s.sendReply(alpha, 101);
    assert.deepEqual(provider.sends.map(m => m.body), ['v2 reviewed']);
  } finally { s.close(); }
});

test('two overlapping sends of the same approved version deliver once', async () => {
  const provider = fakeProvider(50);
  const s = new DeskService({ provider });
  try {
    s.updateDraft(alpha, 101, 'v1 reviewed'); s.approveDraft(alpha, 101);
    const results = await Promise.allSettled([s.sendReply(alpha, 101), s.sendReply(alpha, 101)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
    assert.equal(provider.sends.length, 1);
  } finally { s.close(); }
});

test('sending again after a successful send is refused', async () => {
  const provider = fakeProvider();
  const s = new DeskService({ provider });
  try {
    s.updateDraft(alpha, 101, 'v1 reviewed'); s.approveDraft(alpha, 101);
    await s.sendReply(alpha, 101);
    assert.equal(await status(() => s.sendReply(alpha, 101)), 409);
    assert.equal(provider.sends.length, 1);
  } finally { s.close(); }
});

test('automation needs the exact approval too', async () => {
  const provider = fakeProvider();
  const s = new DeskService({ provider });
  try {
    s.updateDraft(alpha, 101, 'suggested text');
    assert.equal(await status(() => s.sendReply(alpha, 101, { automatic: true })), 409);
    s.approveDraft(alpha, 101); s.updateDraft(alpha, 101, 'edited after approval');
    assert.equal(await status(() => s.sendReply(alpha, 101, { automatic: true })), 409);
    assert.equal(provider.sends.length, 0);
  } finally { s.close(); }
});
