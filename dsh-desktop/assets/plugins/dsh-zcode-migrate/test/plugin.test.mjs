// Plugin-adapter contract tests.
//
// The dsh host loads this module and calls `apply(ctx, config)`. These tests
// assert the parts of that contract the host relies on: the exported shape, the
// tools that get registered, the behavior hints, and that a tool never throws
// at the model (errors come back as structured payloads).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { apply, name, inject, Config, SLASH_GUIDE } from '../src/index.js'
import { projectKey } from '../core/paths.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

/** A cordis context stub that records what the plugin registers. */
function mockContext() {
  const tools = []
  const sections = []
  const provided = {}
  return {
    tools: { register: (definition) => tools.push(definition) },
    systemPrompt: { section: (fn) => sections.push(fn) },
    provide: (key, value) => {
      provided[key] = value
    },
    logger: { warn() {} },
    registered: tools,
    sections,
    provided,
  }
}

test('the module exports the dsh plugin contract', () => {
  assert.equal(name, 'zcode-migrate')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
  assert.ok(Config, 'Config schema is exported')
  // The schema must satisfy Standard Schema v1 for hosts that validate it.
  assert.equal(typeof Config['~standard']?.validate, 'function')
})

test('apply registers the three tools with their behavior hints', () => {
  const ctx = mockContext()
  apply(ctx, {})
  assert.deepEqual(
    ctx.registered.map((tool) => tool.name).sort(),
    ['zcode.inspect', 'zcode.migrate', 'zcode.verify'],
  )
  const byName = Object.fromEntries(ctx.registered.map((tool) => [tool.name, tool]))
  assert.equal(byName['zcode.inspect'].behavior, 'read')
  assert.equal(byName['zcode.inspect'].readOnly, true)
  assert.equal(byName['zcode.inspect'].destructive, false)
  assert.equal(byName['zcode.migrate'].behavior, 'idempotent')
  assert.equal(byName['zcode.migrate'].idempotent, true)
  assert.equal(byName['zcode.verify'].behavior, 'read')
  for (const tool of ctx.registered) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 10)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.parameters.type, 'object')
  }
})

test('apply registers the slash-command guide and the service handle', () => {
  const ctx = mockContext()
  apply(ctx, {})
  assert.equal(ctx.sections.length, 1)
  assert.ok(SLASH_GUIDE.includes('/zcode migrate'))
  assert.ok(ctx.provided.zcodeMigrate)
  assert.equal(typeof ctx.provided.zcodeMigrate.migrate, 'function')
})

test('slashCommand: false skips the system-prompt section', () => {
  const ctx = mockContext()
  apply(ctx, { slashCommand: false })
  assert.equal(ctx.sections.length, 0)
})

test('the rendered output of a tool is a text content block', () => {
  const ctx = mockContext()
  apply(ctx, {})
  const tool = ctx.registered.find((entry) => entry.name === 'zcode.verify')
  const rendered = tool.output.render({}, { ok: true, eventCount: 3 })
  assert.equal(Array.isArray(rendered), true)
  assert.equal(rendered[0].type, 'text')
  assert.ok(rendered[0].text.includes('"eventCount": 3'))
})

test('a tool surfaces failures as a structured payload instead of throwing', async () => {
  const ctx = mockContext()
  apply(ctx, {})
  const verify = ctx.registered.find((entry) => entry.name === 'zcode.verify')
  const result = await verify.execute({ path: join(tmpdir(), 'definitely-not-here.jsonl.zstd') })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'NOT_FOUND')
  assert.ok(result.error.message)

  const missingArg = await verify.execute({})
  assert.equal(missingArg.ok, false)
  assert.equal(missingArg.error.code, 'CONFIG_ERROR')
})

test('plugin config reaches the tools as defaults', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-plugin-'))
  try {
    const dbPath = join(dir, 'db.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE session (id text primary key, project_id text, slug text, directory text,
        title text, version text, time_created integer, time_updated integer, task_type text,
        parent_id text, workspace_id text, path text, share_url text, summary_additions integer,
        summary_deletions integer, summary_files integer, summary_diffs text, revert text,
        permission text, time_compacting integer, time_archived integer, title_source text,
        title_message_id text, time_title_updated integer, trace_id text);
      CREATE TABLE message (id text primary key, session_id text, time_created integer,
        time_updated integer, data text, sequence integer);
      CREATE TABLE part (id text primary key, message_id text, session_id text,
        time_created integer, time_updated integer, data text, sequence integer);
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES ('sess_p1', 'p', 's', 'C:\\cfg', 'Configured', '1', 100, 100);
      INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
        VALUES ('m1', 'sess_p1', 100, 100, '{"role":"user","time":{"created":100}}', 0);
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
        VALUES ('pt1', 'm1', 'sess_p1', 100, 100, '{"type":"text","text":"hi"}', 0);
      INSERT INTO message (id, session_id, time_created, time_updated, data, sequence)
        VALUES ('m2', 'sess_p1', 101, 101, '{"role":"assistant","time":{"created":101},"finish":"stop"}', 1);
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence)
        VALUES ('pt2', 'm2', 'sess_p1', 101, 101, '{"type":"text","text":"ok"}', 0);
    `)
    db.close()

    const root = join(dir, 'sessions')
    const ctx = mockContext()
    apply(ctx, { dbPath, dshRoot: root })

    const inspectTool = ctx.registered.find((entry) => entry.name === 'zcode.inspect')
    const inspected = await inspectTool.execute({})
    assert.equal(inspected.ok, true)
    assert.equal(inspected.selected, 1, 'config dbPath is used when the model omits it')
    assert.equal(inspected.dshRoot, root)

    const migrateTool = ctx.registered.find((entry) => entry.name === 'zcode.migrate')
    const report = await migrateTool.execute({})
    assert.equal(report.migrated, 1)
    assert.ok(report.sessions[0].path.includes(projectKey('C:\\cfg')))
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
