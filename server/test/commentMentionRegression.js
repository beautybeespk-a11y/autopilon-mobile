// Round 33 sweep — comments.js's @mention resolver picked the first
// name-matching org member with no ambiguity guard (same missing-guard
// class as the pixel auto-revise matcher, matchCreativeCandidateId's own
// header comment, and the round-31/33 asset-resolution bugs this session
// already fixed). Real DB, direct function calls (createComment/
// listComments are the same functions routes/comments.js's HTTP layer
// calls — no HTTP round trip needed to prove the matching logic itself).
//
//   node test/commentMentionRegression.js
import assert from "node:assert/strict";

process.env.DB_PATH = process.env.DB_PATH || "/tmp/comment-mention-regression.sqlite";

const db = (await import("../db.js")).default;
const { cryptoRandom } = await import("../middleware.js");
const { createComment, listComments } = await import("../orchestrator/comments.js");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.stack || err.message });
    console.log(`FAIL  ${name} — ${err.message}`);
  }
}

const stamp = Date.now();
const now = () => new Date().toISOString();

function makeUser(name, email) {
  const id = cryptoRandom();
  db.prepare("INSERT INTO users (id, name, email, password, createdAt) VALUES (?, ?, ?, ?, ?)").run(id, name, email, "hash", now());
  return id;
}

function makeOrgWithMembers(memberIds) {
  const orgId = cryptoRandom();
  db.prepare("INSERT INTO organizations (id, name, ownerId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)").run(orgId, `Org ${stamp}`, memberIds[0], now(), now());
  for (const userId of memberIds) {
    db.prepare("INSERT INTO organization_members (id, orgId, userId, role, status, joinedAt) VALUES (?, ?, ?, 'member', 'active', ?)").run(cryptoRandom(), orgId, userId, now());
  }
  return orgId;
}

function makeTask(ownerUserId, title) {
  const id = cryptoRandom();
  db.prepare("INSERT INTO tasks (id, userId, title, createdAt) VALUES (?, ?, ?, ?)").run(id, ownerUserId, title, now());
  return id;
}

async function run() {
  await check("[mentions] a single unambiguous name match resolves and notifies that person", async () => {
    const author = makeUser(`Author ${stamp}`, `author-${stamp}@example.com`);
    const alice = makeUser(`Alice Unique ${stamp}`, `alice-${stamp}@example.com`);
    const orgId = makeOrgWithMembers([author, alice]);
    const taskId = makeTask(author, "Test task");

    const { mentionedUserIds } = createComment(author, { entityType: "task", entityId: taskId, content: `@AliceUnique${stamp} can you take a look?` });
    assert.deepEqual(mentionedUserIds, [alice], "the single unambiguous name match must resolve");
    const comments = listComments(author, "task", taskId);
    assert.deepEqual(comments[0].mentionedUserIds, [alice]);
    void orgId;
  });

  await check("[mentions] an exact email match is always honored, even when two members share a display name", async () => {
    const author = makeUser(`Author2 ${stamp}`, `author2-${stamp}@example.com`);
    const johnA = makeUser(`John Smith`, `john.a-${stamp}@example.com`);
    const johnB = makeUser(`John Smith`, `john.b-${stamp}@example.com`);
    makeOrgWithMembers([author, johnA, johnB]);
    const taskId = makeTask(author, "Test task 2");

    const { mentionedUserIds } = createComment(author, { entityType: "task", entityId: taskId, content: `@john.a-${stamp}@example.com please review` });
    assert.deepEqual(mentionedUserIds, [johnA], "an exact email match must be honored — email is unique, never ambiguous, even though the name collides");
  });

  await check("[mentions] CONFIRMED LIVE BUG: two org members sharing a display name — a @name mention must resolve to NEITHER, never guess which one", async () => {
    const author = makeUser(`Author3 ${stamp}`, `author3-${stamp}@example.com`);
    const johnA = makeUser(`John Smith`, `johna3-${stamp}@example.com`);
    const johnB = makeUser(`John Smith`, `johnb3-${stamp}@example.com`);
    makeOrgWithMembers([author, johnA, johnB]);
    const taskId = makeTask(author, "Test task 3");

    // Before the fix, Array.find() silently returned whichever "John
    // Smith" happened to come first in the SQL result order — a real
    // person would be notified/mentioned without ever having been the
    // one actually meant, with no error and no sign anything was wrong.
    const { mentionedUserIds } = createComment(author, { entityType: "task", entityId: taskId, content: "@JohnSmith can you take this one?" });
    assert.deepEqual(mentionedUserIds, [], "an ambiguous name match (2+ real candidates) must resolve to nobody, never guess between them");
    assert.ok(!mentionedUserIds.includes(johnA), "must not silently pick the first candidate");
    assert.ok(!mentionedUserIds.includes(johnB), "must not silently pick the other candidate either");
  });

  await check("[mentions] a name match that ISN'T also ambiguous still resolves normally (no over-correction)", async () => {
    const author = makeUser(`Author4 ${stamp}`, `author4-${stamp}@example.com`);
    const bob = makeUser(`Bob Distinct ${stamp}`, `bob-${stamp}@example.com`);
    const johnA = makeUser(`John Smith`, `johna4-${stamp}@example.com`);
    const johnB = makeUser(`John Smith`, `johnb4-${stamp}@example.com`);
    makeOrgWithMembers([author, bob, johnA, johnB]);
    const taskId = makeTask(author, "Test task 4");

    // Same org also has an ambiguous "John Smith" pair — proves the
    // ambiguity check is scoped per-fragment, not a global "any ambiguity
    // anywhere blocks everything" over-correction.
    const { mentionedUserIds } = createComment(author, { entityType: "task", entityId: taskId, content: `@BobDistinct${stamp} can you loop in @JohnSmith too?` });
    assert.deepEqual(mentionedUserIds, [bob], "the unambiguous mention must still resolve even in the same comment as an ambiguous one");
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} comment @mention checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("Comment @mention regression suite crashed:", err);
  process.exit(1);
});
