import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Adapter, AdapterRequest, AdapterResponse } from '../src/adapters.js'
import { runCli } from '../src/cli.js'

const tempDirs: string[] = []

function makeTestRepo(
  roles: Record<string, unknown>,
  roleFiles: Record<string, string>,
): string {
  const root = mkdtempSync(path.join(tmpdir(), 'piedpiper-cli-test-'))
  tempDirs.push(root)
  const piedpiperDir = path.join(root, '.piedpiper')
  mkdirSync(path.join(piedpiperDir, 'roles'), { recursive: true })
  writeFileSync(path.join(piedpiperDir, 'config.json'), JSON.stringify({ roles }, null, 2), 'utf8')
  for (const [name, content] of Object.entries(roleFiles)) {
    writeFileSync(path.join(piedpiperDir, name), content, 'utf8')
  }
  return root
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('piedpiper run CLI', () => {
  it('loads config, assembles prompt with role instructions/skills/target, forwards model/cwd/timeout to adapter, and prints reply', async () => {
    const repoRoot = makeTestRepo(
      {
        dinesh: {
          adapter: 'claude',
          model: 'claude-sonnet-5-5',
          skills: ['tdd', 'codebase-design'],
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
      {
        'roles/dinesh.md': 'You are Dinesh. Implement ticket strictly via TDD.',
        'roles/gilfoyle.md': 'You are Gilfoyle. Read-only review.',
      },
    )

    const recordedRequests: AdapterRequest[] = []
    const fakeAdapter: Adapter = {
      async run(req: AdapterRequest): Promise<AdapterResponse> {
        recordedRequests.push(req)
        return {
          reply: 'Dinesh finished implementing #3',
          sessionId: 'sess-123',
          usage: { inputTokens: 100, outputTokens: 50 },
        }
      },
    }

    const workDir = mkdtempSync(path.join(tmpdir(), 'piedpiper-work-'))
    tempDirs.push(workDir)

    let stdout = ''
    let stderr = ''
    const exitCode = await runCli(
      ['run', 'dinesh', '#3', '--repo', repoRoot, '--cwd', workDir, '--timeout', '12345', '--session', 'prev-1'],
      {
        stdout: (chunk) => {
          stdout += chunk
        },
        stderr: (chunk) => {
          stderr += chunk
        },
        adapterOverrides: { dinesh: fakeAdapter },
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.trim()).toBe('Dinesh finished implementing #3')
    expect(recordedRequests).toHaveLength(1)

    const req = recordedRequests[0]!
    expect(req.cwd).toBe(workDir)
    expect(req.model).toBe('claude-sonnet-5-5')
    expect(req.timeoutMs).toBe(12345)
    expect(req.sessionId).toBe('prev-1')
    expect(req.prompt).toContain('You are Dinesh. Implement ticket strictly via TDD.')
    expect(req.prompt).toContain('tdd')
    expect(req.prompt).toContain('codebase-design')
    expect(req.prompt).toContain('#3')
    expect(req.prompt).toContain('access: write')
  })

  it('prints same-combination warning to stderr without blocking execution', async () => {
    const repoRoot = makeTestRepo(
      {
        dinesh: {
          adapter: 'claude',
          model: 'claude-sonnet-5-5',
          access: 'write',
          prompt: 'roles/dinesh.md',
        },
        gilfoyle: {
          adapter: 'claude',
          model: 'claude-sonnet-5-5',
          access: 'read',
          prompt: 'roles/gilfoyle.md',
        },
      },
      {
        'roles/dinesh.md': '# Dinesh',
        'roles/gilfoyle.md': '# Gilfoyle',
      },
    )

    const fakeAdapter: Adapter = {
      async run() {
        return { reply: 'ok' }
      },
    }

    let stdout = ''
    let stderr = ''
    const exitCode = await runCli(['run', 'gilfoyle', 'PR #9', '--repo', repoRoot], {
      stdout: (chunk) => {
        stdout += chunk
      },
      stderr: (chunk) => {
        stderr += chunk
      },
      adapterOverrides: { gilfoyle: fakeAdapter },
    })

    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe('ok')
    expect(stderr).toMatch(/warning|警告/i)
    expect(stderr).toMatch(/gilfoyle/i)
    expect(stderr).toMatch(/dinesh/i)
  })

  it('executes a real command adapter configured in config.json through piedpiper run', async () => {
    const scriptDir = mkdtempSync(path.join(tmpdir(), 'piedpiper-script-'))
    tempDirs.push(scriptDir)
    const scriptPath = path.join(scriptDir, 'echo-last.mjs')
    writeFileSync(
      scriptPath,
      'const prompt = process.argv.at(-1) ?? ""; process.stdout.write("ECHO:" + (prompt.includes("#7") ? "has-target" : "missing"));',
      'utf8',
    )

    const repoRoot = makeTestRepo(
      {
        jared: {
          adapter: 'command',
          command: [process.execPath, scriptPath],
          skills: ['to-spec'],
          access: 'read',
          prompt: 'roles/jared.md',
        },
      },
      {
        'roles/jared.md': '# Jared role instructions',
      },
    )

    let stdout = ''
    let stderr = ''
    const exitCode = await runCli(['run', 'jared', '#7', '--repo', repoRoot], {
      stdout: (chunk) => {
        stdout += chunk
      },
      stderr: (chunk) => {
        stderr += chunk
      },
    })

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.trim()).toBe('ECHO:has-target')
  })

  it('returns non-zero exit code with clear stderr error on invalid config, unknown role, or missing args', async () => {
    const repoRoot = makeTestRepo(
      {
        dinesh: {
          adapter: 'claude',
          access: 'write',
          prompt: 'roles/dinesh.md',
        },
      },
      { 'roles/dinesh.md': '# Dinesh' },
    )

    let errUnknownRole = ''
    const code1 = await runCli(['run', 'erlich', '#3', '--repo', repoRoot], {
      stdout: () => {},
      stderr: (chunk) => {
        errUnknownRole += chunk
      },
    })
    expect(code1).toBe(1)
    expect(errUnknownRole).toMatch(/erlich/i)

    let errMissingTarget = ''
    const code2 = await runCli(['run', 'dinesh', '--repo', repoRoot], {
      stdout: () => {},
      stderr: (chunk) => {
        errMissingTarget += chunk
      },
    })
    expect(code2).toBe(1)
    expect(errMissingTarget.length).toBeGreaterThan(0)

    const badRepo = makeTestRepo(
      {
        dinesh: { adapter: 'claude', access: 'invalid-mode', prompt: 'roles/dinesh.md' },
      },
      { 'roles/dinesh.md': '# Dinesh' },
    )
    let errBadConfig = ''
    const code3 = await runCli(['run', 'dinesh', '#3', '--repo', badRepo], {
      stdout: () => {},
      stderr: (chunk) => {
        errBadConfig += chunk
      },
    })
    expect(code3).toBe(1)
    expect(errBadConfig).toMatch(/access/i)
  })

  it('prints usage help and exits 0 on --help', async () => {
    let stdout = ''
    const code = await runCli(['--help'], {
      stdout: (chunk) => {
        stdout += chunk
      },
      stderr: () => {},
    })
    expect(code).toBe(0)
    expect(stdout).toContain('piedpiper run')
  })
})
