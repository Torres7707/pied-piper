import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigValidationError, loadConfig } from '../src/config.js'

const tempDirs: string[] = []

function makeTempRepo(configObj: unknown, files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'piedpiper-config-test-'))
  tempDirs.push(root)
  const piedpiperDir = path.join(root, '.piedpiper')
  mkdirSync(path.join(piedpiperDir, 'roles'), { recursive: true })
  writeFileSync(path.join(piedpiperDir, 'config.json'), JSON.stringify(configObj, null, 2), 'utf8')
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(piedpiperDir, relPath)
    mkdirSync(path.dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, content, 'utf8')
  }
  return root
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('loadConfig', () => {
  it('loads the repository default .piedpiper/config.json without warnings', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '..')
    const loaded = await loadConfig(repoRoot)

    expect(loaded.warnings).toEqual([])
    expect(loaded.config.roles.dinesh?.adapter).toBe('claude')
    expect(loaded.config.roles.gilfoyle?.adapter).toBe('codex')
    expect(loaded.config.roles.gilfoyle?.access).toBe('read')
    expect(loaded.config.roles.dinesh?.access).toBe('write')
    expect(loaded.config.runtime.review.maxRounds).toBe(2)
    expect(loaded.config.runtime.dispatcher.maxHops).toBe(8)
  })

  it('rejects missing config.json with ConfigValidationError', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piedpiper-missing-'))
    tempDirs.push(root)

    await expect(loadConfig(root)).rejects.toThrow(ConfigValidationError)
  })

  it('rejects missing required role fields (adapter, access, prompt)', async () => {
    const missingAdapter = makeTempRepo(
      {
        roles: {
          dinesh: { access: 'write', prompt: 'roles/dinesh.md' },
        },
      },
      { 'roles/dinesh.md': '# Dinesh' },
    )
    await expect(loadConfig(missingAdapter)).rejects.toThrow(/adapter/i)

    const missingAccess = makeTempRepo(
      {
        roles: {
          dinesh: { adapter: 'claude', prompt: 'roles/dinesh.md' },
        },
      },
      { 'roles/dinesh.md': '# Dinesh' },
    )
    await expect(loadConfig(missingAccess)).rejects.toThrow(/access/i)

    const missingPrompt = makeTempRepo({
      roles: {
        dinesh: { adapter: 'claude', access: 'write' },
      },
    })
    await expect(loadConfig(missingPrompt)).rejects.toThrow(/prompt/i)
  })

  it('rejects invalid adapter type, invalid access mode, and missing role prompt file', async () => {
    const badAdapter = makeTempRepo(
      {
        roles: {
          dinesh: { adapter: 'openai-magic', access: 'write', prompt: 'roles/dinesh.md' },
        },
      },
      { 'roles/dinesh.md': '# Dinesh' },
    )
    await expect(loadConfig(badAdapter)).rejects.toThrow(/adapter/i)

    const badAccess = makeTempRepo(
      {
        roles: {
          gilfoyle: { adapter: 'codex', access: 'admin', prompt: 'roles/gilfoyle.md' },
        },
      },
      { 'roles/gilfoyle.md': '# Gilfoyle' },
    )
    await expect(loadConfig(badAccess)).rejects.toThrow(/access/i)

    const missingPromptFile = makeTempRepo({
      roles: {
        gilfoyle: { adapter: 'codex', access: 'read', prompt: 'roles/nonexistent.md' },
      },
    })
    await expect(loadConfig(missingPromptFile)).rejects.toThrow(/nonexistent\.md/i)
  })

  it('rejects prompt paths escaping the repository root', async () => {
    const escapedPrompt = makeTempRepo({
      roles: {
        dinesh: { adapter: 'claude', access: 'write', prompt: '../../etc/passwd' },
      },
    })
    await expect(loadConfig(escapedPrompt)).rejects.toThrow(ConfigValidationError)
  })

  it('warns without blocking when gilfoyle and dinesh share the same adapter and model', async () => {
    const root = makeTempRepo(
      {
        roles: {
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
      },
      {
        'roles/dinesh.md': '# Dinesh',
        'roles/gilfoyle.md': '# Gilfoyle',
      },
    )

    const loaded = await loadConfig(root)
    expect(loaded.warnings).toHaveLength(1)
    expect(loaded.warnings[0]).toMatch(/gilfoyle/i)
    expect(loaded.warnings[0]).toMatch(/dinesh/i)
  })

  it('warns when both gilfoyle and dinesh share the same adapter with omitted model', async () => {
    const root = makeTempRepo(
      {
        roles: {
          dinesh: { adapter: 'codex', access: 'write', prompt: 'roles/dinesh.md' },
          gilfoyle: { adapter: 'codex', access: 'read', prompt: 'roles/gilfoyle.md' },
        },
      },
      {
        'roles/dinesh.md': '# Dinesh',
        'roles/gilfoyle.md': '# Gilfoyle',
      },
    )

    const loaded = await loadConfig(root)
    expect(loaded.warnings).toHaveLength(1)
  })

  it('does not warn when gilfoyle and dinesh use the same adapter but different models', async () => {
    const root = makeTempRepo(
      {
        roles: {
          dinesh: {
            adapter: 'claude',
            model: 'claude-sonnet-5-5',
            access: 'write',
            prompt: 'roles/dinesh.md',
          },
          gilfoyle: {
            adapter: 'claude',
            model: 'claude-opus-5-5',
            access: 'read',
            prompt: 'roles/gilfoyle.md',
          },
        },
      },
      {
        'roles/dinesh.md': '# Dinesh',
        'roles/gilfoyle.md': '# Gilfoyle',
      },
    )

    const loaded = await loadConfig(root)
    expect(loaded.warnings).toEqual([])
  })

  it('requires githubHandle when runtime.notifications.githubMention is enabled', async () => {
    const root = makeTempRepo(
      {
        roles: {
          dinesh: { adapter: 'claude', access: 'write', prompt: 'roles/dinesh.md' },
        },
        runtime: {
          notifications: {
            desktop: true,
            githubMention: true,
            githubHandle: '',
          },
        },
      },
      { 'roles/dinesh.md': '# Dinesh' },
    )

    await expect(loadConfig(root)).rejects.toThrow(/githubHandle/i)
  })
})
