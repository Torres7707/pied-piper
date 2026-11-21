import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AdapterError,
  createAdapterResolver,
  createClaudeAdapter,
  createCodexAdapter,
} from '../src/adapters.js'
import type { RoleConfig } from '../src/config.js'
import { runRole } from '../src/runner.js'
import { runCli } from '../src/cli.js'
import type { PiedPiperConfig } from '../src/config.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'piedpiper-adapter-test-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeScript(dir: string, name: string, code: string): string {
  const filePath = path.join(dir, name)
  writeFileSync(filePath, code, 'utf8')
  return filePath
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('createClaudeAdapter', () => {
  it('constructs non-shell argv with model, resume session, read-only permission mode, and parses JSON output', async () => {
    const dir = makeTempDir()
    const sentinel = path.join(dir, 'pwned.txt')
    const script = writeScript(
      dir,
      'fake-claude.mjs',
      `
const argv = process.argv.slice(2);
const payload = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: JSON.stringify({ argv, cwd: process.cwd() }),
  session_id: 'claude-sess-42',
  usage: {
    input_tokens: 120,
    cache_creation_input_tokens: 30,
    cache_read_input_tokens: 50,
    output_tokens: 45,
  },
};
process.stdout.write(JSON.stringify(payload));
`,
    )

    const adapter = createClaudeAdapter({
      command: process.execPath,
      baseArgs: [script],
    })

    const trickyPrompt = `Review PR #10\n$HOME $(uname) "quotes"; touch "${sentinel}"`
    const response = await adapter.run({
      prompt: trickyPrompt,
      cwd: dir,
      model: 'claude-opus-5-5',
      sessionId: 'prev-sess-1',
      access: 'read',
      timeoutMs: 5000,
    })

    expect(existsSync(sentinel)).toBe(false)
    expect(response.sessionId).toBe('claude-sess-42')
    expect(response.usage).toEqual({ inputTokens: 200, outputTokens: 45 })

    const observed = JSON.parse(response.reply) as { argv: string[]; cwd: string }
    expect(observed.argv).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'claude-opus-5-5',
      '--resume',
      'prev-sess-1',
      '--permission-mode',
      'plan',
      '--',
      trickyPrompt,
    ])
  })

  it('uses acceptEdits permission mode for write access and handles missing usage or plain-text fallback', async () => {
    const dir = makeTempDir()
    const jsonNoUsageScript = writeScript(
      dir,
      'claude-no-usage.mjs',
      `
const argv = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  result: argv.includes('acceptEdits') ? 'write-ok' : 'missing-mode',
  session_id: 'sess-write-1',
}));
`,
    )

    const jsonAdapter = createClaudeAdapter({
      command: process.execPath,
      baseArgs: [jsonNoUsageScript],
    })

    const res1 = await jsonAdapter.run({
      prompt: 'implement feature',
      cwd: dir,
      access: 'write',
      timeoutMs: 5000,
    })
    expect(res1).toEqual({
      reply: 'write-ok',
      sessionId: 'sess-write-1',
      usage: undefined,
    })

    const plainTextScript = writeScript(
      dir,
      'claude-text.mjs',
      'process.stdout.write("plain reply from claude\\n");',
    )
    const textAdapter = createClaudeAdapter({
      command: process.execPath,
      baseArgs: [plainTextScript],
    })
    const res2 = await textAdapter.run({
      prompt: 'hello',
      cwd: dir,
      timeoutMs: 5000,
    })
    expect(res2).toEqual({
      reply: 'plain reply from claude',
      sessionId: undefined,
      usage: undefined,
    })
  })

  it('throws diagnostic AdapterError on is_error, non-zero exit code, timeout, or missing binary', async () => {
    const dir = makeTempDir()

    const isErrorScript = writeScript(
      dir,
      'claude-json-error.mjs',
      'process.stdout.write(JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" }));',
    )
    const errAdapter = createClaudeAdapter({
      command: process.execPath,
      baseArgs: [isErrorScript],
    })
    await expect(
      errAdapter.run({ prompt: 'hi', cwd: dir, timeoutMs: 5000 }),
    ).rejects.toThrow(/Not logged in/i)

    const nonZeroScript = writeScript(
      dir,
      'claude-fail.mjs',
      'process.stderr.write("authentication expired"); process.exit(3);',
    )
    const failAdapter = createClaudeAdapter({
      command: process.execPath,
      baseArgs: [nonZeroScript],
    })
    await expect(
      failAdapter.run({ prompt: 'hi', cwd: dir, timeoutMs: 5000 }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof AdapterError &&
        err.exitCode === 3 &&
        err.stderr.includes('authentication expired') &&
        err.timedOut === false
      )
    })

    const hangScript = writeScript(dir, 'claude-hang.mjs', 'setTimeout(() => {}, 30000);')
    const hangAdapter = createClaudeAdapter({
      command: process.execPath,
      baseArgs: [hangScript],
    })
    await expect(
      hangAdapter.run({ prompt: 'hi', cwd: dir, timeoutMs: 100 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof AdapterError && err.timedOut === true)

    const missingAdapter = createClaudeAdapter({
      command: 'piedpiper-missing-claude-cli',
    })
    await expect(
      missingAdapter.run({ prompt: 'hi', cwd: dir, timeoutMs: 5000 }),
    ).rejects.toThrow(AdapterError)
  })
})

describe('createCodexAdapter', () => {
  it('constructs codex exec argv with sandbox, cwd, model, isolated prompt, and parses JSONL events', async () => {
    const dir = makeTempDir()
    const sentinel = path.join(dir, 'codex-pwned.txt')
    const script = writeScript(
      dir,
      'fake-codex.mjs',
      `
const argv = process.argv.slice(2);
const lines = [
  JSON.stringify({ type: 'thread.started', thread_id: 'thread-abc-99' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } }),
  JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'first draft' } }),
  JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: JSON.stringify(argv) } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 310, cached_input_tokens: 100, output_tokens: 72 } }),
];
process.stdout.write(lines.join('\\n') + '\\n');
`,
    )

    const adapter = createCodexAdapter({
      command: process.execPath,
      baseArgs: [script],
    })

    const trickyPrompt = `Diff review\n$(whoami) $PATH; rm -rf "${sentinel}"`
    const response = await adapter.run({
      prompt: trickyPrompt,
      cwd: dir,
      model: 'gpt-5-codex',
      access: 'read',
      timeoutMs: 5000,
    })

    expect(existsSync(sentinel)).toBe(false)
    expect(response.sessionId).toBe('thread-abc-99')
    expect(response.usage).toEqual({ inputTokens: 310, outputTokens: 72 })
    expect(JSON.parse(response.reply)).toEqual([
      'exec',
      '--json',
      '-C',
      dir,
      '-m',
      'gpt-5-codex',
      '-s',
      'read-only',
      '--',
      trickyPrompt,
    ])
  })

  it('constructs codex exec resume argv when sessionId is provided and workspace-write for write access', async () => {
    const dir = makeTempDir()
    const script = writeScript(
      dir,
      'fake-codex-resume.mjs',
      `
const argv = process.argv.slice(2);
process.stdout.write([
  JSON.stringify({ type: 'thread.started', thread_id: 'thread-resumed-2' }),
  JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: JSON.stringify(argv) } }),
  JSON.stringify({ type: 'turn.completed' }),
].join('\\n'));
`,
    )

    const adapter = createCodexAdapter({
      command: process.execPath,
      baseArgs: [script],
    })

    const resumed = await adapter.run({
      prompt: 'follow up',
      cwd: dir,
      model: 'gpt-5-codex',
      sessionId: 'thread-prev-1',
      access: 'write',
      timeoutMs: 5000,
    })

    expect(resumed.sessionId).toBe('thread-resumed-2')
    expect(resumed.usage).toBeUndefined()
    expect(JSON.parse(resumed.reply)).toEqual([
      'exec',
      'resume',
      '--json',
      '-m',
      'gpt-5-codex',
      'thread-prev-1',
      'follow up',
    ])

    const writeNew = await adapter.run({
      prompt: 'fresh write',
      cwd: dir,
      access: 'write',
      timeoutMs: 5000,
    })
    expect(JSON.parse(writeNew.reply)).toEqual([
      'exec',
      '--json',
      '-C',
      dir,
      '-s',
      'workspace-write',
      '--',
      'fresh write',
    ])
  })

  it('throws diagnostic AdapterError on turn.failed, non-zero exit code, timeout, or missing binary', async () => {
    const dir = makeTempDir()

    const failedEventScript = writeScript(
      dir,
      'codex-turn-failed.mjs',
      `
process.stdout.write([
  JSON.stringify({ type: 'thread.started', thread_id: 't-1' }),
  JSON.stringify({ type: 'turn.failed', error: { message: 'login required' } }),
].join('\\n'));
`,
    )
    const failedEventAdapter = createCodexAdapter({
      command: process.execPath,
      baseArgs: [failedEventScript],
    })
    await expect(
      failedEventAdapter.run({ prompt: 'hi', cwd: dir, timeoutMs: 5000 }),
    ).rejects.toThrow(/login required/i)

    const exitFailScript = writeScript(
      dir,
      'codex-exit-fail.mjs',
      'process.stderr.write("not authenticated"); process.exit(1);',
    )
    const exitFailAdapter = createCodexAdapter({
      command: process.execPath,
      baseArgs: [exitFailScript],
    })
    await expect(
      exitFailAdapter.run({ prompt: 'hi', cwd: dir, timeoutMs: 5000 }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof AdapterError &&
        err.exitCode === 1 &&
        err.stderr.includes('not authenticated')
      )
    })

    const hangScript = writeScript(dir, 'codex-hang.mjs', 'setTimeout(() => {}, 30000);')
    const hangAdapter = createCodexAdapter({
      command: process.execPath,
      baseArgs: [hangScript],
    })
    await expect(
      hangAdapter.run({ prompt: 'hi', cwd: dir, timeoutMs: 100 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof AdapterError && err.timedOut === true)

    const missingAdapter = createCodexAdapter({
      command: 'piedpiper-missing-codex-cli',
    })
    await expect(
      missingAdapter.run({ prompt: 'hi', cwd: dir, timeoutMs: 5000 }),
    ).rejects.toThrow(AdapterError)
  })
})

describe('createAdapterResolver with claude, codex, and command roles', () => {
  it('wires claude and codex adapters by default without throwing not-wired error and forwards role access in runRole', async () => {
    const dir = makeTempDir()
    const dineshPrompt = path.join(dir, 'dinesh.md')
    const gilfoylePrompt = path.join(dir, 'gilfoyle.md')
    writeFileSync(dineshPrompt, '# Dinesh', 'utf8')
    writeFileSync(gilfoylePrompt, '# Gilfoyle', 'utf8')

    const claudeScript = writeScript(
      dir,
      'claude-shim.mjs',
      'process.stdout.write(JSON.stringify({ result: process.argv.slice(2).join(" "), session_id: "c1" }));',
    )
    const codexScript = writeScript(
      dir,
      'codex-shim.mjs',
      'process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: process.argv.slice(2).join(" ") } }));',
    )

    const config: PiedPiperConfig = {
      roles: {
        dinesh: {
          adapter: 'claude',
          model: 'claude-sonnet-5-5',
          skills: ['tdd'],
          parallel: 2,
          access: 'write',
          prompt: 'roles/dinesh.md',
          promptPath: dineshPrompt,
        },
        gilfoyle: {
          adapter: 'codex',
          model: 'gpt-5-codex',
          skills: ['code-review'],
          parallel: 1,
          access: 'read',
          prompt: 'roles/gilfoyle.md',
          promptPath: gilfoylePrompt,
        },
        helper: {
          adapter: 'command',
          skills: [],
          parallel: 1,
          access: 'read',
          prompt: 'roles/gilfoyle.md',
          promptPath: gilfoylePrompt,
          command: [process.execPath, '-e', 'process.stdout.write("cmd-ok")'],
        },
      },
      runtime: {
        notifications: { desktop: false, githubMention: false, githubHandle: '' },
        review: { maxRounds: 2, validateOutput: true },
        dispatcher: { maxHops: 8, pollIntervalSec: 60 },
        eventLog: { type: 'jsonl', path: '.piedpiper/events.jsonl' },
      },
    }

    const defaultResolver = createAdapterResolver()
    expect(() =>
      defaultResolver('dinesh', config.roles.dinesh as RoleConfig),
    ).not.toThrow()
    expect(() =>
      defaultResolver('gilfoyle', config.roles.gilfoyle as RoleConfig),
    ).not.toThrow()
    expect(() =>
      defaultResolver('helper', config.roles.helper as RoleConfig),
    ).not.toThrow()

    const resolverWithTestShims = createAdapterResolver(undefined, {
      claude: { command: process.execPath, baseArgs: [claudeScript] },
      codex: { command: process.execPath, baseArgs: [codexScript] },
    })

    const dineshResult = await runRole({
      repoRoot: dir,
      config,
      roleName: 'dinesh',
      target: '#4',
      resolveAdapter: resolverWithTestShims,
    })
    expect(dineshResult.reply).toContain('--permission-mode acceptEdits')
    expect(dineshResult.sessionId).toBe('c1')

    const gilfoyleResult = await runRole({
      repoRoot: dir,
      config,
      roleName: 'gilfoyle',
      target: 'PR #11',
      resolveAdapter: resolverWithTestShims,
    })
    expect(gilfoyleResult.reply).toContain('-s read-only')
  })

  it('triggers claude, codex, and command roles via piedpiper run CLI', async () => {
    const repoRoot = makeTempDir('piedpiper-cli-adapters-')
    const piedpiperDir = path.join(repoRoot, '.piedpiper')
    mkdirSync(path.join(piedpiperDir, 'roles'), { recursive: true })
    writeFileSync(path.join(piedpiperDir, 'roles/dinesh.md'), '# Dinesh', 'utf8')
    writeFileSync(path.join(piedpiperDir, 'roles/gilfoyle.md'), '# Gilfoyle', 'utf8')

    const claudeScript = writeScript(
      repoRoot,
      'cli-claude.mjs',
      'process.stdout.write(JSON.stringify({ result: "cli-claude-ok" }));',
    )
    const codexScript = writeScript(
      repoRoot,
      'cli-codex.mjs',
      'process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "cli-codex-ok" } }));',
    )

    writeFileSync(
      path.join(piedpiperDir, 'config.json'),
      JSON.stringify({
        roles: {
          dinesh: { adapter: 'claude', model: 'claude-sonnet-5-5', access: 'write', prompt: 'roles/dinesh.md' },
          gilfoyle: { adapter: 'codex', model: 'gpt-5-codex', access: 'read', prompt: 'roles/gilfoyle.md' },
        },
      }),
      'utf8',
    )

    let dineshOut = ''
    const code1 = await runCli(['run', 'dinesh', '#4', '--repo', repoRoot], {
      stdout: (c) => { dineshOut += c },
      stderr: () => {},
      adapterDefaults: { claude: { command: process.execPath, baseArgs: [claudeScript] } },
    })
    expect(code1).toBe(0)
    expect(dineshOut.trim()).toBe('cli-claude-ok')

    let gilfoyleOut = ''
    const code2 = await runCli(['run', 'gilfoyle', 'PR #11', '--repo', repoRoot], {
      stdout: (c) => { gilfoyleOut += c },
      stderr: () => {},
      adapterDefaults: { codex: { command: process.execPath, baseArgs: [codexScript] } },
    })
    expect(code2).toBe(0)
    expect(gilfoyleOut.trim()).toBe('cli-codex-ok')
  })
})
