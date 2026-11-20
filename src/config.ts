import { access, readFile, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

export type AdapterType = 'claude' | 'codex' | 'command'
export type AccessMode = 'read' | 'write'

const SUPPORTED_ADAPTERS = new Set<AdapterType>(['claude', 'codex', 'command'])
const SUPPORTED_ACCESS = new Set<AccessMode>(['read', 'write'])

export interface RoleConfig {
  adapter: AdapterType
  model?: string
  skills: string[]
  parallel: number
  access: AccessMode
  prompt: string
  promptPath: string
  command?: string[]
}

export interface NotificationsConfig {
  desktop: boolean
  githubMention: boolean
  githubHandle: string
}

export interface ReviewConfig {
  maxRounds: number
  validateOutput: boolean
}

export interface DispatcherConfig {
  maxHops: number
  pollIntervalSec: number
}

export interface EventLogConfig {
  type: 'jsonl'
  path: string
}

export interface RuntimeConfig {
  notifications: NotificationsConfig
  review: ReviewConfig
  dispatcher: DispatcherConfig
  eventLog: EventLogConfig
}

export interface PiedPiperConfig {
  roles: Record<string, RoleConfig>
  runtime: RuntimeConfig
}

export interface LoadedConfig {
  config: PiedPiperConfig
  warnings: string[]
  configPath: string
  piedpiperDir: string
}

/** Error raised when `.piedpiper/config.json` or its referenced files fail validation. */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigValidationError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertNonEmptyString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigValidationError(`Invalid or missing "${fieldPath}": expected a non-empty string`)
  }
  return value.trim()
}

function assertPositiveInt(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ConfigValidationError(`Invalid "${fieldPath}": expected an integer >= 1`)
  }
  return value
}

function assertBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigValidationError(`Invalid "${fieldPath}": expected a boolean`)
  }
  return value
}

function parseSkills(raw: unknown, roleName: string): string[] {
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(`Invalid "roles.${roleName}.skills": expected an array of strings`)
  }
  return raw.map((item, index) => assertNonEmptyString(item, `roles.${roleName}.skills[${index}]`))
}

function parseCommand(raw: unknown, roleName: string): string[] | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw === 'string') {
    return [assertNonEmptyString(raw, `roles.${roleName}.command`)]
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigValidationError(
      `Invalid "roles.${roleName}.command": expected a non-empty string or non-empty array of strings`,
    )
  }
  return raw.map((item, index) => assertNonEmptyString(item, `roles.${roleName}.command[${index}]`))
}

function isSubPath(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function resolvePromptFile(
  repoRoot: string,
  piedpiperDir: string,
  rawPrompt: string,
  roleName: string,
): Promise<string> {
  const resolved = path.resolve(piedpiperDir, rawPrompt)
  if (!isSubPath(repoRoot, resolved)) {
    throw new ConfigValidationError(
      `Invalid "roles.${roleName}.prompt": path "${rawPrompt}" must stay inside repository root`,
    )
  }
  try {
    await access(resolved, constants.R_OK)
    const info = await stat(resolved)
    if (!info.isFile()) {
      throw new ConfigValidationError(
        `Invalid "roles.${roleName}.prompt": "${rawPrompt}" is not a regular file`,
      )
    }
    const [realRoot, realTarget] = await Promise.all([realpath(repoRoot), realpath(resolved)])
    if (!isSubPath(realRoot, realTarget)) {
      throw new ConfigValidationError(
        `Invalid "roles.${roleName}.prompt": symlink "${rawPrompt}" escapes repository root`,
      )
    }
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw error
    }
    throw new ConfigValidationError(
      `Missing role prompt file for "roles.${roleName}.prompt": "${rawPrompt}" (${resolved})`,
    )
  }
  return resolved
}

async function parseRole(
  roleName: string,
  rawRole: unknown,
  repoRoot: string,
  piedpiperDir: string,
): Promise<RoleConfig> {
  if (!isPlainObject(rawRole)) {
    throw new ConfigValidationError(`Invalid "roles.${roleName}": expected an object`)
  }

  const adapterRaw = assertNonEmptyString(rawRole.adapter, `roles.${roleName}.adapter`)
  if (!SUPPORTED_ADAPTERS.has(adapterRaw as AdapterType)) {
    throw new ConfigValidationError(
      `Unsupported "roles.${roleName}.adapter": "${adapterRaw}". Expected one of: claude, codex, command`,
    )
  }

  const accessRaw = assertNonEmptyString(rawRole.access, `roles.${roleName}.access`)
  if (!SUPPORTED_ACCESS.has(accessRaw as AccessMode)) {
    throw new ConfigValidationError(
      `Invalid "roles.${roleName}.access": "${accessRaw}". Expected "read" or "write"`,
    )
  }

  const prompt = assertNonEmptyString(rawRole.prompt, `roles.${roleName}.prompt`)
  const promptPath = await resolvePromptFile(repoRoot, piedpiperDir, prompt, roleName)

  let model: string | undefined
  if (rawRole.model !== undefined) {
    model = assertNonEmptyString(rawRole.model, `roles.${roleName}.model`)
  }

  const skills = parseSkills(rawRole.skills, roleName)
  const parallel =
    rawRole.parallel === undefined ? 1 : assertPositiveInt(rawRole.parallel, `roles.${roleName}.parallel`)
  const command = parseCommand(rawRole.command, roleName)

  return {
    adapter: adapterRaw as AdapterType,
    model,
    skills,
    parallel,
    access: accessRaw as AccessMode,
    prompt,
    promptPath,
    command,
  }
}

function parseRuntime(rawRuntime: unknown): RuntimeConfig {
  if (rawRuntime !== undefined && !isPlainObject(rawRuntime)) {
    throw new ConfigValidationError('Invalid "runtime": expected an object')
  }
  const src = rawRuntime ?? {}

  const rawNotifications = src.notifications
  if (rawNotifications !== undefined && !isPlainObject(rawNotifications)) {
    throw new ConfigValidationError('Invalid "runtime.notifications": expected an object')
  }
  const notif = rawNotifications ?? {}
  const desktop = notif.desktop === undefined ? false : assertBoolean(notif.desktop, 'runtime.notifications.desktop')
  const githubMention =
    notif.githubMention === undefined
      ? false
      : assertBoolean(notif.githubMention, 'runtime.notifications.githubMention')
  const githubHandleRaw = notif.githubHandle === undefined ? '' : notif.githubHandle
  if (typeof githubHandleRaw !== 'string') {
    throw new ConfigValidationError('Invalid "runtime.notifications.githubHandle": expected a string')
  }
  const githubHandle = githubHandleRaw.trim()
  if (githubMention && githubHandle.length === 0) {
    throw new ConfigValidationError(
      'Invalid "runtime.notifications.githubHandle": required when githubMention is true',
    )
  }

  const rawReview = src.review
  if (rawReview !== undefined && !isPlainObject(rawReview)) {
    throw new ConfigValidationError('Invalid "runtime.review": expected an object')
  }
  const rev = rawReview ?? {}
  const maxRounds =
    rev.maxRounds === undefined ? 2 : assertPositiveInt(rev.maxRounds, 'runtime.review.maxRounds')
  const validateOutput =
    rev.validateOutput === undefined ? true : assertBoolean(rev.validateOutput, 'runtime.review.validateOutput')

  const rawDispatcher = src.dispatcher
  if (rawDispatcher !== undefined && !isPlainObject(rawDispatcher)) {
    throw new ConfigValidationError('Invalid "runtime.dispatcher": expected an object')
  }
  const disp = rawDispatcher ?? {}
  const maxHops = disp.maxHops === undefined ? 8 : assertPositiveInt(disp.maxHops, 'runtime.dispatcher.maxHops')
  const pollIntervalSec =
    disp.pollIntervalSec === undefined
      ? 60
      : assertPositiveInt(disp.pollIntervalSec, 'runtime.dispatcher.pollIntervalSec')

  const rawEventLog = src.eventLog
  if (rawEventLog !== undefined && !isPlainObject(rawEventLog)) {
    throw new ConfigValidationError('Invalid "runtime.eventLog": expected an object')
  }
  const evt = rawEventLog ?? {}
  const evtType = evt.type === undefined ? 'jsonl' : assertNonEmptyString(evt.type, 'runtime.eventLog.type')
  if (evtType !== 'jsonl') {
    throw new ConfigValidationError(`Unsupported "runtime.eventLog.type": "${evtType}". Expected "jsonl"`)
  }
  const evtPath =
    evt.path === undefined
      ? '.piedpiper/events.jsonl'
      : assertNonEmptyString(evt.path, 'runtime.eventLog.path')

  return {
    notifications: { desktop, githubMention, githubHandle },
    review: { maxRounds, validateOutput },
    dispatcher: { maxHops, pollIntervalSec },
    eventLog: { type: 'jsonl', path: evtPath },
  }
}

function collectWarnings(roles: Record<string, RoleConfig>): string[] {
  const warnings: string[] = []
  const dinesh = roles.dinesh
  const gilfoyle = roles.gilfoyle
  if (dinesh && gilfoyle) {
    const sameAdapter = dinesh.adapter === gilfoyle.adapter
    const sameModel = (dinesh.model ?? null) === (gilfoyle.model ?? null)
    if (sameAdapter && sameModel) {
      const modelLabel = dinesh.model ?? '(default)'
      warnings.push(
        `Warning: roles.gilfoyle and roles.dinesh use the same (adapter="${dinesh.adapter}", model="${modelLabel}") combination; independent adversarial review effectiveness may be reduced.`,
      )
    }
  }
  return warnings
}

/**
 * Loads and validates `.piedpiper/config.json` for a repository.
 * Throws `ConfigValidationError` on schema or file errors; returns non-blocking warnings separately.
 */
export async function loadConfig(
  repoRoot: string,
  options?: { configPath?: string },
): Promise<LoadedConfig> {
  const resolvedRoot = path.resolve(repoRoot)
  const configPath = options?.configPath
    ? path.resolve(options.configPath)
    : path.join(resolvedRoot, '.piedpiper', 'config.json')
  const piedpiperDir = path.dirname(configPath)

  let rawText: string
  try {
    rawText = await readFile(configPath, 'utf8')
  } catch {
    throw new ConfigValidationError(`Cannot read config file at "${configPath}"`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ConfigValidationError(`Invalid JSON in "${configPath}": ${detail}`)
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigValidationError(`Invalid config root in "${configPath}": expected a JSON object`)
  }

  if (!isPlainObject(parsed.roles) || Object.keys(parsed.roles).length === 0) {
    throw new ConfigValidationError('Invalid or missing "roles": expected a non-empty object of role definitions')
  }

  const roles: Record<string, RoleConfig> = {}
  for (const [roleName, rawRole] of Object.entries(parsed.roles)) {
    roles[roleName] = await parseRole(roleName, rawRole, resolvedRoot, piedpiperDir)
  }

  const runtime = parseRuntime(parsed.runtime)
  const warnings = collectWarnings(roles)

  return {
    config: { roles, runtime },
    warnings,
    configPath,
    piedpiperDir,
  }
}
