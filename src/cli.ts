#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createAdapterResolver, type Adapter, type AdapterResolverOptions } from './adapters.js'
import { loadConfig } from './config.js'
import { runRole } from './runner.js'

export interface CliDeps {
  cwd?: string
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  adapterOverrides?: Partial<Record<string, Adapter>>
  adapterDefaults?: AdapterResolverOptions
}

const HELP_TEXT = [
  'Usage:',
  '  piedpiper run <role> <target> [--repo <path>] [--cwd <path>] [--timeout <ms>] [--session <id>]',
  '',
  'Options:',
  '  --repo <path>      Repository containing .piedpiper/config.json (default: cwd)',
  '  --cwd <path>       Working directory passed to the adapter (default: repo)',
  '  --timeout <ms>     Adapter execution timeout in milliseconds',
  '  --session <id>     Optional session ID to resume',
  '  -h, --help         Show this help message',
].join('\n')

function parseTimeoutOption(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --timeout value "${raw}": expected a positive integer (ms)`)
  }
  return parsed
}

/**
 * In-process CLI entry point returning a process exit code (`0` on success, non-zero on error).
 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text))
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text))

  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        repo: { type: 'string' },
        cwd: { type: 'string' },
        timeout: { type: 'string' },
        session: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    })

    if (parsed.values.help || parsed.positionals.length === 0) {
      stdout(`${HELP_TEXT}\n`)
      return parsed.values.help ? 0 : 1
    }

    const [subcommand, roleName, target, ...extra] = parsed.positionals
    if (subcommand !== 'run') {
      stderr(`Unknown subcommand "${subcommand}". Expected "run".\n`)
      return 1
    }

    if (!roleName || !target || extra.length > 0) {
      stderr('Usage: piedpiper run <role> <target> [options]\n')
      return 1
    }

    const repoRoot = path.resolve(parsed.values.repo ?? deps.cwd ?? process.cwd())
    const timeoutMs = parseTimeoutOption(parsed.values.timeout)

    const loaded = await loadConfig(repoRoot)
    for (const warning of loaded.warnings) {
      stderr(`${warning}\n`)
    }

    const result = await runRole({
      repoRoot,
      config: loaded.config,
      roleName,
      target,
      resolveAdapter: createAdapterResolver(deps.adapterOverrides, deps.adapterDefaults),
      cwd: parsed.values.cwd ? path.resolve(parsed.values.cwd) : undefined,
      timeoutMs,
      sessionId: parsed.values.session,
    })

    if (result.reply.length > 0) {
      stdout(result.reply.endsWith('\n') ? result.reply : `${result.reply}\n`)
    }
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stderr(`Error: ${message}\n`)
    return 1
  }
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isExecutedDirectly()) {
  const code = await runCli(process.argv.slice(2))
  process.exitCode = code
}
