import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdapterResolver, type Adapter } from '../src/adapters.js'
import { runCli } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { dispatchOnce } from '../src/dispatcher.js'
import { createJsonlEventLog, type EventLogEntry } from '../src/event-log.js'
import { createInMemoryGitHubPort } from '../src/github.js'
import { createNotifier, type DesktopNotificationPayload } from '../src/notifications.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'piedpiper-disp-test-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function setupDispatcherRepo(options?: {
  parallel?: number
  maxHops?: number
  notifications?: { desktop: boolean; githubMention: boolean; githubHandle: string }
}): { repoRoot: string; worktreeBaseDir: string } {
  const workspace = makeTempDir('piedpiper-disp-ws-')
  const remoteDir = path.join(workspace, 'remote.git')
  const repoRoot = path.join(workspace, 'repo')
  const worktreeBaseDir = path.join(workspace, 'worktrees')

  mkdirSync(remoteDir, { recursive: true })
  mkdirSync(repoRoot, { recursive: true })
  mkdirSync(worktreeBaseDir, { recursive: true })

  git(remoteDir, 'init', '--bare', '--initial-branch=main')
  git(repoRoot, 'init', '--initial-branch=main')
  git(repoRoot, 'config', 'user.name', 'Test User')
  git(repoRoot, 'config', 'user.email', 'test@example.com')

  mkdirSync(path.join(repoRoot, '.piedpiper', 'roles'), { recursive: true })
  writeFileSync(path.join(repoRoot, '.piedpiper', 'roles', 'dinesh.md'), '# Dinesh', 'utf8')
  writeFileSync(path.join(repoRoot, '.piedpiper', 'roles', 'gilfoyle.md'), '# Gilfoyle', 'utf8')
  writeFileSync(
    path.join(repoRoot, '.piedpiper', 'config.json'),
    JSON.stringify(
      {
        roles: {
          dinesh: {
            adapter: 'claude',
            model: 'claude-sonnet-5-5',
            skills: ['tdd'],
            parallel: options?.parallel ?? 2,
            access: 'write',
            prompt: 'roles/dinesh.md',
          },
          gilfoyle: {
            adapter: 'codex',
            model: 'gpt-5-codex',
            skills: ['code-review'],
            parallel: 1,
            access: 'read',
            prompt: 'roles/gilfoyle.md',
          },
        },
        runtime: {
          notifications: options?.notifications ?? {
            desktop: true,
            githubMention: true,
            githubHandle: 'torres7707',
          },
          review: { maxRounds: 2, validateOutput: false },
          dispatcher: { maxHops: options?.maxHops ?? 8, pollIntervalSec: 1 },
          eventLog: { type: 'jsonl', path: '.piedpiper/events.jsonl' },
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  git(repoRoot, 'add', '.')
  git(repoRoot, 'commit', '-m', 'chore: init')
  git(repoRoot, 'remote', 'add', 'origin', remoteDir)
  git(repoRoot, 'push', '-u', 'origin', 'main')

  return { repoRoot, worktreeBaseDir }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('Stateless Dispatcher', () => {
  it('excludes blocked ready-for-agent issues from frontier until all blockers close, then dispatches Dinesh', async () => {
    const { repoRoot, worktreeBaseDir } = setupDispatcherRepo()
    const loaded = await loadConfig(repoRoot)
    const github = createInMemoryGitHubPort({
      issues: [
        {
          number: 2,
          title: 'Blocker issue',
          body: 'Must finish first',
          state: 'OPEN',
          labels: ['ready-for-agent', 'in-review'],
          blockedBy: [],
        },
        {
          number: 3,
          title: 'Dependent ticket',
          body: 'Blocked by #2',
          state: 'OPEN',
          labels: ['ready-for-agent'],
          blockedBy: [{ number: 2, state: 'OPEN', title: 'Blocker issue' }],
        },
      ],
    })

    const dineshTargets: string[] = []
    const resolveAdapter = createAdapterResolver({
      dinesh: {
        async run(req) {
          dineshTargets.push(req.cwd)
          writeFileSync(path.join(req.cwd, 'impl.txt'), 'done\n', 'utf8')
          git(req.cwd, 'add', 'impl.txt')
          git(req.cwd, 'commit', '-m', 'feat: impl #3')
          return { reply: 'done' }
        },
      },
      gilfoyle: {
        async run() {
          return { reply: '## 评审结论：通过\n- **核对范围**：`impl.txt`\n- **验收标准核对**：通过。' }
        },
      },
    })

    const cycle1 = await dispatchOnce({
      repoRoot,
      config: loaded.config,
      github,
      resolveAdapter,
      worktreeBaseDir,
    })
    expect(cycle1.dispatchedDinesh).toEqual([])
    expect(dineshTargets).toEqual([])

    // Close blocker #2 -> #3 enters frontier in next cycle
    github.closeIssue(2)

    const cycle2 = await dispatchOnce({
      repoRoot,
      config: loaded.config,
      github,
      resolveAdapter,
      worktreeBaseDir,
    })
    expect(cycle2.dispatchedDinesh).toEqual([3])
    expect(dineshTargets).toHaveLength(1)
  })

  it('marks claimed frontier issues in-progress immediately to prevent concurrent preemption and enforces parallel limit', async () => {
    const { repoRoot, worktreeBaseDir } = setupDispatcherRepo({ parallel: 2 })
    const loaded = await loadConfig(repoRoot)
    const github = createInMemoryGitHubPort({
      issues: [
        {
          number: 10,
          title: 'Already in progress',
          body: 'Running elsewhere',
          state: 'OPEN',
          labels: ['ready-for-agent', 'in-progress'],
          blockedBy: [],
        },
        {
          number: 11,
          title: 'Frontier A',
          body: 'Task A',
          state: 'OPEN',
          labels: ['ready-for-agent'],
          blockedBy: [],
        },
        {
          number: 12,
          title: 'Frontier B',
          body: 'Task B',
          state: 'OPEN',
          labels: ['ready-for-agent'],
          blockedBy: [],
        },
      ],
    })

    let releaseFirstDinesh!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      // resolved inside adapter
      void resolve
    })
    let markFirstStarted!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const pausePromise = new Promise<void>((resolve) => {
      releaseFirstDinesh = resolve
    })
    void firstStarted

    const startedRuns: string[] = []
    const slowDinesh: Adapter = {
      async run(req) {
        startedRuns.push(req.cwd)
        markFirstStarted()
        await pausePromise
        return { reply: 'finished without commit' }
      },
    }

    const resolveAdapter = createAdapterResolver({ dinesh: slowDinesh })

    // Start first dispatchOnce; #10 is already in-progress so only 1 slot remains -> claims #11
    const firstRunPromise = dispatchOnce({
      repoRoot,
      config: loaded.config,
      github,
      resolveAdapter,
      worktreeBaseDir,
    })

    await startedPromise
    // Verify #11 already has in-progress label while Dinesh is still running
    const issue11 = await github.getIssue(11)
    expect(issue11.labels).toContain('in-progress')

    // A second overlapping dispatchOnce sees #10 and #11 both in-progress (2 == parallel) -> claims nothing (not #11, not #12)
    const overlapping = await dispatchOnce({
      repoRoot,
      config: loaded.config,
      github,
      resolveAdapter,
      worktreeBaseDir,
    })
    expect(overlapping.dispatchedDinesh).toEqual([])
    expect(startedRuns).toHaveLength(1)

    releaseFirstDinesh()
    const firstResult = await firstRunPromise
    expect(firstResult.dispatchedDinesh).toEqual([11])
  })

  it('transitions issue from in-progress to in-review when PR opens and triggers Gilfoyle, recovering even if event log is deleted', async () => {
    const { repoRoot, worktreeBaseDir } = setupDispatcherRepo()
    const loaded = await loadConfig(repoRoot)
    const logPath = path.join(repoRoot, loaded.config.runtime.eventLog.path)
    const eventLog = createJsonlEventLog(logPath)

    const github = createInMemoryGitHubPort({
      issues: [
        {
          number: 20,
          title: 'Ticket 20',
          body: 'Needs review',
          state: 'OPEN',
          labels: ['ready-for-agent', 'in-progress'],
          blockedBy: [],
        },
      ],
      pullRequests: [
        {
          number: 55,
          title: 'feat: ticket 20',
          body: 'Closes #20',
          state: 'OPEN',
          headRefName: 'ticket/20',
          baseRefName: 'main',
          linkedIssueNumbers: [20],
          diff: 'diff --git a/x.ts b/x.ts\n+export const z = 1\n',
        },
      ],
    })

    // Seed some event log then delete it completely before dispatching
    await eventLog.append({
      timestamp: new Date().toISOString(),
      type: 'run.started',
      role: 'dinesh',
      target: '#20',
    })
    unlinkSync(logPath)

    const gilfoyleReviewed: string[] = []
    const resolveAdapter = createAdapterResolver({
      gilfoyle: {
        async run(req) {
          gilfoyleReviewed.push(req.prompt)
          return {
            reply: '## 评审结论：通过\n- **核对范围**：`x.ts`\n- **验收标准核对**：通过。',
          }
        },
      },
    })

    const result = await dispatchOnce({
      repoRoot,
      config: loaded.config,
      github,
      resolveAdapter,
      worktreeBaseDir,
      eventLog,
    })

    expect(result.dispatchedDinesh).toEqual([])
    expect(result.dispatchedGilfoyle).toEqual([55])
    expect(gilfoyleReviewed).toHaveLength(1)

    const updatedIssue = await github.getIssue(20)
    expect(updatedIssue.labels).not.toContain('in-progress')
    expect(updatedIssue.labels).toContain('in-review')

    const reviews = await github.listPullRequestReviews(55)
    expect(reviews).toHaveLength(1)
  })

  it('halts dispatching, logs dispatcher.halted, and notifies developer when hop limit (default 8) is reached', async () => {
    const { repoRoot, worktreeBaseDir } = setupDispatcherRepo({ maxHops: 8 })
    const loaded = await loadConfig(repoRoot)
    const logPath = path.join(repoRoot, loaded.config.runtime.eventLog.path)
    const eventLog = createJsonlEventLog(logPath)

    const github = createInMemoryGitHubPort({
      issues: [
        {
          number: 30,
          title: 'Hop limit ticket',
          body: 'Should halt at hop 8',
          state: 'OPEN',
          labels: ['ready-for-agent'],
          blockedBy: [],
        },
      ],
    })

    const desktopAlerts: DesktopNotificationPayload[] = []
    const notifier = createNotifier({
      config: loaded.config.runtime.notifications,
      github,
      desktopSender: async (p) => {
        desktopAlerts.push(p)
      },
    })

    let adapterCalled = false
    const resolveAdapter = createAdapterResolver({
      dinesh: {
        async run() {
          adapterCalled = true
          return { reply: 'should not run' }
        },
      },
    })

    const result = await dispatchOnce({
      repoRoot,
      config: loaded.config,
      github,
      resolveAdapter,
      worktreeBaseDir,
      eventLog,
      notifier,
      hop: 8,
    })

    expect(result.halted).toBe(true)
    expect(result.dispatchedDinesh).toEqual([])
    expect(adapterCalled).toBe(false)

    const events = await eventLog.readEvents()
    expect(events.some((e) => e.type === 'dispatcher.halted' && e.hop === 8)).toBe(true)
    expect(desktopAlerts).toHaveLength(1)
    expect(desktopAlerts[0]!.body).toMatch(/hop|熔断|8/i)
    expect(github.getIssueComments(30)).toHaveLength(1)
    expect(github.getIssueComments(30)[0]).toContain('@torres7707')
  })

  it('supports piedpiper dispatch --once and --poll via CLI', async () => {
    const { repoRoot, worktreeBaseDir } = setupDispatcherRepo()
    const github = createInMemoryGitHubPort({
      issues: [
        {
          number: 40,
          title: 'CLI Dispatch Ticket',
          body: 'Run via CLI',
          state: 'OPEN',
          labels: ['ready-for-agent'],
          blockedBy: [],
        },
      ],
    })

    const dinesh: Adapter = {
      async run(req) {
        writeFileSync(path.join(req.cwd, 'cli-disp.txt'), 'ok\n', 'utf8')
        git(req.cwd, 'add', 'cli-disp.txt')
        git(req.cwd, 'commit', '-m', 'feat: cli dispatch')
        return { reply: 'dinesh ok' }
      },
    }
    const gilfoyle: Adapter = {
      async run() {
        return { reply: '## 评审结论：通过\n- **核对范围**：`cli-disp.txt`\n- **验收标准核对**：通过。' }
      },
    }

    let stdout = ''
    let stderr = ''
    const code = await runCli(['dispatch', '--once', '--repo', repoRoot], {
      stdout: (c) => {
        stdout += c
      },
      stderr: (c) => {
        stderr += c
      },
      adapterOverrides: { dinesh, gilfoyle },
      github,
      worktreeBaseDir,
    })

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toMatch(/dinesh|gilfoyle|#40/i)

    const issue40 = await github.getIssue(40)
    expect(issue40.labels).toContain('in-review')
    expect(await github.listOpenPullRequests()).toHaveLength(1)

    // Test --poll mode with maxPollCycles
    let pollStdout = ''
    const pollCode = await runCli(
      ['dispatch', '--poll', '--interval', '1', '--repo', repoRoot],
      {
        stdout: (c) => {
          pollStdout += c
        },
        stderr: () => {},
        adapterOverrides: { dinesh, gilfoyle },
        github,
        worktreeBaseDir,
        maxPollCycles: 1,
      },
    )
    expect(pollCode).toBe(0)
    expect(pollStdout).toContain('Cycle 1:')
  })
})
