import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AdapterResolver, AdapterUsage } from './adapters.js'
import type { AccessMode, AdapterType, PiedPiperConfig, RoleConfig } from './config.js'

export const DEFAULT_RUN_TIMEOUT_MS = 300_000

export interface RunRoleInput {
  repoRoot: string
  config: PiedPiperConfig
  roleName: string
  target: string
  resolveAdapter: AdapterResolver
  cwd?: string
  timeoutMs?: number
  sessionId?: string
  extraContextPaths?: string[]
}

export interface RunRoleResult {
  roleName: string
  target: string
  adapter: AdapterType
  model?: string
  access: AccessMode
  cwd: string
  prompt: string
  reply: string
  sessionId?: string
  usage?: AdapterUsage
}

/** Error raised when role execution setup or target validation fails. */
export class RunnerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerError'
  }
}

function validateTargetPointer(rawTarget: string): string {
  const target = rawTarget.trim()
  if (target.length === 0) {
    throw new RunnerError('Target pointer must be a non-empty string')
  }
  if (/[\r\n\0]/.test(target)) {
    throw new RunnerError('Target pointer must not contain newlines or control characters')
  }
  return target
}

function assemblePrompt(params: {
  roleName: string
  roleConfig: RoleConfig
  roleInstructions: string
  target: string
  cwd: string
  extraContextPaths?: string[]
}): string {
  const { roleName, roleConfig, roleInstructions, target, cwd, extraContextPaths } = params

  const skillLines =
    roleConfig.skills.length > 0
      ? roleConfig.skills.map((skill) => `- ${skill}: ~/.claude/skills/${skill}/SKILL.md`)
      : ['- (none configured)']

  const accessRule =
    roleConfig.access === 'read'
      ? 'access: read (strictly read-only; do not edit files, create commits, or merge PRs)'
      : 'access: write (only modify files inside the assigned working directory)'

  const contextPointers = [
    `- Target object: ${target}`,
    '- Domain glossary: GLOSSARY.md',
    '- Architecture decisions: docs/adr/',
    ...(extraContextPaths ?? []).map((p) => `- Context file: ${p}`),
  ]

  return [
    roleInstructions.trim(),
    '',
    '## Runtime Context & Constraints',
    `- Role: ${roleName}`,
    `- ${accessRule}`,
    `- Working directory: ${cwd}`,
    '',
    '## Configured Skills',
    ...skillLines,
    '',
    '## Context Pointers',
    ...contextPointers,
  ].join('\n')
}

/**
 * Executes a single role against a target pointer using the configured adapter.
 */
export async function runRole(input: RunRoleInput): Promise<RunRoleResult> {
  const roleConfig = input.config.roles[input.roleName]
  if (!roleConfig) {
    const known = Object.keys(input.config.roles).join(', ')
    throw new RunnerError(`Unknown role "${input.roleName}". Available roles: ${known}`)
  }

  const target = validateTargetPointer(input.target)
  const cwd = path.resolve(input.cwd ?? input.repoRoot)
  const timeoutMs = input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RunnerError(`Invalid timeoutMs "${timeoutMs}": expected a positive number`)
  }

  const roleInstructions = await readFile(roleConfig.promptPath, 'utf8')
  const prompt = assemblePrompt({
    roleName: input.roleName,
    roleConfig,
    roleInstructions,
    target,
    cwd,
    extraContextPaths: input.extraContextPaths,
  })

  const adapter = input.resolveAdapter(input.roleName, roleConfig)
  const response = await adapter.run({
    prompt,
    cwd,
    model: roleConfig.model,
    sessionId: input.sessionId,
    access: roleConfig.access,
    timeoutMs,
  })

  return {
    roleName: input.roleName,
    target,
    adapter: roleConfig.adapter,
    model: roleConfig.model,
    access: roleConfig.access,
    cwd,
    prompt,
    reply: response.reply,
    sessionId: response.sessionId,
    usage: response.usage,
  }
}
