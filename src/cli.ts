#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createAdapterResolver, execSubprocess, type Adapter, type AdapterResolverOptions } from './adapters.js'
import { loadConfig } from './config.js'
import { dispatchOnce, dispatchPoll, resolveDefaultEventLogPath } from './dispatcher.js'
import { createJsonlEventLog, type EventLog } from './event-log.js'
import { createGhGitHubPort, type GitHubPort } from './github.js'
import { createDefaultInitProbe, runInit, type InitProbe } from './init.js'
import { createNotifier, type Notifier } from './notifications.js'
import { formatPublishedTaskGraphSummary, runRole } from './runner.js'
import { formatStatusBoard } from './status.js'
import { isGitRepo } from './worktree.js'

export interface CliDeps {
  cwd?: string
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  adapterOverrides?: Partial<Record<string, Adapter>>
  adapterDefaults?: AdapterResolverOptions
  github?: GitHubPort
  worktreeBaseDir?: string
  eventLog?: EventLog
  notifier?: Notifier
  maxPollCycles?: number
  signal?: AbortSignal
  initProbe?: InitProbe
}

const HELP_TEXT = [
  'Usage:',
  '  piedpiper init [--force] [--repo <path>]',
  '  piedpiper status [--repo <path>]',
  '  piedpiper run <role> <target> [--repo <path>] [--cwd <path>] [--timeout <ms>] [--session <id>]',
  '  piedpiper dispatch [--once | --poll] [--interval <sec>] [--hop <n>] [--repo <path>] [--timeout <ms>]',
  '',
  'Options:',
  '  --repo <path>      Repository containing .piedpiper/config.json (default: cwd)',
  '  --force            Re-detect the environment and overwrite init config and role files',
  '  --cwd <path>       Working directory passed to the adapter (default: repo)',
  '  --timeout <ms>     Adapter execution timeout in milliseconds',
  '  --session <id>     Optional session ID to resume',
  '  --once             Run a single dispatch cycle (default for dispatch)',
  '  --poll             Run dispatcher continuously at pollIntervalSec',
  '  --interval <sec>   Override poll interval in seconds',
  '  --hop <n>          Initial event chain hop count for dispatch',
  '  -h, --help         Show this help message',
].join('\n')

async function resolveDefaultGitHubPort(repoRoot: string): Promise<GitHubPort | undefined> {
  if (!(await isGitRepo(repoRoot))) {
    return undefined
  }
  const remote = await execSubprocess('git', ['remote', 'get-url', 'origin'], {
    cwd: repoRoot,
    timeoutMs: 5000,
  }).catch(() => undefined)
  if (!remote || remote.exitCode !== 0 || !remote.stdout.includes('github.com')) {
    return undefined
  }
  return createGhGitHubPort({ cwd: repoRoot })
}

function parsePositiveIntOption(raw: string | undefined, flagName: string): number | undefined {
  if (raw === undefined) {
    return undefined
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flagName} value "${raw}": expected a positive integer`)
  }
  return parsed
}

function parseNonNegativeIntOption(raw: string | undefined, flagName: string): number | undefined {
  if (raw === undefined) {
    return undefined
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${flagName} value "${raw}": expected a non-negative integer`)
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
        once: { type: 'boolean' },
        poll: { type: 'boolean' },
        interval: { type: 'string' },
        hop: { type: 'string' },
        force: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })

    if (parsed.values.help || parsed.positionals.length === 0) {
      stdout(`${HELP_TEXT}\n`)
      return parsed.values.help ? 0 : 1
    }

    const [subcommand, ...rest] = parsed.positionals
    if (
      subcommand !== 'run' &&
      subcommand !== 'dispatch' &&
      subcommand !== 'init' &&
      subcommand !== 'status'
    ) {
      stderr(`Unknown subcommand "${subcommand}". Expected "run", "dispatch", "init", or "status".\n`)
      return 1
    }

    const repoRoot = path.resolve(parsed.values.repo ?? deps.cwd ?? process.cwd())
    const timeoutMs = parsePositiveIntOption(parsed.values.timeout, '--timeout')

    if (subcommand === 'init') {
      if (rest.length > 0) {
        stderr('Usage: piedpiper init [--force] [--repo <path>]\n')
        return 1
      }
      const github = deps.github ?? (await resolveDefaultGitHubPort(repoRoot))
      await runInit({
        repoRoot,
        force: parsed.values.force === true,
        probe: deps.initProbe ?? createDefaultInitProbe(),
        github,
      })
      stdout(`Initialized .piedpiper in ${repoRoot}\n`)
      return 0
    }

    if (subcommand === 'status') {
      if (rest.length > 0) {
        stderr('Usage: piedpiper status [--repo <path>]\n')
        return 1
      }
      const github = deps.github ?? (await resolveDefaultGitHubPort(repoRoot))
      if (!github) {
        throw new Error('GitHub port is unavailable: repository has no GitHub remote configured')
      }
      const [issues, pullRequests] = await Promise.all([
        github.listOpenIssues(),
        github.listOpenPullRequests(),
      ])
      stdout(formatStatusBoard(issues, pullRequests))
      return 0
    }

    const loaded = await loadConfig(repoRoot)
    for (const warning of loaded.warnings) {
      stderr(`${warning}\n`)
    }

    const github = deps.github ?? (await resolveDefaultGitHubPort(repoRoot))
    const eventLog =
      deps.eventLog ??
      createJsonlEventLog(
        resolveDefaultEventLogPath(repoRoot, loaded.config.runtime.eventLog.path),
      )
    const notifier =
      deps.notifier ??
      createNotifier({
        config: loaded.config.runtime.notifications,
        github,
      })
    const resolveAdapter = createAdapterResolver(deps.adapterOverrides, deps.adapterDefaults)

    if (subcommand === 'dispatch') {
      if (rest.length > 0) {
        stderr('Usage: piedpiper dispatch [--once | --poll] [options]\n')
        return 1
      }
      if (!github) {
        throw new Error('GitHub port is unavailable: repository has no GitHub remote configured')
      }
      const hop = parseNonNegativeIntOption(parsed.values.hop, '--hop')
      const intervalSec = parsePositiveIntOption(parsed.values.interval, '--interval')
      const dispatchInput = {
        repoRoot,
        config: loaded.config,
        github,
        resolveAdapter,
        worktreeBaseDir: deps.worktreeBaseDir,
        timeoutMs,
        eventLog,
        notifier,
        hop,
      }

      if (parsed.values.poll) {
        const cycles = await dispatchPoll({
          ...dispatchInput,
          intervalMs:
            intervalSec !== undefined
              ? intervalSec * 1000
              : loaded.config.runtime.dispatcher.pollIntervalSec * 1000,
          maxCycles: deps.maxPollCycles,
          signal: deps.signal,
          onCycle: (res, cycle) => {
            stdout(
              `Cycle ${cycle}: frontier=[${res.frontierIssues.join(',')}] dinesh=[${res.dispatchedDinesh.join(',')}] gilfoyle=[${res.dispatchedGilfoyle.join(',')}] halted=${res.halted}\n`,
            )
          },
        })
        const last = cycles.at(-1)
        return last && last.errors.length > 0 ? 1 : 0
      }

      const res = await dispatchOnce(dispatchInput)
      stdout(
        `Dispatch: frontier=[${res.frontierIssues.map((n) => `#${n}`).join(',')}] dinesh=[${res.dispatchedDinesh.map((n) => `#${n}`).join(',')}] gilfoyle=[${res.dispatchedGilfoyle.map((n) => `PR #${n}`).join(',')}] halted=${res.halted}\n`,
      )
      return res.errors.length > 0 ? 1 : 0
    }

    const [roleName, target, ...extra] = rest
    if (!roleName || !target || extra.length > 0) {
      stderr('Usage: piedpiper run <role> <target> [options]\n')
      return 1
    }

    const result = await runRole({
      repoRoot,
      config: loaded.config,
      roleName,
      target,
      resolveAdapter,
      cwd: parsed.values.cwd ? path.resolve(parsed.values.cwd) : undefined,
      timeoutMs,
      sessionId: parsed.values.session,
      github,
      worktreeBaseDir: deps.worktreeBaseDir,
      eventLog,
      notifier,
    })

    if (result.reply.length > 0) {
      stdout(result.reply.endsWith('\n') ? result.reply : `${result.reply}\n`)
    }
    if (result.publishedSpecNumber !== undefined) {
      stdout(
        `${formatPublishedTaskGraphSummary(
          result.publishedSpecNumber,
          result.publishedTicketNumbers ?? [],
        )}\n`,
      )
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
