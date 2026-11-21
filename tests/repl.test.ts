import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Adapter, AdapterRequest, AdapterResponse } from '../src/adapters.js'
import { runCli, type CliDeps } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { createJsonlEventLog, type EventLogEntry } from '../src/event-log.js'
import { createInMemoryGitHubPort, type InMemoryGitHubPort } from '../src/github.js'
import type { InitProbe } from '../src/init.js'
import type { ReplDriver } from '../src/repl.js'

const tempDirs: string[] = []
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'piedpiper-repl-'))
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

function writeReadyRepo(root: string, richardBody = 'RICHARD_ROLE_MARKER'): void {
  const piedpiperDir = path.join(root, '.piedpiper')
  mkdirSync(path.join(piedpiperDir, 'roles'), { recursive: true })
  writeFileSync(
    path.join(piedpiperDir, 'config.json'),
    JSON.stringify(
      {
        roles: {
          richard: {
            adapter: 'claude',
            model: 'claude-opus-5-5',
            skills: ['grilling'],
            parallel: 1,
            access: 'read',
            prompt: 'roles/richard.md',
          },
          jared: {
            adapter: 'claude',
            model: 'claude-sonnet-5-5',
            skills: ['to-spec'],
            parallel: 1,
            access: 'read',
            prompt: 'roles/jared.md',
          },
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
      },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(path.join(piedpiperDir, 'roles', 'richard.md'), richardBody, 'utf8')
  writeFileSync(path.join(piedpiperDir, 'roles', 'jared.md'), 'JARED_ROLE_MARKER', 'utf8')
  writeFileSync(path.join(piedpiperDir, 'roles', 'dinesh.md'), '# Dinesh', 'utf8')
  writeFileSync(path.join(piedpiperDir, 'roles', 'gilfoyle.md'), '# Gilfoyle', 'utf8')
}

function scriptedDriver(
  lines: Array<string | null>,
  mode: 'queue' | 'idle-sigint' | 'poll-sigint',
): { driver: ReplDriver; prompts: string[] } {
  const prompts: string[] = []
  const listeners = new Set<() => void>()
  let armPollSigint = false

  const driver: ReplDriver = {
    readLine(prompt: string): Promise<string | null> {
      prompts.push(prompt)
      if (mode === 'idle-sigint') {
        return new Promise(() => {})
      }
      const next = lines.length > 0 ? lines.shift()! : null
      if (mode === 'poll-sigint' && typeof next === 'string' && next.startsWith('/dispatch --poll')) {
        armPollSigint = true
      }
      return Promise.resolve(next)
    },
    onSigint(listener: () => void): () => void {
      listeners.add(listener)
      if (mode === 'idle-sigint') {
        setImmediate(listener)
      } else if (mode === 'poll-sigint' && armPollSigint) {
        armPollSigint = false
        setImmediate(listener)
      }
      return () => {
        listeners.delete(listener)
      }
    },
    close(): void {},
  }
  return { driver, prompts }
}

const silentNotifier = { async notify(): Promise<void> {} }

async function runSession(options: {
  ready?: boolean
  richardBody?: string
  lines?: Array<string | null>
  sigint?: 'idle' | 'poll'
  adapters?: Partial<Record<string, Adapter>>
  github?: InMemoryGitHubPort
  initProbe?: InitProbe
  recordEvents?: boolean
}): Promise<{
  code: number
  stdout: string
  stderr: string
  prompts: string[]
  requests: AdapterRequest[]
  github: InMemoryGitHubPort
  repoRoot: string
  events: EventLogEntry[]
}> {
  const repoRoot = makeTempDir()
  if (options.ready !== false) {
    writeReadyRepo(repoRoot, options.richardBody)
  }
  const github = options.github ?? createInMemoryGitHubPort()
  const requests: AdapterRequest[] = []
  const adapters: Partial<Record<string, Adapter>> = {}
  for (const [role, adapter] of Object.entries(options.adapters ?? {})) {
    if (!adapter) continue
    adapters[role] = {
      async run(req: AdapterRequest): Promise<AdapterResponse> {
        requests.push(req)
        return adapter.run(req)
      },
    }
  }
  const mode = options.sigint === 'idle' ? 'idle-sigint' : options.sigint === 'poll' ? 'poll-sigint' : 'queue'
  const { driver, prompts } = scriptedDriver(options.lines ?? ['/exit'], mode)
  const eventLog = options.recordEvents
    ? createJsonlEventLog(path.join(repoRoot, '.piedpiper', 'events.jsonl'))
    : undefined
  let stdout = ''
  let stderr = ''
  const deps: CliDeps = {
    stdout: (chunk) => {
      stdout += chunk
    },
    stderr: (chunk) => {
      stderr += chunk
    },
    github,
    repl: driver,
    notifier: silentNotifier,
    adapterOverrides: adapters,
    initProbe: options.initProbe,
    eventLog,
  }
  const code = await runCli(['--repo', repoRoot], deps)
  const events = eventLog ? await eventLog.readEvents() : []
  return { code, stdout, stderr, prompts, requests, github, repoRoot, events }
}

const JARED_GRAPH = [
  '```json',
  JSON.stringify({
    spec: { title: 'Spec: thing', body: 'spec body' },
    tickets: [
      { id: 't1', title: 'Ticket: one', body: 'first slice', blockedBy: [] },
      { id: 't2', title: 'Ticket: two', body: 'second slice', blockedBy: ['t1'] },
    ],
  }),
  '```',
].join('\n')

describe('piedpiper REPL', () => {
  it('auto-inits a repo with no config, then opens the piedpiper> prompt', async () => {
    const github = createInMemoryGitHubPort()
    const session = await runSession({
      ready: false,
      lines: [null],
      github,
      initProbe: probe(),
    })

    expect(session.code).toBe(0)
    expect(session.stdout).toContain(`Initialized .piedpiper in ${session.repoRoot}`)
    expect(session.prompts).toContain('piedpiper> ')
    expect(existsSync(path.join(session.repoRoot, '.piedpiper', 'config.json'))).toBe(true)
    const loaded = await loadConfig(session.repoRoot)
    expect(loaded.config.roles.gilfoyle?.model).toBe('gpt-5-codex')
    expect(github.getEnsuredLabels().map((label) => label.name)).toEqual([
      'ready-for-agent',
      'in-progress',
      'in-review',
      'ready-for-human',
      'needs-triage',
      'needs-info',
      'wontfix',
    ])
    const gitignore = readFileSync(path.join(session.repoRoot, '.gitignore'), 'utf8')
    expect(gitignore).toContain('.piedpiper/events.jsonl')
    expect(gitignore).toContain('.piedpiper/tmp/')
  })

  it('stops before creating .piedpiper when auto-init preflight fails', async () => {
    const session = await runSession({
      ready: false,
      lines: ['hello'],
      initProbe: probe({
        async isGitRepository() {
          return false
        },
      }),
    })

    expect(session.code).toBe(1)
    expect(session.stderr).toMatch(/git init/)
    expect(existsSync(path.join(session.repoRoot, '.piedpiper'))).toBe(false)
    expect(session.prompts).toEqual([])
  })

  it('opens the REPL without probing when the repo is already initialized', async () => {
    const session = await runSession({
      lines: [null],
      initProbe: probe({
        async isGitRepository() {
          throw new Error('probe should not run')
        },
      }),
    })

    expect(session.code).toBe(0)
    expect(session.stderr).toBe('')
    expect(session.prompts).toEqual(['piedpiper> '])
    expect(session.stdout).not.toContain('Initialized')
  })

  it('sends the role file only on the first Richard turn, resumes with the raw text, and /reset starts over', async () => {
    const first = 'line1\nline2 "quoted"'
    const second = 'next turn \\ slash'
    const sessionId = 'sess-\n"id"'
    const session = await runSession({
      lines: ['   ', first, second, '/reset', 'after reset', '/exit'],
      recordEvents: true,
      adapters: {
        richard: {
          async run(req) {
            if (req.sessionId !== undefined) {
              return { reply: 'continued', sessionId: req.sessionId }
            }
            return { reply: 'opened', sessionId }
          },
        },
      },
    })

    expect(session.code).toBe(0)
    expect(session.stderr).toBe('')
    expect(session.requests).toHaveLength(3)

    const opening = session.requests[0]!
    expect(opening.sessionId).toBeUndefined()
    expect(opening.prompt).toContain('RICHARD_ROLE_MARKER')
    expect(opening.prompt).toContain('GLOSSARY.md')
    expect(opening.prompt).toContain('docs/adr/')
    expect(opening.prompt).toContain(first)
    expect(opening.access).toBe('read')

    const continuation = session.requests[1]!
    expect(continuation.prompt).toBe(second)
    expect(continuation.sessionId).toBe(sessionId)
    expect(continuation.prompt).not.toContain('RICHARD_ROLE_MARKER')

    const reopened = session.requests[2]!
    expect(reopened.sessionId).toBeUndefined()
    expect(reopened.prompt).toContain('RICHARD_ROLE_MARKER')
    expect(reopened.prompt).toContain('after reset')
    expect(session.stdout).toContain('Richard session reset')

    expect(session.events.map((event) => event.type)).toEqual([
      'run.started',
      'run.completed',
      'run.started',
      'run.completed',
      'run.started',
      'run.completed',
    ])
    expect(session.events[1]).toMatchObject({
      role: 'richard',
      target: 'repl',
      sessionId,
      decision: 'completed',
    })
  })

  it('does not keep a session id when the first Richard turn fails', async () => {
    let calls = 0
    const session = await runSession({
      lines: ['first', 'second', '/exit'],
      adapters: {
        richard: {
          async run() {
            calls += 1
            if (calls === 1) throw new Error('adapter exploded')
            return { reply: 'opened', sessionId: 'sess-2' }
          },
        },
      },
    })

    expect(session.code).toBe(0)
    expect(session.stderr).toMatch(/adapter exploded/)
    expect(session.requests).toHaveLength(2)
    expect(session.requests[0]!.sessionId).toBeUndefined()
    expect(session.requests[1]!.sessionId).toBeUndefined()
    expect(session.requests[1]!.prompt).toContain('RICHARD_ROLE_MARKER')
  })

  it('refuses /issue and bare /jared before any Richard turn', async () => {
    const session = await runSession({
      lines: ['/issue', '/jared', '/exit'],
      adapters: {
        richard: {
          async run() {
            return { reply: 'should-not-run', sessionId: 'sess' }
          },
        },
        jared: {
          async run() {
            return { reply: JARED_GRAPH }
          },
        },
      },
    })

    expect(session.code).toBe(0)
    expect(session.requests).toEqual([])
    expect(session.stderr).toMatch(/Richard/)
    expect(session.stderr).toMatch(/\/jared #/)
    expect(await session.github.listOpenIssues()).toEqual([])
  })

  it('creates a GitHub issue from the distilled conclusion, using an explicit title when given', async () => {
    const session = await runSession({
      lines: ['let us discuss', '/issue Custom Title', '/exit'],
      adapters: {
        richard: {
          async run(req) {
            if (req.sessionId === undefined) {
              return { reply: 'three directions', sessionId: 'sess-issue' }
            }
            return {
              reply: [
                '```json',
                JSON.stringify({
                  title: 'From Richard',
                  body: 'Background: slow builds\nChosen direction: cache\nConstraints: no new services\nOut of scope: widgets',
                }),
                '```',
              ].join('\n'),
              sessionId: req.sessionId,
            }
          },
        },
      },
    })

    expect(session.code).toBe(0)
    expect(session.stdout).toContain('Created Issue #1')
    const distill = session.requests[1]!
    expect(distill.sessionId).toBe('sess-issue')
    expect(distill.prompt).not.toContain('RICHARD_ROLE_MARKER')
    const issues = await session.github.listOpenIssues()
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      number: 1,
      title: 'Custom Title',
      labels: [],
    })
    expect(issues[0]!.body).toContain('Out of scope: widgets')
    expect(issues[0]!.body).toContain('Chosen direction: cache')
  })

  it('runs bare /jared by creating the conclusion issue and then publishing a blocked task graph', async () => {
    const session = await runSession({
      lines: ['discuss the idea', '/jared', '/exit'],
      adapters: {
        richard: {
          async run(req) {
            if (req.sessionId === undefined) {
              return { reply: 'directions', sessionId: 'sess-jared' }
            }
            return {
              reply: JSON.stringify({
                title: 'Chosen direction',
                body: 'Background: idea\nChosen direction: B\nConstraints: read-only\nOut of scope: ui',
              }),
              sessionId: req.sessionId,
            }
          },
        },
        jared: {
          async run() {
            return { reply: JARED_GRAPH }
          },
        },
      },
    })

    expect(session.code).toBe(0)
    expect(session.stdout).toContain('Created Issue #1')
    expect(session.stdout).toContain('Published Spec #2 and Tickets #3, #4')
    const jaredRequest = session.requests.find((req) => req.prompt.includes('JARED_ROLE_MARKER'))
    expect(jaredRequest?.prompt).toContain('#1')
    const issues = await session.github.listOpenIssues()
    expect(issues.map((issue) => issue.title)).toEqual([
      'Chosen direction',
      'Spec: thing',
      'Ticket: one',
      'Ticket: two',
    ])
    expect(issues[2]!.parentNumber).toBe(2)
    expect(issues[3]!.parentNumber).toBe(2)
    expect(issues[3]!.blockedBy.map((dep) => dep.number)).toEqual([3])
  })

  it('runs /jared with an explicit target without a Richard session', async () => {
    const github = createInMemoryGitHubPort({
      issues: [
        {
          number: 12,
          title: 'Existing idea',
          body: 'already written',
          state: 'OPEN',
          labels: [],
          blockedBy: [],
        },
      ],
    })
    const session = await runSession({
      github,
      lines: ['/jared #12', '/exit'],
      adapters: {
        jared: {
          async run() {
            return { reply: JARED_GRAPH }
          },
        },
      },
    })

    expect(session.code).toBe(0)
    expect(session.requests).toHaveLength(1)
    expect(session.requests[0]!.prompt).toContain('JARED_ROLE_MARKER')
    expect(session.requests[0]!.prompt).toContain('#12')
    expect(session.stdout).toContain('Published Spec #13 and Tickets #14, #15')
  })

  it('serves /status, /events, /run, /dispatch --once, /init, /help, and /exit inside the REPL', async () => {
    const github = createInMemoryGitHubPort({
      issues: [
        {
          number: 7,
          title: 'Unblocked ticket',
          body: 'ready',
          state: 'OPEN',
          labels: ['ready-for-agent'],
          blockedBy: [],
        },
      ],
    })
    const session = await runSession({
      github,
      richardBody: 'KEEP_ME',
      recordEvents: true,
      lines: [
        'hello events',
        '/events 1',
        '/status',
        '/run richard docs/adr/note.md',
        '/dispatch --once',
        '/init',
        '/help',
        '/exit',
      ],
      initProbe: probe(),
      adapters: {
        richard: {
          async run(req) {
            if (req.prompt.includes('docs/adr/note.md') && req.prompt.includes('KEEP_ME')) {
              return { reply: 'ran-richard' }
            }
            return { reply: 'chat', sessionId: 'sess-events' }
          },
        },
        dinesh: {
          async run() {
            return { reply: 'dinesh-ok' }
          },
        },
      },
    })

    expect(session.code).toBe(0)
    expect(session.stderr).toBe('')
    const eventLines = session.stdout.split('\n').filter((line) => line.startsWith('['))
    expect(eventLines).toEqual([expect.stringMatching(/^\[.+\] run\.completed richard repl completed$/)])
    expect(session.stdout).toContain('Frontier:')
    expect(session.stdout).toContain('#7 Unblocked ticket')
    expect(session.stdout).toContain('ran-richard')
    expect(session.stdout).toContain('Dispatch: frontier=[#7]')
    expect(session.stdout).toContain('Initialized')
    expect(session.stdout).toContain('/jared')
    expect(readFileSync(path.join(session.repoRoot, '.piedpiper', 'roles', 'richard.md'), 'utf8')).toBe('KEEP_ME')
    expect(github.getEnsuredLabels()).toHaveLength(7)
  })

  it('reloads config when /init --force re-detects the environment', async () => {
    const session = await runSession({
      lines: ['/init --force', '/exit'],
      initProbe: probe({
        async detectClis() {
          return { claude: false, codex: true }
        },
        async getGitHubLogin() {
          return 'forced-user'
        },
      }),
    })

    expect(session.code).toBe(0)
    const loaded = await loadConfig(session.repoRoot)
    expect(loaded.config.roles.gilfoyle?.model).toBe('o3')
    expect(loaded.config.roles.dinesh?.model).toBe('gpt-5-codex')
    expect(loaded.config.runtime.notifications.githubHandle).toBe('forced-user')
    expect(loaded.config.runtime.notifications.githubMention).toBe(true)
  })

  it('stops /dispatch --poll on SIGINT and keeps the Richard session', async () => {
    const session = await runSession({
      sigint: 'poll',
      lines: ['first idea', '/dispatch --poll --interval 60', 'second idea', null],
      adapters: {
        richard: {
          async run(req) {
            if (req.sessionId !== undefined) {
              return { reply: 'continued', sessionId: req.sessionId }
            }
            return { reply: 'opened', sessionId: 'sess-poll' }
          },
        },
      },
    })

    expect(session.code).toBe(0)
    expect(session.stdout).toContain('Cycle 1:')
    expect(session.stdout).toContain('Dispatch poll stopped.')
    expect(session.requests).toHaveLength(2)
    expect(session.requests[1]!.prompt).toBe('second idea')
    expect(session.requests[1]!.sessionId).toBe('sess-poll')
    expect(session.prompts.filter((prompt) => prompt === 'piedpiper> ').length).toBeGreaterThanOrEqual(3)
  })

  it('exits 0 on idle SIGINT, EOF, and /quit', async () => {
    const idle = await runSession({ sigint: 'idle', lines: ['should-not-run'] })
    expect(idle.code).toBe(0)
    expect(idle.requests).toEqual([])

    const eof = await runSession({ lines: [null] })
    expect(eof.code).toBe(0)

    const quit = await runSession({ lines: ['/quit'] })
    expect(quit.code).toBe(0)
  })

  it('documents the no-arg REPL in --help and README', async () => {
    let stdout = ''
    const code = await runCli(['--help'], {
      stdout: (chunk) => {
        stdout += chunk
      },
      stderr: () => {},
    })
    expect(code).toBe(0)
    expect(stdout).toContain('piedpiper run')
    expect(stdout).toContain('piedpiper>')
    expect(stdout).toContain('/jared')
    expect(stdout).toContain('piedpiper init')
    expect(stdout).toContain('piedpiper status')

    const readme = readFileSync(path.join(packageRoot, 'README.md'), 'utf8')
    expect(readme).toContain('piedpiper init')
    expect(readme).toContain('piedpiper status')
    expect(readme).toContain('/jared')
    expect(readme).toMatch(/Ctrl\+C/)
  })
})
