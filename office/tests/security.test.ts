import { test } from "node:test";
import assert from "node:assert/strict";
import { encrypt, decrypt, hash, equals, newKey } from "../server/security.js";
import { Store } from "../server/db.js";
import { loadConfig } from "../server/config.js";
import { testConfig, cleanup } from "./helpers.js";
test("Keys are encrypted with context; modified ciphertext cannot be opened", () => {
  const config = testConfig();
  try {
    const secret = newKey();
    const ciphertext = encrypt(secret, config.secretKey, "ajan-a");
    assert.notEqual(ciphertext, secret);
    assert.equal(decrypt(ciphertext, config.secretKey, "ajan-a"), secret);
    assert.throws(() => decrypt(ciphertext, config.secretKey, "ajan-b"));
    assert.throws(() => decrypt(ciphertext, "cd".repeat(32), "ajan-a"));
    const parts = ciphertext.split(".");
    parts[2] = Buffer.from("değiştirilmiş").toString("base64");
    assert.throws(() => decrypt(parts.join("."), config.secretKey, "ajan-a"));
    assert.equal(hash(secret).length, 64);
    assert.ok(equals(secret, secret));
    assert.ok(!equals(secret, secret + "x"));
  } finally {
    cleanup(config);
  }
});
test("Versioned installation preserves data and requires keys/passwords", () => {
  const config = testConfig();
  try {
    const store = new Store(config.dataDir);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM migrations").get()!.n,
      17,
    );
    store.db
      .prepare("UPDATE company_rules SET text=?")
      .run("Kalıcılık kontrolü");
    // Recreate the previous schema so reopening exercises the A2.2 upgrade.
    store.db.exec(`DROP TABLE factory_resets; DROP TABLE reset_gate; ALTER TABLE runtime_settings DROP COLUMN language_initialized; ALTER TABLE runtime_settings DROP COLUMN email_domain_seeded; DROP TABLE director_followups; ALTER TABLE runs DROP COLUMN director_followup; ALTER TABLE runs DROP COLUMN context_peak; DROP TABLE director_terminal; DROP TABLE director_actions; DROP TABLE director_redirects; DROP TABLE director_watches; DROP TABLE director_events; DROP TABLE director_state; DROP TABLE office_trash; DROP TABLE dismissed_notices; DROP INDEX agents_builtin; ALTER TABLE agents DROP COLUMN builtin; ALTER TABLE agents DROP COLUMN tool_groups; ALTER TABLE agents DROP COLUMN deleted_at; ALTER TABLE departments DROP COLUMN deleted_at; ALTER TABLE runs DROP COLUMN work_options; ALTER TABLE runs DROP COLUMN director_auto; DROP TABLE schedule_retirements; DROP TABLE schedule_history; DROP TABLE scheduled_tasks; ALTER TABLE runs DROP COLUMN scheduled_task_id; ALTER TABLE chains DROP COLUMN scheduled_token_budget; DROP TABLE tududi_profiles; DROP TABLE daily_summaries; DROP TABLE blockers; DROP TABLE shared_notes; DROP TABLE notebook_writes; DROP TABLE notebook_marks; DROP TABLE notebook_cache; DROP TABLE work_items; DROP TABLE login_tickets; DROP TABLE profile_deletions; DROP TABLE command_jobs; DROP TABLE command_links; DROP TABLE provider_pauses; DROP TABLE agent_sessions;
      ALTER TABLE runs DROP COLUMN budget_retry; ALTER TABLE runs DROP COLUMN parent_run_id;
      ALTER TABLE runs DROP COLUMN work_item_id; ALTER TABLE runs DROP COLUMN session_generation; ALTER TABLE runs DROP COLUMN session_action;
      ALTER TABLE runs DROP COLUMN prompt_rules_hash; ALTER TABLE runs DROP COLUMN session_counted_tokens;
      DROP INDEX agents_username; ALTER TABLE agents DROP COLUMN username; ALTER TABLE agents DROP COLUMN session_mode; ALTER TABLE agents DROP COLUMN watch_tasks; ALTER TABLE agents DROP COLUMN watch_due; ALTER TABLE agents DROP COLUMN workbook_uid;
      ALTER TABLE events DROP COLUMN conversation_type;
      ALTER TABLE events DROP COLUMN conversation_id;
      ALTER TABLE events DROP COLUMN run_id;
      ALTER TABLE events DROP COLUMN message_id;
      ALTER TABLE events DROP COLUMN sender_name;
      DROP TABLE handoff_topics;
      DROP TABLE transfers;
      DROP TABLE department_greeters;
      ALTER TABLE runs DROP COLUMN message_id;
      ALTER TABLE runs DROP COLUMN handoff_id;
      ALTER TABLE runs DROP COLUMN priority;
      ALTER TABLE runs DROP COLUMN not_before;
      ALTER TABLE runs DROP COLUMN startup_retry;
      ALTER TABLE messages DROP COLUMN response_note;
      ALTER TABLE messages DROP COLUMN artifact_ids;
      DROP TABLE tududi_deletions;
      ALTER TABLE runs DROP COLUMN smoke_timeout_seconds;
      ALTER TABLE chains DROP COLUMN stop_reason;
      ALTER TABLE chains DROP COLUMN stopped_at;
      ALTER TABLE chains DROP COLUMN message_id;
      ALTER TABLE chains DROP COLUMN event_id;
      DELETE FROM migrations WHERE version>=6;`);
    assert.equal(store.db.prepare("SELECT MAX(version) AS n FROM migrations").get()!.n, 5);
    store.close();
    const reopened = new Store(config.dataDir);
    assert.equal(reopened.rules(), "Kalıcılık kontrolü");
    assert.equal(
      reopened.db.prepare("SELECT COUNT(*) AS n FROM migrations").get()!.n,
      17,
    );
    reopened.close();
    assert.throws(() => loadConfig({}));
    assert.throws(() =>
      loadConfig({
        OFIS_SECRET_KEY: config.secretKey,
        OFIS_OWNER_PASSWORD: "kisa",
      }),
    );
    assert.throws(() =>
      loadConfig({
        OFIS_SECRET_KEY: config.secretKey,
        OFIS_OWNER_PASSWORD: config.ownerPassword,
        TUDUDI_BASE_URL: "http://127.0.0.1:9292",
      }),
    );
  } finally {
    cleanup(config);
  }
});
