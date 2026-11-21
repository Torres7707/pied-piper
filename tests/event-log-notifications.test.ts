import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AdapterError, type Adapter } from '../src/adapters.js'
import { runCli } from '../src/cli.js'
import { ConfigValidationError, loadConfig } from '../src/config.js'
import { createJsonlEventLog, type EventLogEntry } from '../src/event-log.js'
import { createInMemoryGitHubPort } from '../src/github.js'
import { createNotifier, type DesktopNotificationPayload } from '../src/notifications.js'

const tempDirs: string[] = []

function makeTestRepo(runtimeConfig?: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'piedpiper-evt-test-'))
  tempDirs.push(root)
  const piedpiperDir = path.join(root, '.piedpiper')
  mkdirSync(path.join(piedpiperDir, 'roles'), { recursive: true })
  writeFileSync(path.join(piedpiperDir, 'roles', 'dinesh.md'), '# Dinesh', 'utf8')
  writeFileSync(
    path.join(piedpiperDir, 'config.json'),
    JSON.stringify(
      {
        roles: {
          dinesh: {
            adapter: 'claude',
            model: 'claude-sonnet-5-5',
            skills: ['tdd'],
            parallel: 2,
            access: 'write',
            prompt: 'roles/dinesh.md',
          },
        },
        ...(runtimeConfig ? { runtime: runtimeConfig } : {}),
      },
      null,
      2,
    ),
    'utf8',
  )
  return root
}

function parseJsonl(filePath: string): EventLogEntry[] {
  const raw = readFileSync(filePath, 'utf8').trim()
  if (raw.length === 0) return []
  return raw.split('\n').map((line) => JSON.parse(line) as EventLogEntry)
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('JSONL event log and piedpiper run integration', () => {
  it('appends valid JSON lines with run metadata, usage, and status, and recreates the log if deleted or cleared', async () => {
    const repoRoot = makeTestRepo({
      notifications: { desktop: false, githubMention: false, githubHandle: '' },
      eventLog: { type: 'jsonl', path: '.piedpiper/logs/events.jsonl' },
    })
    const logPath = path.join(repoRoot, '.piedpiper', 'logs', 'events.jsonl')
    expect(existsSync(logPath)).toBe(false)

    const okAdapter: Adapter = {
      async run() {
        return {
          reply: 'done #6',
          sessionId: 'sess-6',
          usage: { inputTokens: 120, outputTokens: 35 },
        }
      },
    }

    const code1 = await runCli(['run', 'dinesh', '#6', '--repo', repoRoot], {
      stdout: () => {},
      stderr: () => {},
      adapterOverrides: { dinesh: okAdapter },
    })
    expect(code1).toBe(0)
    expect(existsSync(logPath)).toBe(true)

    const entries1 = parseJsonl(logPath)
    expect(entries1.map((e) => e.type)).toEqual(['run.started', 'run.completed'])
    const completed = entries1[1]!
    expect(completed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(completed.role).toBe('dinesh')
    expect(completed.target).toBe('#6')
    expect(completed.adapter).toBe('claude')
    expect(completed.model).toBe('claude-sonnet-5-5')
    expect(completed.status).toBe('ok')
    expect(completed.usage).toEqual({ inputTokens: 120, outputTokens: 35 })

    // Delete log file and verify next run recreates it cleanly without error
    unlinkSync(logPath)
    expect(existsSync(logPath)).toBe(false)

    const code2 = await runCli(['run', 'dinesh', '#7', '--repo', repoRoot], {
      stdout: () => {},
      stderr: () => {},
      adapterOverrides: { dinesh: okAdapter },
    })
    expect(code2).toBe(0)
    const entries2 = parseJsonl(logPath)
    expect(entries2).toHaveLength(2)
    expect(entries2[1]!.target).toBe('#7')

    // Truncate log file to empty and verify reading returns [] and appending continues cleanly
    writeFileSync(logPath, '', 'utf8')
    const log = createJsonlEventLog(logPath)
    expect(await log.readEvents()).toEqual([])
    await log.append({
      timestamp: new Date().toISOString(),
      type: 'dispatcher.halted',
      decision: 'hop limit reached',
      hop: 8,
    })
    const entries3 = parseJsonl(logPath)
    expect(entries3).toHaveLength(1)
    expect(entries3[0]!.hop).toBe(8)
  })

  it('logs run.failed and notifies configured channels when piedpiper run fails', async () => {
    const repoRoot = makeTestRepo({
      notifications: { desktop: true, githubMention: true, githubHandle: 'torres7707' },
    })
    const logPath = path.join(repoRoot, '.piedpiper', 'events.jsonl')

    const github = createInMemoryGitHubPort({
      issues: [
        {
          number: 6,
          title: 'Ticket 6',
          body: 'Do work',
          state: 'OPEN',
          labels: ['ready-for-agent'],
          blockedBy: [],
        },
      ],
    })

    const desktopPayloads: DesktopNotificationPayload[] = []
    const failingAdapter: Adapter = {
      async run() {
        throw new AdapterError('CLI crashed', { exitCode: 1, stderr: 'boom' })
      },
    }

    const loaded = await loadConfig(repoRoot)
    const notifier = createNotifier({
      config: loaded.config.runtime.notifications,
      github,
      desktopSender: async (payload) => {
        desktopPayloads.push(payload)
      },
    })

    let stderr = ''
    const code = await runCli(['run', 'dinesh', '#6', '--repo', repoRoot], {
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk
      },
      adapterOverrides: { dinesh: failingAdapter },
      github,
      notifier,
    })

    expect(code).toBe(1)
    expect(stderr).toContain('CLI crashed')

    const entries = parseJsonl(logPath)
    expect(entries.map((e) => e.type)).toEqual(['run.started', 'run.failed'])
    expect(entries[1]!.status).toBe('failed')
    expect(entries[1]!.error).toContain('CLI crashed')

    expect(desktopPayloads).toHaveLength(1)
    expect(desktopPayloads[0]!.body).toContain('CLI crashed')
    const comments = github.getIssueComments(6)
    expect(comments).toHaveLength(1)
    expect(comments[0]).toContain('@torres7707')
    expect(comments[0]).toContain('CLI crashed')
  })
})

describe('createNotifier channel combinations', () => {
  it('supports desktop-only, githubMention-only, both-enabled, and silent modes', async () => {
    const github = createInMemoryGitHubPort({
      issues: [
        {
          number: 10,
          title: 'Need decision',
          body: 'Waiting',
          state: 'OPEN',
          labels: ['ready-for-human'],
          blockedBy: [],
        },
      ],
    })

    const desktopCalls: DesktopNotificationPayload[] = []
    const desktopSender = async (payload: DesktopNotificationPayload) => {
      desktopCalls.push(payload)
    }

    // 1. Desktop only
    const desktopOnly = createNotifier({
      config: { desktop: true, githubMention: false, githubHandle: '' },
      github,
      desktopSender,
    })
    await desktopOnly.notify({
      title: 'Pied Piper',
      body: 'Desktop alert',
      targetNumber: 10,
      reason: 'escalated',
    })
    expect(desktopCalls).toHaveLength(1)
    expect(github.getIssueComments(10)).toHaveLength(0)

    // 2. GitHub @ only
    const ghOnly = createNotifier({
      config: { desktop: false, githubMention: true, githubHandle: '@torres7707' },
      github,
      desktopSender,
    })
    await ghOnly.notify({
      title: 'Pied Piper',
      body: 'Need human review',
      targetNumber: 10,
      reason: 'escalated',
    })
    expect(desktopCalls).toHaveLength(1)
    expect(github.getIssueComments(10)).toHaveLength(1)
    expect(github.getIssueComments(10)[0]).toContain('@torres7707')
    expect(github.getIssueComments(10)[0]).not.toContain('@@')

    // 3. Both enabled
    const both = createNotifier({
      config: { desktop: true, githubMention: true, githubHandle: 'torres7707' },
      github,
      desktopSender,
    })
    await both.notify({
      title: 'Pied Piper',
      body: 'Both channels',
      targetNumber: 10,
      reason: 'hop_limit',
    })
    expect(desktopCalls).toHaveLength(2)
    expect(github.getIssueComments(10)).toHaveLength(2)

    // 4. Silent
    const silent = createNotifier({
      config: { desktop: false, githubMention: false, githubHandle: '' },
      github,
      desktopSender,
    })
    await silent.notify({
      title: 'Pied Piper',
      body: 'Should not send',
      targetNumber: 10,
      reason: 'noop',
    })
    expect(desktopCalls).toHaveLength(2)
    expect(github.getIssueComments(10)).toHaveLength(2)
  })

  it('rejects invalid eventLog or notification config fields during loadConfig', async () => {
    const badTypeRepo = makeTestRepo({
      eventLog: { type: 'sqlite', path: '.piedpiper/events.db' },
    })
    await expect(loadConfig(badTypeRepo)).rejects.toThrow(ConfigValidationError)

    const badMentionRepo = makeTestRepo({
      notifications: { desktop: false, githubMention: true, githubHandle: '   ' },
    })
    await expect(loadConfig(badMentionRepo)).rejects.toThrow(/githubHandle/i)

    const escapedLogRepo = makeTestRepo({
      eventLog: { type: 'jsonl', path: '../../outside.jsonl' },
    })
    await expect(loadConfig(escapedLogRepo)).rejects.toThrow(ConfigValidationError)
  })
})
