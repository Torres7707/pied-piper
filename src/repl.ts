import readline from 'node:readline'
import { readFile } from 'node:fs/promises'
import type { AdapterResolver } from './adapters.js'
import { loadConfig, type PiedPiperConfig } from './config.js'
import { dispatchOnce, dispatchPoll } from './dispatcher.js'
import type { EventLog, EventLogEntry } from './event-log.js'
import type { GitHubPort } from './github.js'
import { createDefaultInitProbe, runInit, type InitProbe } from './init.js'
import type { Notifier } from './notifications.js'
import {
  DEFAULT_RUN_TIMEOUT_MS,
  formatPublishedTaskGraphSummary,
  runRole,
} from './runner.js'
import { formatStatusBoard } from './status.js'

export const REPL_PROMPT = 'piedpiper> '

const NO_SESSION_HINT =
  'No Richard session yet. Discuss an idea with Richard first, or run /jared #N explicitly.\n'

export interface ReplDriver {
  readLine(prompt: string): Promise<string | null>
  onSigint(listener: () => void): () => void
  close(): void
}

export interface RunReplInput {
  repoRoot: string
  config: PiedPiperConfig
  stdout: (text: string) => void
  stderr: (text: string) => void
  resolveAdapter: AdapterResolver
  github?: GitHubPort
  eventLog?: EventLog
  notifier?: Notifier
  worktreeBaseDir?: string
  timeoutMs?: number
  maxPollCycles?: number
  driver: ReplDriver
  initProbe?: InitProbe
}

interface ConclusionDraft {
  title: string
  body: string
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonCandidates(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const inner = match[1]?.trim()
    if (inner) found.push(inner)
  }
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    found.push(trimmed)
  }
  return found
}

function parseConclusion(reply: string): ConclusionDraft | undefined {
  let found: ConclusionDraft | undefined
  for (const candidate of jsonCandidates(reply)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!isPlainRecord(parsed)) continue
    const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
    const body = typeof parsed.body === 'string' ? parsed.body.trim() : ''
    if (!title || !body) continue
    found = { title, body }
  }
  return found
}

function formatEventLine(entry: EventLogEntry): string {
  const outcome = entry.decision ?? entry.status ?? '-'
  return `[${entry.timestamp}] ${entry.type} ${entry.role ?? '-'} ${entry.target ?? '-'} ${outcome}`
}

function parseSlash(line: string): { name: string; args: string } | undefined {
  const trimmedStart = line.trimStart()
  if (!trimmedStart.startsWith('/')) return undefined
  const trimmed = trimmedStart.trim()
  const space = trimmed.search(/\s/)
  if (space === -1) {
    return { name: trimmed.slice(1).toLowerCase(), args: '' }
  }
  return {
    name: trimmed.slice(1, space).toLowerCase(),
    args: trimmed.slice(space + 1).trim(),
  }
}

/**
 * Production REPL driver. Ctrl+C is delivered through `onSigint` and does not close the interface,
 * so a poll can be aborted without ending the session.
 */
export function createStdioReplDriver(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): ReplDriver {
  const rl = readline.createInterface({
    input,
    output,
    terminal: Boolean((input as NodeJS.ReadStream).isTTY),
  })
  rl.on('SIGINT', () => {
    // A listener here keeps readline from treating Ctrl+C as EOF.
  })

  const listeners = new Set<() => void>()
  const onProcessSigint = (): void => {
    for (const listener of [...listeners]) listener()
  }
  process.on('SIGINT', onProcessSigint)

  let closed = false
  return {
    readLine(prompt: string): Promise<string | null> {
      if (closed) return Promise.resolve(null)
      return new Promise((resolve) => {
        let settled = false
        const finish = (value: string | null): void => {
          if (settled) return
          settled = true
          rl.off('close', onClose)
          resolve(value)
        }
        const onClose = (): void => finish(null)
        rl.once('close', onClose)
        rl.question(prompt, (answer) => finish(answer))
      })
    },
    onSigint(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close(): void {
      if (closed) return
      closed = true
      process.off('SIGINT', onProcessSigint)
      rl.close()
    },
  }
}

type LineResult = 'continue' | 'exit'

/**
 * Interactive `piedpiper>` session. Returns 0 when the developer exits, hits EOF, or presses Ctrl+C at the prompt.
 */
export async function runRepl(input: RunReplInput): Promise<number> {
  const { repoRoot, stdout, stderr, resolveAdapter, driver } = input
  let config = input.config
  let richardSessionId: string | undefined
  const timeoutMs = input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS

  const hold = (): void => {}
  process.on('SIGINT', hold)

  const requireGithub = (): GitHubPort => {
    if (!input.github) {
      throw new Error('GitHub port is unavailable: repository has no GitHub remote configured')
    }
    return input.github
  }

  const writeReply = (reply: string): void => {
    if (reply.length === 0) return
    stdout(reply.endsWith('\n') ? reply : `${reply}\n`)
  }

  const appendEvent = async (entry: Omit<EventLogEntry, 'timestamp'>): Promise<void> => {
    await input.eventLog?.append({
      timestamp: new Date().toISOString(),
      ...entry,
    })
  }

  const talkToRichard = async (userText: string): Promise<void> => {
    const role = config.roles.richard
    if (!role) {
      throw new Error('Role "richard" is not configured')
    }
    const firstTurn = richardSessionId === undefined
    let prompt = userText
    if (firstTurn) {
      const roleText = await readFile(role.promptPath, 'utf8')
      prompt = [
        roleText.trim(),
        '',
        '## Context Pointers',
        '- Domain glossary: GLOSSARY.md',
        '- Architecture decisions: docs/adr/',
        '',
        '## Developer Message',
        userText,
      ].join('\n')
    }

    await appendEvent({
      type: 'run.started',
      role: 'richard',
      target: 'repl',
      adapter: role.adapter,
      model: role.model,
      status: 'started',
    })

    try {
      const response = await resolveAdapter('richard', role).run({
        prompt,
        cwd: repoRoot,
        model: role.model,
        sessionId: firstTurn ? undefined : richardSessionId,
        access: role.access,
        timeoutMs,
      })
      if (response.sessionId && response.sessionId.length > 0) {
        richardSessionId = response.sessionId
      }
      await appendEvent({
        type: 'run.completed',
        role: 'richard',
        target: 'repl',
        adapter: role.adapter,
        model: role.model,
        status: 'ok',
        usage: response.usage,
        sessionId: response.sessionId,
        decision: 'completed',
      })
      writeReply(response.reply)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await appendEvent({
        type: 'run.failed',
        role: 'richard',
        target: 'repl',
        adapter: role.adapter,
        model: role.model,
        status: 'failed',
        error: message,
      }).catch(() => {})
      throw error
    }
  }

  const distillConclusion = async (titleOverride?: string): Promise<ConclusionDraft | undefined> => {
    if (richardSessionId === undefined) {
      stderr(NO_SESSION_HINT)
      return undefined
    }
    const role = config.roles.richard
    if (!role) {
      throw new Error('Role "richard" is not configured')
    }
    const prompt = [
      'Distill the agreed conclusion of this conversation into one JSON object and nothing else.',
      'Shape: { "title": "...", "body": "..." }',
      'The body must cover the background problem, the chosen direction, the key constraints, and what is out of scope.',
      titleOverride ? `Prefer this title if you mention one: ${titleOverride}` : '',
    ]
      .filter((line) => line.length > 0)
      .join('\n')

    await appendEvent({
      type: 'run.started',
      role: 'richard',
      target: 'repl',
      adapter: role.adapter,
      model: role.model,
      status: 'started',
    })
    const response = await resolveAdapter('richard', role).run({
      prompt,
      cwd: repoRoot,
      model: role.model,
      sessionId: richardSessionId,
      access: role.access,
      timeoutMs,
    })
    if (response.sessionId && response.sessionId.length > 0) {
      richardSessionId = response.sessionId
    }
    await appendEvent({
      type: 'run.completed',
      role: 'richard',
      target: 'repl',
      adapter: role.adapter,
      model: role.model,
      status: 'ok',
      usage: response.usage,
      sessionId: response.sessionId,
      decision: 'completed',
    })

    const draft = parseConclusion(response.reply)
    if (!draft) {
      stderr('Richard did not return a JSON object with string "title" and "body".\n')
      return undefined
    }
    return {
      title: titleOverride && titleOverride.length > 0 ? titleOverride : draft.title,
      body: draft.body,
    }
  }

  const createConclusionIssue = async (titleOverride?: string): Promise<number | undefined> => {
    const draft = await distillConclusion(titleOverride)
    if (!draft) return undefined
    const github = requireGithub()
    const created = await github.createIssue({ title: draft.title, body: draft.body })
    stdout(`Created Issue #${created.number}\n`)
    return created.number
  }

  const runNamedRole = async (roleName: string, target: string): Promise<void> => {
    const result = await runRole({
      repoRoot,
      config,
      roleName,
      target,
      resolveAdapter,
      timeoutMs,
      github: input.github,
      worktreeBaseDir: input.worktreeBaseDir,
      eventLog: input.eventLog,
      notifier: input.notifier,
    })
    writeReply(result.reply)
    if (result.publishedSpecNumber !== undefined) {
      stdout(
        `${formatPublishedTaskGraphSummary(
          result.publishedSpecNumber,
          result.publishedTicketNumbers ?? [],
        )}\n`,
      )
    }
  }

  const reloadConfig = async (): Promise<void> => {
    const loaded = await loadConfig(repoRoot)
    config = loaded.config
    for (const warning of loaded.warnings) {
      stderr(`${warning}\n`)
    }
  }

  const printHelp = (): void => {
    stdout(
      [
        'Slash commands:',
        '  /status                         Four-group board (same as piedpiper status)',
        '  /events [n]                     Last n event-log lines (default 10)',
        '  /dispatch [--once|--poll] [--interval <sec>]',
        '  /run <role> <target>            Run one role against a target pointer',
        '  /init [--force]                 Fill missing init files, or overwrite with --force',
        '  /issue [title]                  Create a GitHub issue from the Richard session',
        '  /jared [#N|path]                Publish a spec and tickets; no args distill first',
        '  /reset                          Forget the Richard session id',
        '  /help                           Show this list',
        '  /exit, /quit                    Leave the REPL',
        'Plain text is sent to Richard. Ctrl+C during /dispatch --poll returns here.',
        'Ctrl+C, Ctrl+D, or /exit at this prompt quits.',
        '',
      ].join('\n'),
    )
  }

  const handleDispatch = async (args: string): Promise<void> => {
    const tokens = args.split(/\s+/).filter((token) => token.length > 0)
    let once = false
    let poll = false
    let intervalSec: number | undefined
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (token === '--once') {
        once = true
        continue
      }
      if (token === '--poll') {
        poll = true
        continue
      }
      if (token === '--interval') {
        const raw = tokens[index + 1]
        index += 1
        const parsed = Number(raw)
        if (!raw || !Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(`Invalid --interval value "${raw ?? ''}": expected a positive integer`)
        }
        intervalSec = parsed
        continue
      }
      throw new Error(`Unknown dispatch option "${token ?? ''}"`)
    }
    if (once && poll) {
      throw new Error('Use either --once or --poll, not both.')
    }
    if (intervalSec !== undefined && !poll) {
      throw new Error('--interval applies only to /dispatch --poll')
    }

    const github = requireGithub()
    const dispatchInput = {
      repoRoot,
      config,
      github,
      resolveAdapter,
      worktreeBaseDir: input.worktreeBaseDir,
      timeoutMs,
      eventLog: input.eventLog,
      notifier: input.notifier,
    }

    if (poll) {
      const controller = new AbortController()
      const unsubscribe = driver.onSigint(() => controller.abort())
      try {
        const cycles = await dispatchPoll({
          ...dispatchInput,
          intervalMs:
            intervalSec !== undefined
              ? intervalSec * 1000
              : config.runtime.dispatcher.pollIntervalSec * 1000,
          maxCycles: input.maxPollCycles,
          signal: controller.signal,
          onCycle: (res, cycle) => {
            stdout(
              `Cycle ${cycle}: frontier=[${res.frontierIssues.join(',')}] dinesh=[${res.dispatchedDinesh.join(',')}] gilfoyle=[${res.dispatchedGilfoyle.join(',')}] halted=${res.halted}\n`,
            )
          },
        })
        if (controller.signal.aborted) {
          stdout('Dispatch poll stopped.\n')
        }
        for (const cycle of cycles) {
          for (const error of cycle.errors) stderr(`${error}\n`)
        }
      } finally {
        unsubscribe()
      }
      return
    }

    const res = await dispatchOnce(dispatchInput)
    stdout(
      `Dispatch: frontier=[${res.frontierIssues.map((n) => `#${n}`).join(',')}] dinesh=[${res.dispatchedDinesh.map((n) => `#${n}`).join(',')}] gilfoyle=[${res.dispatchedGilfoyle.map((n) => `PR #${n}`).join(',')}] halted=${res.halted}\n`,
    )
    for (const error of res.errors) stderr(`${error}\n`)
  }

  const handleLine = async (line: string): Promise<LineResult> => {
    if (line.trim().length === 0) return 'continue'
    const command = parseSlash(line)
    if (!command) {
      await talkToRichard(line)
      return 'continue'
    }

    switch (command.name) {
      case 'exit':
      case 'quit':
        return 'exit'
      case 'help':
        printHelp()
        return 'continue'
      case 'reset':
        richardSessionId = undefined
        stdout('Richard session reset. The next message starts a new conversation.\n')
        return 'continue'
      case 'status': {
        const github = requireGithub()
        const [issues, pullRequests] = await Promise.all([
          github.listOpenIssues(),
          github.listOpenPullRequests(),
        ])
        stdout(formatStatusBoard(issues, pullRequests))
        return 'continue'
      }
      case 'events': {
        let count = 10
        if (command.args.length > 0) {
          if (!/^\d+$/.test(command.args) || Number(command.args) <= 0) {
            throw new Error(`Invalid /events count "${command.args}": expected a positive integer`)
          }
          count = Number(command.args)
        }
        const events = (await input.eventLog?.readEvents()) ?? []
        const selected = events.slice(-count)
        stdout(selected.length === 0 ? '(none)\n' : `${selected.map(formatEventLine).join('\n')}\n`)
        return 'continue'
      }
      case 'dispatch':
        await handleDispatch(command.args)
        return 'continue'
      case 'run': {
        const match = command.args.match(/^(\S+)\s+([\s\S]+)$/)
        if (!match?.[1] || !match[2]) {
          throw new Error('Usage: /run <role> <target>')
        }
        await runNamedRole(match[1], match[2].trim())
        return 'continue'
      }
      case 'init': {
        const force = command.args === '--force'
        if (command.args.length > 0 && !force) {
          throw new Error('Usage: /init [--force]')
        }
        await runInit({
          repoRoot,
          force,
          probe: input.initProbe ?? createDefaultInitProbe(),
          github: input.github,
        })
        stdout(`Initialized .piedpiper in ${repoRoot}\n`)
        await reloadConfig()
        return 'continue'
      }
      case 'issue': {
        await createConclusionIssue(command.args.length > 0 ? command.args : undefined)
        return 'continue'
      }
      case 'jared': {
        if (command.args.length > 0) {
          await runNamedRole('jared', command.args)
          return 'continue'
        }
        const issueNumber = await createConclusionIssue()
        if (issueNumber === undefined) return 'continue'
        await runNamedRole('jared', `#${issueNumber}`)
        return 'continue'
      }
      default:
        stderr(`Unknown command "/${command.name}". Type /help for the command list.\n`)
        return 'continue'
    }
  }

  const readLineOrSigint = async (): Promise<'exit' | 'line'> => {
    let unsubscribe = (): void => {}
    try {
      const outcome = await new Promise<'sigint' | 'eof' | string>((resolve, reject) => {
        let settled = false
        const finish = (value: 'sigint' | 'eof' | string): void => {
          if (settled) return
          settled = true
          resolve(value)
        }
        unsubscribe = driver.onSigint(() => finish('sigint'))
        driver.readLine(REPL_PROMPT).then(
          (text) => finish(text === null ? 'eof' : text),
          (error: unknown) => {
            if (settled) return
            settled = true
            reject(error)
          },
        )
      })
      if (outcome === 'sigint' || outcome === 'eof') return 'exit'
      return (await handleLine(outcome)) === 'exit' ? 'exit' : 'line'
    } finally {
      unsubscribe()
    }
  }

  try {
    for (;;) {
      let step: 'exit' | 'line'
      try {
        step = await readLineOrSigint()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        stderr(`Error: ${message}\n`)
        continue
      }
      if (step === 'exit') return 0
    }
  } finally {
    process.off('SIGINT', hold)
  }
}
