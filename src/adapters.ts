import { spawn } from 'node:child_process'
import type { AccessMode, RoleConfig } from './config.js'

export interface AdapterRequest {
  prompt: string
  cwd: string
  model?: string
  sessionId?: string
  access?: AccessMode
  timeoutMs: number
}

export interface AdapterUsage {
  inputTokens: number
  outputTokens: number
}

export interface AdapterResponse {
  reply: string
  sessionId?: string
  usage?: AdapterUsage
}

/** Unified outer-seam contract implemented by CLI adapters and test fakes. */
export interface Adapter {
  run(req: AdapterRequest): Promise<AdapterResponse>
}

export type AdapterResolver = (roleName: string, roleConfig: RoleConfig) => Adapter

export interface SubprocessResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Diagnostic error raised when spawning or running a CLI adapter subprocess fails. */
export class AdapterError extends Error {
  readonly exitCode: number | null
  readonly stderr: string
  readonly timedOut: boolean

  constructor(
    message: string,
    options?: { exitCode?: number | null; stderr?: string; timedOut?: boolean },
  ) {
    super(message)
    this.name = 'AdapterError'
    this.exitCode = options?.exitCode ?? null
    this.stderr = options?.stderr ?? ''
    this.timedOut = options?.timedOut ?? false
  }
}

/**
 * Executes a subprocess directly via an argument array (`shell: false`) with timeout enforcement.
 * Never passes arguments through a shell.
 */
export function execSubprocess(
  command: string,
  args: string[],
  options: {
    cwd: string
    timeoutMs: number
    env?: NodeJS.ProcessEnv
    stdin?: string
  },
): Promise<SubprocessResult> {
  if (command.trim().length === 0) {
    return Promise.reject(new AdapterError('Command executable must be a non-empty string'))
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined

    const finishError = (err: AdapterError) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)
      reject(err)
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL')
        }
      }, 2000)
      killTimer.unref()
    }, options.timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      const hint =
        err.code === 'ENOENT'
          ? `Executable "${command}" was not found in PATH (${err.message})`
          : `Failed to spawn "${command}": ${err.message}`
      finishError(
        new AdapterError(hint, {
          exitCode: null,
          stderr,
          timedOut: false,
        }),
      )
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer) clearTimeout(killTimer)

      if (timedOut) {
        reject(
          new AdapterError(`Command "${command}" timed out after ${options.timeoutMs}ms`, {
            exitCode: code,
            stderr,
            timedOut: true,
          }),
        )
        return
      }

      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      })
    })

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin)
    }
    child.stdin.end()
  })
}

export interface CommandAdapterOptions {
  command: string
  args?: string[]
  promptFlag?: string
  modelFlag?: string
}

export interface CliAdapterOptions {
  command?: string
  baseArgs?: string[]
}

export interface AdapterResolverOptions {
  claude?: CliAdapterOptions
  codex?: CliAdapterOptions
}

function assertExitZero(command: string, result: SubprocessResult): void {
  if (result.exitCode === 0) {
    return
  }
  const detailSource = result.stderr.trim() || result.stdout.trim()
  const detail = detailSource.length > 0 ? `: ${detailSource.slice(0, 500)}` : ''
  throw new AdapterError(
    `Command "${command}" exited with code ${result.exitCode}${detail}`,
    {
      exitCode: result.exitCode,
      stderr: result.stderr,
      timedOut: false,
    },
  )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function extractUsage(rawUsage: unknown): AdapterUsage | undefined {
  const usage = asRecord(rawUsage)
  if (!usage) return undefined

  const rawInput = asFiniteNumber(usage.inputTokens) ?? asFiniteNumber(usage.input_tokens)
  const cacheCreation = asFiniteNumber(usage.cache_creation_input_tokens) ?? 0
  const cacheRead = asFiniteNumber(usage.cache_read_input_tokens) ?? 0
  const outputTokens = asFiniteNumber(usage.outputTokens) ?? asFiniteNumber(usage.output_tokens)

  if (rawInput === undefined && outputTokens === undefined) {
    return undefined
  }

  return {
    inputTokens: (rawInput ?? 0) + cacheCreation + cacheRead,
    outputTokens: outputTokens ?? 0,
  }
}

function buildCommandArgs(options: CommandAdapterOptions, req: AdapterRequest): string[] {
  const baseArgs = options.args ?? []
  let replacedPlaceholder = false

  const argv = baseArgs.map((arg) => {
    if (arg === '{prompt}') {
      replacedPlaceholder = true
      return req.prompt
    }
    return arg
  })

  if (options.modelFlag && req.model) {
    argv.push(options.modelFlag, req.model)
  }

  if (!replacedPlaceholder) {
    if (options.promptFlag) {
      argv.push(options.promptFlag, req.prompt)
    } else {
      argv.push(req.prompt)
    }
  }

  return argv
}

/**
 * Generic `command` adapter executing a local executable directly with `shell: false`.
 * Prompts are passed as an isolated argv element so special characters cannot trigger shell injection.
 */
export function createCommandAdapter(options: CommandAdapterOptions): Adapter {
  return {
    async run(req: AdapterRequest): Promise<AdapterResponse> {
      const argv = buildCommandArgs(options, req)
      const result = await execSubprocess(options.command, argv, {
        cwd: req.cwd,
        timeoutMs: req.timeoutMs,
      })

      assertExitZero(options.command, result)

      return {
        reply: result.stdout.trim(),
      }
    },
  }
}

function buildClaudeArgs(baseArgs: string[], req: AdapterRequest): string[] {
  const argv = [...baseArgs, '-p', '--output-format', 'json']
  if (req.model) {
    argv.push('--model', req.model)
  }
  if (req.sessionId) {
    argv.push('--resume', req.sessionId)
  }
  if (req.access === 'read') {
    argv.push('--permission-mode', 'plan')
  } else if (req.access === 'write') {
    argv.push('--permission-mode', 'acceptEdits')
  }
  argv.push('--', req.prompt)
  return argv
}

function parseClaudeOutput(stdout: string): AdapterResponse {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    return { reply: '' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { reply: trimmed }
  }

  const record = Array.isArray(parsed)
    ? asRecord(parsed.at(-1))
    : asRecord(parsed)
  if (!record) {
    return { reply: trimmed }
  }

  if (record.is_error === true) {
    const detail = asString(record.result) ?? asString(record.error) ?? 'Claude CLI returned an error'
    throw new AdapterError(`Claude CLI error: ${detail}`)
  }

  const reply =
    asString(record.result) ??
    asString(record.reply) ??
    asString(record.message) ??
    asString(record.text) ??
    trimmed

  const sessionId = asString(record.session_id) ?? asString(record.sessionId)
  const usage = extractUsage(record.usage)

  return {
    reply: reply.trim(),
    sessionId,
    usage,
  }
}

/**
 * Claude Code CLI adapter using non-interactive `--print` mode with JSON output and `shell: false`.
 */
export function createClaudeAdapter(options: CliAdapterOptions = {}): Adapter {
  const command = options.command ?? 'claude'
  const baseArgs = options.baseArgs ?? []

  return {
    async run(req: AdapterRequest): Promise<AdapterResponse> {
      const argv = buildClaudeArgs(baseArgs, req)
      const result = await execSubprocess(command, argv, {
        cwd: req.cwd,
        timeoutMs: req.timeoutMs,
      })

      assertExitZero(command, result)
      return parseClaudeOutput(result.stdout)
    },
  }
}

function buildCodexArgs(baseArgs: string[], req: AdapterRequest): string[] {
  const argv = [...baseArgs, 'exec']
  if (req.sessionId) {
    argv.push('resume', '--json')
    if (req.model) {
      argv.push('-m', req.model)
    }
    argv.push(req.sessionId, req.prompt)
    return argv
  }

  argv.push('--json', '-C', req.cwd)
  if (req.model) {
    argv.push('-m', req.model)
  }
  if (req.access === 'read') {
    argv.push('-s', 'read-only')
  } else if (req.access === 'write') {
    argv.push('-s', 'workspace-write')
  }
  argv.push('--', req.prompt)
  return argv
}

function extractCodexMessageText(event: Record<string, unknown>): string | undefined {
  const item = asRecord(event.item)
  if (!item) return undefined
  if (item.type !== 'agent_message' && item.type !== 'message') {
    return undefined
  }
  const directText = asString(item.text)
  if (directText !== undefined) {
    return directText
  }
  if (Array.isArray(item.content)) {
    const texts = item.content
      .map((part) => asString(asRecord(part)?.text))
      .filter((t): t is string => t !== undefined)
    if (texts.length > 0) {
      return texts.join('\n')
    }
  }
  return undefined
}

function parseCodexOutput(stdout: string): AdapterResponse {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    return { reply: '' }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  let parsedAnyJson = false
  let sessionId: string | undefined
  let reply: string | undefined
  let usage: AdapterUsage | undefined
  let failureMessage: string | undefined

  for (const line of lines) {
    let eventRaw: unknown
    try {
      eventRaw = JSON.parse(line)
    } catch {
      continue
    }
    const event = asRecord(eventRaw)
    if (!event) continue
    parsedAnyJson = true

    if (event.type === 'thread.started') {
      sessionId = asString(event.thread_id) ?? asString(event.session_id) ?? asString(event.sessionId)
    } else if (event.type === 'item.completed') {
      const text = extractCodexMessageText(event)
      if (text !== undefined) {
        reply = text
      }
    } else if (event.type === 'turn.completed') {
      const parsedUsage = extractUsage(event.usage)
      if (parsedUsage) {
        usage = parsedUsage
      }
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      const errObj = asRecord(event.error)
      failureMessage =
        asString(errObj?.message) ?? asString(event.message) ?? 'Codex turn failed'
    }
  }

  if (failureMessage) {
    throw new AdapterError(`Codex CLI error: ${failureMessage}`)
  }

  if (!parsedAnyJson) {
    return { reply: trimmed }
  }

  return {
    reply: (reply ?? '').trim(),
    sessionId,
    usage,
  }
}

/**
 * Codex CLI adapter using non-interactive `codex exec --json` and `shell: false`.
 */
export function createCodexAdapter(options: CliAdapterOptions = {}): Adapter {
  const command = options.command ?? 'codex'
  const baseArgs = options.baseArgs ?? []

  return {
    async run(req: AdapterRequest): Promise<AdapterResponse> {
      const argv = buildCodexArgs(baseArgs, req)
      const result = await execSubprocess(command, argv, {
        cwd: req.cwd,
        timeoutMs: req.timeoutMs,
      })

      assertExitZero(command, result)
      return parseCodexOutput(result.stdout)
    },
  }
}

/**
 * Resolves an `Adapter` for a given role, preferring test/caller overrides by role name or adapter type.
 */
export function createAdapterResolver(
  overrides?: Partial<Record<string, Adapter>>,
  defaults?: AdapterResolverOptions,
): AdapterResolver {
  return (roleName: string, roleConfig: RoleConfig): Adapter => {
    const override = overrides?.[roleName] ?? overrides?.[roleConfig.adapter]
    if (override) {
      return override
    }

    if (roleConfig.adapter === 'claude') {
      return createClaudeAdapter(defaults?.claude)
    }

    if (roleConfig.adapter === 'codex') {
      return createCodexAdapter(defaults?.codex)
    }

    if (roleConfig.adapter === 'command') {
      if (!roleConfig.command || roleConfig.command.length === 0) {
        throw new AdapterError(
          `Role "${roleName}" uses "command" adapter but no "command" executable is configured`,
        )
      }
      const [command, ...args] = roleConfig.command
      return createCommandAdapter({ command: command!, args })
    }

    throw new AdapterError(
      `Unsupported adapter "${roleConfig.adapter}" for role "${roleName}"`,
    )
  }
}
