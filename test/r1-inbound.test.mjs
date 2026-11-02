// R1 · Safe inbound delivery: a replayed webhook must not create a second message or audit row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeskService } from '../src/service.mjs';

const ev = (o = {}) => ({ tenantId: 'alpha', ticketId: 101, eventId: 'event-1', body: 'Please help', ...o });
const count = (s, sql) => s.db.prepare(sql).get().n;
const messages = (s, id) => count(s, `SELECT COUNT(*) n FROM messages WHERE ticket_id = ${id}`);
const inbound = (s, id) => count(s, `SELECT COUNT(*) n FROM audit WHERE ticket_id = ${id} AND action = 'inbound'`);

test('replaying the same event creates one message and one audit row', () => {
  const s = new DeskService({ provider: {} });
  try {
    s.receiveWebhook(ev());
    s.receiveWebhook(ev());
    assert.equal(messages(s, 101), 1);
    assert.equal(inbound(s, 101), 1);
  } finally { s.close(); }
});

test('alpha and beta may both receive an event called event-1', () => {
  const s = new DeskService({ provider: {} });
  try {
    s.receiveWebhook(ev());
    s.receiveWebhook(ev({ tenantId: 'beta', ticketId: 202, body: 'Beta help' }));
    assert.equal(messages(s, 101), 1);
    assert.equal(messages(s, 202), 1);
  } finally { s.close(); }
});

test('a replay after an application restart is still ignored', () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), 'desk-r1-')), 'desk.sqlite');
  const first = new DeskService({ databasePath, provider: {} });
  first.receiveWebhook(ev());
  first.close();
  const second = new DeskService({ databasePath, provider: {} });
  try {
    second.receiveWebhook(ev());
    assert.equal(messages(second, 101), 1);
  } finally { second.close(); }
});

test('if the audit write fails, the message is rolled back and a replay can succeed', () => {
  const s = new DeskService({ provider: {} });
  try {
    s.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    assert.throws(() => s.receiveWebhook(ev()));
    assert.equal(messages(s, 101), 0, 'message survived a failed audit write');
    s.db.exec('DROP TRIGGER fail_audit;');
    s.receiveWebhook(ev());
    assert.equal(messages(s, 101), 1);
    assert.equal(inbound(s, 101), 1);
  } finally { s.close(); }
});
