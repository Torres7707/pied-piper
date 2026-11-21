import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdapterResolver, type AdapterRequest } from '../src/adapters.js'
import { loadConfig } from '../src/config.js'
import { dispatchOnce } from '../src/dispatcher.js'
import { createJsonlEventLog } from '../src/event-log.js'
import { createInMemoryGitHubPort } from '../src/github.js'
import { createNotifier, type DesktopNotificationPayload } from '../src/notifications.js'
import { validateGilfoyleOutput } from '../src/review.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'piedpiper-rev-test-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function setupReviewRepo(options?: {
  validateOutput?: boolean
  maxRounds?: number
  maxHops?: number
}): { repoRoot: string; worktreeBaseDir: string } {
  const workspace = makeTempDir('piedpiper-rev-ws-')
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
            parallel: 1,
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
          notifications: {
            desktop: true,
            githubMention: true,
            githubHandle: 'torres7707',
          },
          review: {
            maxRounds: options?.maxRounds ?? 2,
            validateOutput: options?.validateOutput ?? true,
          },
          dispatcher: {
            maxHops: options?.maxHops ?? 8,
            pollIntervalSec: 1,
          },
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

describe('validateGilfoyleOutput', () => {
  it('rejects vague approvals and incomplete findings while accepting structured findings or justified approvals', () => {
    expect(validateGilfoyleOutput('LGTM! Looks good to me.').valid).toBe(false)
    expect(validateGilfoyleOutput('代码整体清晰，通过。').valid).toBe(false)
    expect(
      validateGilfoyleOutput('1. **[阻塞级] `src/app.ts`**\n- **说明**：缺少行号与依据').valid,
    ).toBe(false)

    const validFinding = validateGilfoyleOutput(
      [
        '## 评审结论：需修改',
        '### 评审发现（Findings）',
        '1. **[阻塞级] `src/auth.ts:42`**',
        '   - **依据**：违反安全边界，直接拼接外部输入到命令参数。',
        '   - **说明**：存在命令注入风险。',
        '   - **修复要求**：改用参数数组直传。',
      ].join('\n'),
    )
    expect(validFinding.valid).toBe(true)
    expect(validFinding.blockingFindings).toHaveLength(1)
    expect(validFinding.advisoryFindings).toHaveLength(0)

    const validApproval = validateGilfoyleOutput(
      [
        '## 评审结论：通过',
        '### 通过理由',
        '- **核对范围**：`src/config.ts`、`tests/config.test.ts`',
        '- **验收标准核对**：必填字段校验与边界测试均已验证通过，未发现阻塞级缺陷。',
      ].join('\n'),
    )
    expect(validApproval.valid).toBe(true)
    expect(validApproval.blockingFindings).toHaveLength(0)

    const inlineFinding = validateGilfoyleOutput(
      '1. [Blocking] src/auth.ts:42 — Basis: external input reaches spawn without validation.',
    )
    expect(inlineFinding.valid).toBe(true)
    expect(inlineFinding.blockingFindings).toHaveLength(1)
  })
})

describe('Review loop (max 2 rounds) and Gilfoyle output validation', () => {
  it('intercepts invalid Gilfoyle output when validateOutput is true, retries or notifies, and allows LGTM when validateOutput is false', async () => {
    // Part A: validateOutput = true -> rejects LGTM, retries once, if still invalid notifies & does NOT submit as valid approval
    const { repoRoot, worktreeBaseDir } = setupReviewRepo({ validateOutput: true })
    const loaded = await loadConfig(repoRoot)
    const eventLog = createJsonlEventLog(path.join(repoRoot, loaded.config.runtime.eventLog.path))
    const desktopAlerts: DesktopNotificationPayload[] = []

    const github = createInMemoryGitHubPort({
      issues: [
        {
          number: 80,
          title: 'Ticket 80',
          body: 'Test validation',
          state: 'OPEN',
          labels: ['ready-for-agent', 'in-review'],
          blockedBy: [],
        },
      ],
      pullRequests: [
        {
          number: 801,
          title: 'feat: ticket 80',
          body: 'Closes #80',
          state: 'OPEN',
          headRefName: 'ticket/80',
          baseRefName: 'main',
          linkedIssueNumbers: [80],
          diff: 'diff --git a/a.ts b/a.ts\n+export const a = 1\n',
        },
      ],
    })

    const notifier = createNotifier({
      config: loaded.config.runtime.notifications,
      github,
      desktopSender: async (p) => {
        desktopAlerts.push(p)
      },
    })

    let gilfoyleCalls = 0
    const res1 = await dispatchOnce({
      repoRoot,
      config: loaded.config,
      github,
      resolveAdapter: createAdapterResolver({
        gilfoyle: {
          async run() {
            gilfoyleCalls += 1
            return { reply: 'LGTM' }
          },
        },
      }),
      worktreeBaseDir,
      eventLog,
      notifier,
    })

    expect(gilfoyleCalls).toBe(2) // initial + 1 retry
    expect(res1.halted).toBe(false)
    // Invalid review was never published as a valid approval
    expect(await github.listPullRequestReviews(801)).toHaveLength(0)
    const events = await eventLog.readEvents()
    expect(events.some((e) => e.type === 'review.invalid')).toBe(true)
    expect(desktopAlerts).toHaveLength(1)
    expect(github.getIssueComments(80)).toHaveLength(1)
    expect((await github.getIssue(80)).labels).toContain('ready-for-human')

    // Part B: validateOutput = false -> allows LGTM directly without retry or auto-merge
    const offSetup = setupReviewRepo({ validateOutput: false })
    const offLoaded = await loadConfig(offSetup.repoRoot)
    const offGithub = createInMemoryGitHubPort({
      issues: [
        {
          number: 81,
          title: 'Ticket 81',
          body: 'Allow LGTM when validation off',
          state: 'OPEN',
          labels: ['ready-for-agent', 'in-review'],
          blockedBy: [],
        },
      ],
      pullRequests: [
        {
          number: 811,
          title: 'feat: ticket 81',
          body: 'Closes #81',
          state: 'OPEN',
          headRefName: 'ticket/81',
          baseRefName: 'main',
          linkedIssueNumbers: [81],
          diff: 'diff --git a/b.ts b/b.ts\n+export const b = 1\n',
        },
      ],
    })

    await dispatchOnce({
      repoRoot: offSetup.repoRoot,
      config: offLoaded.config,
      github: offGithub,
      resolveAdapter: createAdapterResolver({
        gilfoyle: {
          async run() {
            return { reply: 'LGTM' }
          },
        },
      }),
      worktreeBaseDir: offSetup.worktreeBaseDir,
    })

    expect(await offGithub.listPullRequestReviews(811)).toHaveLength(1)
    expect((await offGithub.getPullRequest(811)).state).toBe('OPEN')
    expect((await offGithub.getIssue(81)).labels).toContain('in-review')
  })

  it('does not bounce to Dinesh or auto-merge when Gilfoyle returns only advisory findings', async () => {
    const { repoRoot, worktreeBaseDir } = setupReviewRepo({ validateOutput: true })
    const loaded = await loadConfig(repoRoot)

    const github = createInMemoryGitHubPort({
      issues: [
        {
          number: 82,
          title: 'Ticket 82',
          body: 'Advisory only case',
          state: 'OPEN',
          labels: ['ready-for-agent', 'in-review'],
          blockedBy: [],
        },
      ],
      pullRequests: [
        {
          number: 821,
          title: 'feat: ticket 82',
          body: 'Closes #82',
          state: 'OPEN',
          headRefName: 'ticket/82',
          baseRefName: 'main',
          linkedIssueNumbers: [82],
          diff: 'diff --git a/c.ts b/c.ts\n+export const c = 1\n',
        },
      ],
    })

    let dineshCalls = 0
    const result = await dispatchOnce({
      repoRoot,
      config: loaded.config,
      github,
      resolveAdapter: createAdapterResolver({
        dinesh: {
          async run() {
            dineshCalls += 1
            return { reply: 'should not run' }
          },
        },
        gilfoyle: {
          async run() {
            return {
              reply: [
                '## 评审结论：仅建议',
                '### 评审发现（Findings）',
                '1. **[建议级] `src/c.ts:1`**',
                '   - **依据**：可读性建议，变量名 `c` 可更具体。',
                '   - **说明**：非阻塞项，不影响正确性。',
                '### 通过理由',
                '- **核对范围**：`src/c.ts`',
                '- **验收标准核对**：全部满足，无阻塞级问题。',
              ].join('\n'),
            }
          },
        },
      }),
      worktreeBaseDir,
    })

    expect(dineshCalls).toBe(0)
    expect(result.dispatchedDinesh).toEqual([])
    expect(result.dispatchedGilfoyle).toEqual([821])
    expect(await github.listPullRequestReviews(821)).toHaveLength(1)
    expect((await github.getPullRequest(821)).state).toBe('OPEN')
    expect((await github.getIssue(82)).labels).toContain('in-review')
    expect((await github.getIssue(82)).labels).not.toContain('ready-for-human')
  })

  it('sends blocking round-1 findings back to Dinesh and scopes round-2 Gilfoyle review strictly to round-1 blocking findings', async () => {
    const { repoRoot, worktreeBaseDir } = setupReviewRepo({ validateOutput: true, maxRounds: 2 })
    const loaded = await loadConfig(repoRoot)
    const eventLog = createJsonlEventLog(path.join(repoRoot, loaded.config.runtime.eventLog.path))

    const github = createInMemoryGitHubPort({
      issues: [
        {
          number: 83,
          title: 'Ticket 83',
          body: 'Implement input validation',
          state: 'OPEN',
          labels: ['ready-for-agent'],
          blockedBy: [],
        },
      ],
    })

    const dineshRequests: AdapterRequest[] = []
    const gilfoyleRequests: AdapterRequest[] = []
    let dineshRound = 0
    let gilfoyleRound = 0

    const res = await dispatchOnce({
      repoRoot,
      config: loaded.config,
      github,
      resolveAdapter: createAdapterResolver({
        dinesh: {
          async run(req) {
            dineshRound += 1
            dineshRequests.push(req)
            writeFileSync(path.join(req.cwd, 'impl.ts'), `export const v = ${dineshRound}\n`, 'utf8')
            git(req.cwd, 'add', 'impl.ts')
            git(req.cwd, 'commit', '-m', `feat: round ${dineshRound}`)
            return { reply: `dinesh round ${dineshRound}` }
          },
        },
        gilfoyle: {
          async run(req) {
            gilfoyleRound += 1
            gilfoyleRequests.push(req)
            if (gilfoyleRound === 1) {
              return {
                reply: [
                  '## 评审结论：需修改（含阻塞级发现）',
                  '### 评审发现（Findings）',
                  '1. **[阻塞级] `impl.ts:1`**',
                  '   - **依据**：未校验空值边界。',
                  '   - **说明**：当输入为空时抛出异常。',
                  '   - **修复要求**：补充空值校验与单测。',
                  '2. **[建议级] `impl.ts:1`**',
                  '   - **依据**：命名风格建议，`v` 可改为 `version`。',
                  '   - **说明**：仅建议项。',
                ].join('\n'),
              }
            }
            return {
              reply: [
                '## 评审结论：通过',
                '### 通过理由',
                '- **核对范围**：复核第 1 轮遗留阻塞级发现 `impl.ts:1`',
                '- **验收标准核对**：第 1 轮阻塞级问题已修复。',
              ].join('\n'),
            }
          },
        },
      }),
      worktreeBaseDir,
      eventLog,
    })

    expect(res.halted).toBe(false)
    expect(dineshRound).toBe(2)
    expect(gilfoyleRound).toBe(2)

    // Verify Round 2 Gilfoyle prompt & context file only focus on Round 1 blocking findings
    const round2Prompt = gilfoyleRequests[1]!.prompt
    expect(round2Prompt).toMatch(/Round 2|第\s*2\s*轮/i)
    const round1BlockingMatch = round2Prompt.match(/Context file:\s*(.+round-1-blocking-findings\.md)/)
    expect(round1BlockingMatch).not.toBeNull()
    const blockingFileContent = readFileSync(round1BlockingMatch![1]!.trim(), 'utf8')
    expect(blockingFileContent).toContain('未校验空值边界')
    expect(blockingFileContent).not.toContain('命名风格建议')

    const reviews = await github.listPullRequestReviews(1)
    expect(reviews).toHaveLength(2)
    expect((await github.getIssue(83)).labels).toContain('in-review')
    expect((await github.getIssue(83)).labels).not.toContain('ready-for-human')
  })

  it('stops automatic dispatch, adds ready-for-human, logs review.escalated, and notifies developer when blocking findings persist after 2 rounds', async () => {
    const { repoRoot, worktreeBaseDir } = setupReviewRepo({ validateOutput: true, maxRounds: 2 })
    const loaded = await loadConfig(repoRoot)
    const eventLog = createJsonlEventLog(path.join(repoRoot, loaded.config.runtime.eventLog.path))
    const desktopAlerts: DesktopNotificationPayload[] = []

    const github = createInMemoryGitHubPort({
      issues: [
        {
          number: 84,
          title: 'Ticket 84',
          body: 'Persistent blocking issue',
          state: 'OPEN',
          labels: ['ready-for-agent'],
          blockedBy: [],
        },
      ],
    })

    const notifier = createNotifier({
      config: loaded.config.runtime.notifications,
      github,
      desktopSender: async (p) => {
        desktopAlerts.push(p)
      },
    })

    let dineshRuns = 0
    let gilfoyleRuns = 0
    const resolveAdapter = createAdapterResolver({
      dinesh: {
        async run(req) {
          dineshRuns += 1
          writeFileSync(path.join(req.cwd, 'work.ts'), `export const step = ${dineshRuns}\n`, 'utf8')
          git(req.cwd, 'add', 'work.ts')
          git(req.cwd, 'commit', '-m', `work ${dineshRuns}`)
          return { reply: `dinesh ${dineshRuns}` }
        },
      },
      gilfoyle: {
        async run() {
          gilfoyleRuns += 1
          return {
            reply: [
              '## 评审结论：需修改（含阻塞级发现）',
              '### 评审发现（Findings）',
              '1. **[阻塞级] `work.ts:1`**',
              `   - **依据**：第 ${gilfoyleRuns} 轮仍缺少边界保护。`,
              '   - **说明**：未满足验收标准。',
              '   - **修复要求**：增加参数校验。',
            ].join('\n'),
          }
        },
      },
    })

    const cycle1 = await dispatchOnce({
      repoRoot,
      config: loaded.config,
      github,
      resolveAdapter,
      worktreeBaseDir,
      eventLog,
      notifier,
    })

    expect(dineshRuns).toBe(2) // Initial implementation + Round 1 fix
    expect(gilfoyleRuns).toBe(2) // Round 1 + Round 2 (never Round 3!)
    expect(cycle1.halted).toBe(false)

    const issue84 = await github.getIssue(84)
    expect(issue84.labels).toContain('ready-for-human')
    expect(issue84.labels).not.toContain('in-review')
    expect(issue84.labels).not.toContain('in-progress')

    const events = await eventLog.readEvents()
    expect(events.some((e) => e.type === 'review.escalated')).toBe(true)
    expect(desktopAlerts).toHaveLength(1)
    expect(github.getIssueComments(84)).toHaveLength(1)
    expect(github.getIssueComments(84)[0]).toContain('@torres7707')

    // Subsequent dispatch cycle must NOT dispatch Dinesh or Gilfoyle again
    const cycle2 = await dispatchOnce({
      repoRoot,
      config: loaded.config,
      github,
      resolveAdapter,
      worktreeBaseDir,
      eventLog,
      notifier,
    })
    expect(cycle2.dispatchedDinesh).toEqual([])
    expect(cycle2.dispatchedGilfoyle).toEqual([])
    expect(dineshRuns).toBe(2)
    expect(gilfoyleRuns).toBe(2)
  })
})
