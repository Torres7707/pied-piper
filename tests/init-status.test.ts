import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import {
  createInMemoryGitHubPort,
  STANDARD_GITHUB_LABELS,
  type GitHubIssue,
  type GitHubPullRequest,
} from '../src/github.js'
import type { InitProbe } from '../src/init.js'

const tempDirs: string[] = []
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'piedpiper-init-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function probe(overrides: Partial<InitProbe> = {}): InitProbe {
  return {
    async isGitRepository() {
      return true
    },
    async getOriginUrl() {
      return 'https://github.com/octo/repo.git'
    },
    async isGhAuthenticated() {
      return true
    },
    async detectClis() {
      return { claude: true, codex: true }
    },
    async getGitHubLogin() {
      return 'octocat'
    },
    ...overrides,
  }
}

async function runInit(
  repoRoot: string,
  args: string[],
  initProbe: InitProbe,
  github = createInMemoryGitHubPort(),
): Promise<{ exitCode: number; stdout: string; stderr: string; github: ReturnType<typeof createInMemoryGitHubPort> }> {
  let stdout = ''
  let stderr = ''
  const exitCode = await runCli(['init', ...args, '--repo', repoRoot], {
    stdout: (chunk) => {
      stdout += chunk
    },
    stderr: (chunk) => {
      stderr += chunk
    },
    github,
    initProbe,
  })
  return { exitCode, stdout, stderr, github }
}

describe('piedpiper init and status', () => {
  it('ships templates and a publishable package manifest', () => {
    const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      private?: boolean
      files?: string[]
      scripts?: { prepublishOnly?: string }
    }
    expect(pkg.private).toBeUndefined()
    expect(pkg.files).toEqual(['dist', 'templates'])
    expect(pkg.scripts?.prepublishOnly).toBe('npm run build')
    expect(existsSync(path.join(packageRoot, 'templates', 'config.json'))).toBe(true)
    for (const role of ['richard', 'jared', 'dinesh', 'gilfoyle']) {
      expect(existsSync(path.join(packageRoot, 'templates', 'roles', `${role}.md`))).toBe(true)
    }
  })

  it('aborts before creating .piedpiper when git, GitHub origin, gh auth, or both CLIs are missing', async () => {
    const cases: Array<{ name: string; initProbe: InitProbe; fix: RegExp }> = [
      {
        name: 'not a git repo',
        initProbe: probe({
          async isGitRepository() {
            return false
          },
        }),
        fix: /git init/,
      },
      {
        name: 'no GitHub origin',
        initProbe: probe({
          async getOriginUrl() {
            return undefined
          },
        }),
        fix: /git remote add origin/,
      },
      {
        name: 'gh logged out',
        initProbe: probe({
          async isGhAuthenticated() {
            return false
          },
        }),
        fix: /gh auth login/,
      },
      {
        name: 'no claude or codex',
        initProbe: probe({
          async detectClis() {
            return { claude: false, codex: false }
          },
        }),
        fix: /claude[\s\S]*codex|codex[\s\S]*claude/,
      },
    ]

    for (const testCase of cases) {
      const repoRoot = makeTempDir()
      const github = createInMemoryGitHubPort()
      const result = await runInit(repoRoot, [], testCase.initProbe, github)
      expect(result.exitCode, testCase.name).not.toBe(0)
      expect(result.stderr, testCase.name).toMatch(testCase.fix)
      expect(existsSync(path.join(repoRoot, '.piedpiper')), testCase.name).toBe(false)
      expect(github.getEnsuredLabels(), testCase.name).toEqual([])
    }
  })

  it('assigns heteromorphic role models for both CLIs, claude only, and codex only, and passes loadConfig', async () => {
    const cases: Array<{
      clis: { claude: boolean; codex: boolean }
      login: string | undefined
      loginThrows?: boolean
      handle: string
      mention: boolean
      models: Record<string, { adapter: string; model: string }>
    }> = [
      {
        clis: { claude: true, codex: true },
        login: 'octocat',
        handle: 'octocat',
        mention: true,
        models: {
          richard: { adapter: 'claude', model: 'claude-opus-5-5' },
          jared: { adapter: 'claude', model: 'claude-sonnet-5-5' },
          dinesh: { adapter: 'claude', model: 'claude-sonnet-5-5' },
          gilfoyle: { adapter: 'codex', model: 'gpt-5-codex' },
        },
      },
      {
        clis: { claude: true, codex: false },
        login: 'octocat',
        handle: 'octocat',
        mention: true,
        models: {
          richard: { adapter: 'claude', model: 'claude-opus-5-5' },
          jared: { adapter: 'claude', model: 'claude-sonnet-5-5' },
          dinesh: { adapter: 'claude', model: 'claude-sonnet-5-5' },
          gilfoyle: { adapter: 'claude', model: 'claude-opus-5-5' },
        },
      },
      {
        clis: { claude: false, codex: true },
        login: 'octocat',
        handle: 'octocat',
        mention: true,
        models: {
          richard: { adapter: 'codex', model: 'o3' },
          jared: { adapter: 'codex', model: 'gpt-5-codex' },
          dinesh: { adapter: 'codex', model: 'gpt-5-codex' },
          gilfoyle: { adapter: 'codex', model: 'o3' },
        },
      },
      {
        clis: { claude: true, codex: true },
        login: undefined,
        loginThrows: true,
        handle: '',
        mention: false,
        models: {
          richard: { adapter: 'claude', model: 'claude-opus-5-5' },
          jared: { adapter: 'claude', model: 'claude-sonnet-5-5' },
          dinesh: { adapter: 'claude', model: 'claude-sonnet-5-5' },
          gilfoyle: { adapter: 'codex', model: 'gpt-5-codex' },
        },
      },
    ]

    for (const testCase of cases) {
      const repoRoot = makeTempDir()
      const result = await runInit(
        repoRoot,
        [],
        probe({
          async detectClis() {
            return testCase.clis
          },
          async getGitHubLogin() {
            if (testCase.loginThrows) {
              throw new Error('gh api user failed')
            }
            return testCase.login
          },
        }),
      )
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      const loaded = await loadConfig(repoRoot)
      for (const [roleName, expected] of Object.entries(testCase.models)) {
        expect(loaded.config.roles[roleName]?.adapter).toBe(expected.adapter)
        expect(loaded.config.roles[roleName]?.model).toBe(expected.model)
      }
      expect(loaded.config.roles.richard?.skills).toContain('grilling')
      expect(loaded.config.roles.dinesh?.access).toBe('write')
      expect(loaded.config.roles.gilfoyle?.access).toBe('read')
      expect(loaded.config.runtime.notifications.githubHandle).toBe(testCase.handle)
      expect(loaded.config.runtime.notifications.githubMention).toBe(testCase.mention)
      expect(result.github.getEnsuredLabels()).toEqual([...STANDARD_GITHUB_LABELS])
    }
  })

  it('keeps existing config and role files unless --force, and syncs gitignore and labels idempotently', async () => {
    const repoRoot = makeTempDir()
    writeFileSync(
      path.join(repoRoot, '.gitignore'),
      'node_modules/\n.piedpiper/events.jsonl\n',
      'utf8',
    )
    const github = createInMemoryGitHubPort()
    const first = await runInit(repoRoot, [], probe(), github)
    expect(first.exitCode).toBe(0)

    const configPath = path.join(repoRoot, '.piedpiper', 'config.json')
    const richardPath = path.join(repoRoot, '.piedpiper', 'roles', 'richard.md')
    const jaredPath = path.join(repoRoot, '.piedpiper', 'roles', 'jared.md')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      roles: { dinesh: { model: string } }
    }
    config.roles.dinesh.model = 'custom-dinesh-model'
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
    writeFileSync(richardPath, 'CUSTOM RICHARD\n', 'utf8')

    const second = await runInit(repoRoot, [], probe({ async detectClis() { return { claude: false, codex: true } } }), github)
    expect(second.exitCode).toBe(0)
    const kept = JSON.parse(readFileSync(configPath, 'utf8')) as {
      roles: { dinesh: { model: string } }
    }
    expect(kept.roles.dinesh.model).toBe('custom-dinesh-model')
    expect(readFileSync(richardPath, 'utf8')).toBe('CUSTOM RICHARD\n')

    unlinkSync(jaredPath)
    const third = await runInit(repoRoot, [], probe(), github)
    expect(third.exitCode).toBe(0)
    expect(readFileSync(jaredPath, 'utf8')).toBe(
      readFileSync(path.join(packageRoot, 'templates', 'roles', 'jared.md'), 'utf8'),
    )
    expect(readFileSync(richardPath, 'utf8')).toBe('CUSTOM RICHARD\n')
    expect(kept.roles.dinesh.model).toBe('custom-dinesh-model')

    const gitignore = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')
    expect(gitignore).toContain('node_modules/')
    expect(gitignore.split('\n').filter((line) => line === '.piedpiper/events.jsonl')).toHaveLength(1)
    expect(gitignore.split('\n').filter((line) => line === '.piedpiper/tmp/')).toHaveLength(1)
    expect(github.getEnsuredLabels()).toEqual([...STANDARD_GITHUB_LABELS])

    const forced = await runInit(
      repoRoot,
      ['--force'],
      probe({
        async detectClis() {
          return { claude: false, codex: true }
        },
        async getGitHubLogin() {
          return 'forced-user'
        },
      }),
      github,
    )
    expect(forced.exitCode).toBe(0)
    const loaded = await loadConfig(repoRoot)
    expect(loaded.config.roles.dinesh?.adapter).toBe('codex')
    expect(loaded.config.roles.dinesh?.model).toBe('gpt-5-codex')
    expect(loaded.config.roles.gilfoyle?.adapter).toBe('codex')
    expect(loaded.config.roles.gilfoyle?.model).toBe('o3')
    expect(loaded.config.runtime.notifications.githubHandle).toBe('forced-user')
    expect(loaded.config.runtime.notifications.githubMention).toBe(true)
    expect(readFileSync(richardPath, 'utf8')).toBe(
      readFileSync(path.join(packageRoot, 'templates', 'roles', 'richard.md'), 'utf8'),
    )
    expect(gitignore.split('\n').filter((line) => line === '.piedpiper/tmp/')).toHaveLength(1)
    const gitignoreAfterForce = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')
    expect(gitignoreAfterForce.split('\n').filter((line) => line === '.piedpiper/events.jsonl')).toHaveLength(1)
    expect(gitignoreAfterForce.split('\n').filter((line) => line === '.piedpiper/tmp/')).toHaveLength(1)
  })

  it('prints Frontier, In Progress, In Review, and Needs Human without blocked or parent-spec tickets on the frontier', async () => {
    const issue = (
      number: number,
      title: string,
      labels: string[],
      extra: Partial<GitHubIssue> = {},
    ): GitHubIssue => ({
      number,
      title,
      body: '',
      state: 'OPEN',
      labels,
      blockedBy: [],
      ...extra,
    })

    const issues: GitHubIssue[] = [
      issue(1, 'Parent spec', ['ready-for-agent']),
      issue(2, 'Unblocked ticket', ['ready-for-agent'], { parentNumber: 1 }),
      issue(3, 'Blocked ticket', ['ready-for-agent'], {
        parentNumber: 1,
        blockedBy: [{ number: 2, state: 'OPEN', title: 'Unblocked ticket' }],
      }),
      issue(4, 'Claimed ticket', ['in-progress']),
      issue(5, 'Review ticket', ['in-review']),
      issue(6, 'Human ticket', ['ready-for-human']),
      issue(7, 'Triage ticket', ['needs-triage']),
      issue(8, 'Info ticket', ['needs-info']),
      issue(10, 'Closed blocker ticket', ['ready-for-agent'], {
        blockedBy: [{ number: 99, state: 'CLOSED', title: 'Done' }],
      }),
      issue(11, 'Open PR ticket', ['ready-for-agent']),
    ]
    const pullRequests: GitHubPullRequest[] = [
      {
        number: 9,
        title: 'Review PR',
        body: '',
        state: 'OPEN',
        headRefName: 'ticket/5',
        baseRefName: 'main',
        linkedIssueNumbers: [5],
      },
      {
        number: 8,
        title: 'Earlier review PR',
        body: '',
        state: 'OPEN',
        headRefName: 'ticket/5b',
        baseRefName: 'main',
        linkedIssueNumbers: [5],
      },
      {
        number: 12,
        title: 'Unlabeled PR',
        body: '',
        state: 'OPEN',
        headRefName: 'ticket/11',
        baseRefName: 'main',
        linkedIssueNumbers: [11],
      },
    ]

    const repoRoot = makeTempDir()
    const github = createInMemoryGitHubPort({ issues, pullRequests })
    let stdout = ''
    let stderr = ''
    const exitCode = await runCli(['status', '--repo', repoRoot], {
      stdout: (chunk) => {
        stdout += chunk
      },
      stderr: (chunk) => {
        stderr += chunk
      },
      github,
    })

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toBe(
      [
        'Frontier:',
        '#2 Unblocked ticket',
        '#10 Closed blocker ticket',
        'In Progress:',
        '#4 Claimed ticket',
        'In Review:',
        '#5 Review ticket (PR #8, #9)',
        'Needs Human:',
        '#6 Human ticket',
        '#7 Triage ticket',
        '#8 Info ticket',
        '',
      ].join('\n'),
    )
  })
})
