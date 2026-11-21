import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdapterResolver, type Adapter, type AdapterRequest } from '../src/adapters.js'
import { runCli } from '../src/cli.js'
import { loadConfig } from '../src/config.js'
import { dispatchOnce } from '../src/dispatcher.js'
import {
  createGhGitHubPort,
  createInMemoryGitHubPort,
  type GitHubLabelSpec,
} from '../src/github.js'
import { runRole } from '../src/runner.js'

const tempDirs: string[] = []

function makeTempDir(prefix = 'piedpiper-jared-test-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeTestRepo(): string {
  const root = makeTempDir('piedpiper-jared-repo-')
  const piedpiperDir = path.join(root, '.piedpiper')
  mkdirSync(path.join(piedpiperDir, 'roles'), { recursive: true })
  writeFileSync(path.join(root, 'GLOSSARY.md'), '# Glossary\n', 'utf8')
  writeFileSync(
    path.join(piedpiperDir, 'roles', 'jared.md'),
    '# Jared\nRead conclusion and output spec + tickets task graph.',
    'utf8',
  )
  writeFileSync(
    path.join(piedpiperDir, 'roles', 'dinesh.md'),
    '# Dinesh\nImplement ticket.',
    'utf8',
  )
  writeFileSync(
    path.join(piedpiperDir, 'roles', 'gilfoyle.md'),
    '# Gilfoyle\nReview PR.',
    'utf8',
  )
  writeFileSync(
    path.join(piedpiperDir, 'config.json'),
    JSON.stringify(
      {
        roles: {
          jared: {
            adapter: 'claude',
            model: 'claude-sonnet-5-5',
            skills: ['to-spec', 'to-tickets'],
            parallel: 1,
            access: 'read',
            prompt: 'roles/jared.md',
          },
          dinesh: {
            adapter: 'claude',
            model: 'claude-sonnet-5-5',
            skills: ['tdd'],
            parallel: 2,
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
  return root
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('GitHubPort write extensions and Jared task graph persistence', () => {
  it('supports createIssue (with labels, parentNumber, blockedByNumbers) and ensureLabels in createInMemoryGitHubPort and createGhGitHubPort without exposing any merge capability', async () => {
    const memPort = createInMemoryGitHubPort()
    expect('mergePullRequest' in memPort).toBe(false)
    expect('merge' in memPort).toBe(false)

    const labelsToSync: GitHubLabelSpec[] = [
      {
        name: 'ready-for-agent',
        color: '0e8a16',
        description: 'Fully specified, ready for an AFK agent',
      },
      {
        name: 'in-progress',
        color: 'fbca04',
        description: 'Claimed by a Dinesh instance',
      },
    ]
    await memPort.ensureLabels(labelsToSync)
    expect(memPort.getEnsuredLabels()).toEqual(labelsToSync)

    const spec = await memPort.createIssue({
      title: 'Spec: Auth Flow',
      body: 'Parent spec body',
      labels: ['ready-for-agent'],
    })
    expect(spec.number).toBe(1)
    expect(spec.labels).toEqual(['ready-for-agent'])

    const t1 = await memPort.createIssue({
      title: 'Ticket: Token Parser',
      body: 'Build token parser',
      labels: ['ready-for-agent'],
      parentNumber: spec.number,
    })
    const t2 = await memPort.createIssue({
      title: 'Ticket: Session Middleware',
      body: 'Build session middleware',
      labels: ['ready-for-agent'],
      parentNumber: spec.number,
      blockedByNumbers: [t1.number],
    })

    expect(t1.parentNumber).toBe(1)
    expect(t2.parentNumber).toBe(1)
    expect(t2.blockedBy).toEqual([
      { number: t1.number, state: 'OPEN', title: 'Ticket: Token Parser' },
    ])

    // Verify listOpenIssues and getIssue reflect dynamic blocker state for dispatcher consumption
    memPort.closeIssue(t1.number)
    const refreshedT2 = await memPort.getIssue(t2.number)
    expect(refreshedT2.blockedBy).toEqual([
      { number: t1.number, state: 'CLOSED', title: 'Ticket: Token Parser' },
    ])

    // Verify createGhGitHubPort invokes gh label create --force and gh issue create with --parent and --blocked-by
    const dir = makeTempDir('piedpiper-gh-write-seam-')
    const callsLog = path.join(dir, 'gh-calls.jsonl')
    const fakeGh = path.join(dir, 'fake-gh.mjs')

    writeFileSync(
      fakeGh,
      `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsLog)}, JSON.stringify(args) + '\\n', 'utf8');

if (args[0] === 'label' && args[1] === 'create') {
  process.stdout.write('Label created\\n');
} else if (args[0] === 'issue' && args[1] === 'create') {
  process.stdout.write('https://github.com/o/r/issues/42\\n');
} else if (args[0] === 'api' && args[1] === 'graphql') {
  process.stdout.write(JSON.stringify({
    data: {
      repository: {
        issue: {
          number: 42,
          title: 'Ticket: Created via gh',
          body: 'Body 42',
          state: 'OPEN',
          labels: { nodes: [{ name: 'ready-for-agent' }] },
          blockedBy: { nodes: [{ number: 40, state: 'OPEN', title: 'Blocker 40' }] },
          parent: { number: 39 },
        },
      },
    },
  }));
} else {
  process.stdout.write('ok\\n');
}
`,
      'utf8',
    )

    const ghPort = createGhGitHubPort({
      cwd: dir,
      owner: 'o',
      repo: 'r',
      command: process.execPath,
      baseArgs: [fakeGh],
    })
    expect('mergePullRequest' in ghPort).toBe(false)

    await ghPort.ensureLabels(labelsToSync)
    const createdViaGh = await ghPort.createIssue({
      title: 'Ticket: Created via gh',
      body: 'Body 42',
      labels: ['ready-for-agent'],
      parentNumber: 39,
      blockedByNumbers: [40, 41],
    })

    expect(createdViaGh.number).toBe(42)
    expect(createdViaGh.parentNumber).toBe(39)
    expect(createdViaGh.blockedBy[0]?.number).toBe(40)

    const loggedCalls = readFileSync(callsLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])

    expect(loggedCalls[0]).toEqual([
      'label',
      'create',
      'ready-for-agent',
      '--color',
      '0e8a16',
      '--description',
      'Fully specified, ready for an AFK agent',
      '--force',
    ])
    expect(loggedCalls[2]).toEqual([
      'issue',
      'create',
      '--title',
      'Ticket: Created via gh',
      '--body',
      'Body 42',
      '--label',
      'ready-for-agent',
      '--parent',
      '39',
      '--blocked-by',
      '40,41',
    ])
  })

  it('parses Jared structured task graph JSON, creates parent Spec and topologically ordered sub-Tickets on GitHubPort, and feeds dispatcher frontier calculation', async () => {
    const repoRoot = makeTestRepo()
    const loaded = await loadConfig(repoRoot)
    const github = createInMemoryGitHubPort({
      issues: [
        {
          number: 10,
          title: 'Idea Conclusion: Global REPL and Init',
          body: 'Approved direction from Richard discussion.',
          state: 'OPEN',
          labels: [],
          blockedBy: [],
        },
      ],
    })

    const capturedJaredRequests: AdapterRequest[] = []
    const fakeJared: Adapter = {
      async run(req) {
        capturedJaredRequests.push(req)
        expect(req.access).toBe('read')
        return {
          reply: [
            'I have prepared the specification and vertical-slice tickets.',
            '',
            '```json',
            JSON.stringify(
              {
                spec: {
                  title: 'Spec: Global REPL Workflow',
                  body: '## Problem Statement\nNeed REPL.\n\n## Solution\nBuild REPL.',
                },
                // Intentionally place t2 before t1 to verify topological ordering
                tickets: [
                  {
                    id: 't2',
                    title: 'Ticket: Interactive REPL Loop',
                    body: '## What to build\nBuild REPL loop.\n\n## Acceptance criteria\n- [ ] Works.',
                    blockedBy: ['t1'],
                  },
                  {
                    id: 't1',
                    title: 'Ticket: Zero-Prompt Init',
                    body: '## What to build\nBuild init.\n\n## Acceptance criteria\n- [ ] Inits.',
                    blockedBy: [],
                  },
                  {
                    id: 't3',
                    title: 'Ticket: Slash Commands',
                    body: '## What to build\nBuild slash commands.\n\n## Acceptance criteria\n- [ ] Commands work.',
                    blockedBy: ['t1', 't2'],
                  },
                ],
              },
              null,
              2,
            ),
            '```',
          ].join('\n'),
        }
      },
    }

    let stdout = ''
    let stderr = ''
    const exitCode = await runCli(['run', 'jared', '#10', '--repo', repoRoot], {
      stdout: (chunk) => {
        stdout += chunk
      },
      stderr: (chunk) => {
        stderr += chunk
      },
      github,
      adapterOverrides: { jared: fakeJared },
    })

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(capturedJaredRequests).toHaveLength(1)
    expect(capturedJaredRequests[0]?.prompt).toContain('Host Output Contract (Structured Task Graph)')
    expect(stdout).toContain('Published Spec #11 and Tickets #12, #13, #14')

    const spec = await github.getIssue(11)
    expect(spec.title).toBe('Spec: Global REPL Workflow')
    expect(spec.labels).toContain('ready-for-agent')

    // t1 was created first (#12), then t2 (#13) blocked by #12, then t3 (#14) blocked by #12 and #13
    const ticket1 = await github.getIssue(12)
    expect(ticket1.title).toBe('Ticket: Zero-Prompt Init')
    expect(ticket1.parentNumber).toBe(11)
    expect(ticket1.labels).toContain('ready-for-agent')
    expect(ticket1.blockedBy).toEqual([])

    const ticket2 = await github.getIssue(13)
    expect(ticket2.title).toBe('Ticket: Interactive REPL Loop')
    expect(ticket2.parentNumber).toBe(11)
    expect(ticket2.labels).toContain('ready-for-agent')
    expect(ticket2.blockedBy.map((b) => b.number)).toEqual([12])

    const ticket3 = await github.getIssue(14)
    expect(ticket3.title).toBe('Ticket: Slash Commands')
    expect(ticket3.parentNumber).toBe(11)
    expect(ticket3.labels).toContain('ready-for-agent')
    expect(ticket3.blockedBy.map((b) => b.number)).toEqual([12, 13])

    // Verify dispatcher frontier sees only #12 (excluding parent Spec #11 and blocked #13, #14)
    const dispatchRes = await dispatchOnce({
      repoRoot,
      config: loaded.config,
      github,
      resolveAdapter: createAdapterResolver({
        dinesh: { async run() { return { reply: 'done' } } },
      }),
    })
    expect(dispatchRes.frontierIssues).toEqual([12])
  })

  it('rejects task graphs with unknown blockedBy references, duplicate IDs, or circular dependencies without creating partial issues', async () => {
    const repoRoot = makeTestRepo()
    const loaded = await loadConfig(repoRoot)
    const github = createInMemoryGitHubPort()

    // Case 1: Unknown blockedBy ID
    await expect(
      runRole({
        repoRoot,
        config: loaded.config,
        roleName: 'jared',
        target: 'docs/adr/0003.md',
        github,
        resolveAdapter: createAdapterResolver({
          jared: {
            async run() {
              return {
                reply: [
                  '```json',
                  JSON.stringify({
                    spec: { title: 'Spec: Broken', body: 'Spec body' },
                    tickets: [
                      {
                        id: 't1',
                        title: 'Ticket 1',
                        body: 'Body 1',
                        blockedBy: ['non-existent-id'],
                      },
                    ],
                  }),
                  '```',
                ].join('\n'),
              }
            },
          },
        }),
      }),
    ).rejects.toThrow(/non-existent-id|unknown/i)
    expect(await github.listOpenIssues()).toHaveLength(0)

    // Case 2: Circular dependency (t1 -> t2 -> t1)
    await expect(
      runRole({
        repoRoot,
        config: loaded.config,
        roleName: 'jared',
        target: 'docs/adr/0003.md',
        github,
        resolveAdapter: createAdapterResolver({
          jared: {
            async run() {
              return {
                reply: [
                  '```json',
                  JSON.stringify({
                    spec: { title: 'Spec: Cycle', body: 'Spec body' },
                    tickets: [
                      {
                        id: 't1',
                        title: 'Ticket 1',
                        body: 'Body 1',
                        blockedBy: ['t2'],
                      },
                      {
                        id: 't2',
                        title: 'Ticket 2',
                        body: 'Body 2',
                        blockedBy: ['t1'],
                      },
                    ],
                  }),
                  '```',
                ].join('\n'),
              }
            },
          },
        }),
      }),
    ).rejects.toThrow(/cycle|circular|循环/i)
    expect(await github.listOpenIssues()).toHaveLength(0)

    // Case 3: Duplicate ticket ID
    await expect(
      runRole({
        repoRoot,
        config: loaded.config,
        roleName: 'jared',
        target: 'docs/adr/0003.md',
        github,
        resolveAdapter: createAdapterResolver({
          jared: {
            async run() {
              return {
                reply: [
                  '```json',
                  JSON.stringify({
                    spec: { title: 'Spec: Duplicate ID', body: 'Spec body' },
                    tickets: [
                      { id: 't1', title: 'Ticket 1', body: 'Body 1' },
                      { id: 't1', title: 'Ticket 2', body: 'Body 2' },
                    ],
                  }),
                  '```',
                ].join('\n'),
              }
            },
          },
        }),
      }),
    ).rejects.toThrow(/duplicate/i)
    expect(await github.listOpenIssues()).toHaveLength(0)
  })
})
