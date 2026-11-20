import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AdapterError, createCommandAdapter } from '../src/adapters.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'piedpiper-cmd-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('createCommandAdapter', () => {
  it('passes prompts with quotes, newlines, dollar signs, and semicolons verbatim without shell interpretation', async () => {
    const dir = makeTempDir()
    const sentinelFile = path.join(dir, 'injected.txt')
    const scriptPath = path.join(dir, 'echo-argv.mjs')

    writeFileSync(
      scriptPath,
      [
        'import { writeFileSync } from "node:fs";',
        'const payload = { cwd: process.cwd(), argv: process.argv.slice(2) };',
        'process.stdout.write(JSON.stringify(payload));',
      ].join('\n'),
      'utf8',
    )

    const adapter = createCommandAdapter({
      command: process.execPath,
      args: [scriptPath, '--flag'],
    })

    const trickyPrompt = [
      'Line 1 with "double quotes" and \'single quotes\'',
      'Line 2 with $HOME $(uname) `id`',
      `Line 3; touch "${sentinelFile}" && echo pwned`,
    ].join('\n')

    const res = await adapter.run({
      prompt: trickyPrompt,
      cwd: dir,
      timeoutMs: 5000,
    })

    const parsed = JSON.parse(res.reply) as { cwd: string; argv: string[] }
    expect(existsSync(sentinelFile)).toBe(false)
    expect(parsed.argv).toEqual(['--flag', trickyPrompt])
  })

  it('supports {prompt} placeholder replacement inside args without shell', async () => {
    const dir = makeTempDir()
    const scriptPath = path.join(dir, 'echo-argv.mjs')
    writeFileSync(
      scriptPath,
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));',
      'utf8',
    )

    const adapter = createCommandAdapter({
      command: process.execPath,
      args: [scriptPath, '--prompt', '{prompt}', '--tail'],
    })

    const res = await adapter.run({
      prompt: 'hello $USER\nworld',
      cwd: dir,
      timeoutMs: 5000,
    })

    expect(JSON.parse(res.reply)).toEqual(['--prompt', 'hello $USER\nworld', '--tail'])
  })

  it('rejects with diagnostic AdapterError including stderr on non-zero exit code', async () => {
    const dir = makeTempDir()
    const scriptPath = path.join(dir, 'fail.mjs')
    writeFileSync(
      scriptPath,
      'process.stderr.write("boom details"); process.exit(2);',
      'utf8',
    )

    const adapter = createCommandAdapter({
      command: process.execPath,
      args: [scriptPath],
    })

    await expect(
      adapter.run({ prompt: 'test', cwd: dir, timeoutMs: 5000 }),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof AdapterError &&
        err.exitCode === 2 &&
        err.stderr.includes('boom details') &&
        err.timedOut === false
      )
    })
  })

  it('terminates hung subprocesses when timeoutMs expires', async () => {
    const dir = makeTempDir()
    const scriptPath = path.join(dir, 'hang.mjs')
    writeFileSync(scriptPath, 'setTimeout(() => {}, 30000);', 'utf8')

    const adapter = createCommandAdapter({
      command: process.execPath,
      args: [scriptPath],
    })

    await expect(
      adapter.run({ prompt: 'test', cwd: dir, timeoutMs: 100 }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof AdapterError && err.timedOut === true
    })
  })

  it('throws diagnostic AdapterError when command binary does not exist', async () => {
    const dir = makeTempDir()
    const adapter = createCommandAdapter({
      command: 'piedpiper-nonexistent-binary-xyz',
    })

    await expect(
      adapter.run({ prompt: 'test', cwd: dir, timeoutMs: 5000 }),
    ).rejects.toThrow(AdapterError)
  })
})
