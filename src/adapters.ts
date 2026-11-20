import { spawn } from 'node:child_process'
import type { RoleConfig } from './config.js'

export interface AdapterRequest {
  prompt: string
  cwd: string
  model?: string
  sessionId?: string
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

    child.on('error', (err) => {
      finishError(
        new AdapterError(`Failed to spawn "${command}": ${err.message}`, {
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

      if (result.exitCode !== 0) {
        const stderrPreview = result.stderr.trim()
        const detail = stderrPreview.length > 0 ? `: ${stderrPreview}` : ''
        throw new AdapterError(
          `Command "${options.command}" exited with code ${result.exitCode}${detail}`,
          {
            exitCode: result.exitCode,
            stderr: result.stderr,
            timedOut: false,
          },
        )
      }

      return {
        reply: result.stdout.trim(),
      }
    },
  }
}

/**
 * Resolves an `Adapter` for a given role, preferring test/caller overrides by role name or adapter type.
 */
export function createAdapterResolver(
  overrides?: Partial<Record<string, Adapter>>,
): AdapterResolver {
  return (roleName: string, roleConfig: RoleConfig): Adapter => {
    const override = overrides?.[roleName] ?? overrides?.[roleConfig.adapter]
    if (override) {
      return override
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
      `Adapter "${roleConfig.adapter}" for role "${roleName}" is not wired in this build; use "command" or provide an adapter override`,
    )
  }
}
