import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSubprocess } from './adapters.js'
import { STANDARD_GITHUB_LABELS, type GitHubPort } from './github.js'
import { isGitRepo } from './worktree.js'

const PROBE_TIMEOUT_MS = 10_000
const REQUIRED_ROLES = ['richard', 'jared', 'dinesh', 'gilfoyle'] as const
const GITIGNORE_ENTRIES = ['.piedpiper/events.jsonl', '.piedpiper/tmp/']

export interface CliAvailability {
  claude: boolean
  codex: boolean
}

/**
 * Injectable environment probe for `piedpiper init`.
 * Tests supply a fake; production uses local git, gh, and CLI executables.
 */
export interface InitProbe {
  isGitRepository(repoRoot: string): Promise<boolean>
  getOriginUrl(repoRoot: string): Promise<string | undefined>
  isGhAuthenticated(repoRoot: string): Promise<boolean>
  detectClis(): Promise<CliAvailability>
  getGitHubLogin(repoRoot: string): Promise<string | undefined>
}

export class InitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InitError'
  }
}

export interface RunInitInput {
  repoRoot: string
  force: boolean
  probe: InitProbe
  github?: GitHubPort
  templatesDir?: string
}

interface RoleAssignment {
  adapter: 'claude' | 'codex'
  model: string
}

function defaultTemplatesDir(): string {
  return fileURLToPath(new URL('../templates', import.meta.url))
}

function isGitHubOrigin(url: string | undefined): boolean {
  if (!url) return false
  return /github\.com[:/]/i.test(url)
}

async function runProbe(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; exitCode: number } | undefined> {
  try {
    return await execSubprocess(command, args, { cwd, timeoutMs: PROBE_TIMEOUT_MS })
  } catch {
    return undefined
  }
}

/** Production probe: git repo, GitHub origin, gh auth, claude/codex on PATH, gh login. */
export function createDefaultInitProbe(): InitProbe {
  return {
    async isGitRepository(repoRoot: string): Promise<boolean> {
      return isGitRepo(repoRoot)
    },
    async getOriginUrl(repoRoot: string): Promise<string | undefined> {
      const res = await runProbe('git', ['remote', 'get-url', 'origin'], repoRoot)
      if (!res || res.exitCode !== 0) return undefined
      const url = res.stdout.trim()
      return url.length > 0 ? url : undefined
    },
    async isGhAuthenticated(repoRoot: string): Promise<boolean> {
      const res = await runProbe('gh', ['auth', 'status'], repoRoot)
      return !!res && res.exitCode === 0
    },
    async detectClis(): Promise<CliAvailability> {
      const [claude, codex] = await Promise.all([
        runProbe('which', ['claude'], process.cwd()),
        runProbe('which', ['codex'], process.cwd()),
      ])
      return {
        claude: !!claude && claude.exitCode === 0 && claude.stdout.trim().length > 0,
        codex: !!codex && codex.exitCode === 0 && codex.stdout.trim().length > 0,
      }
    },
    async getGitHubLogin(repoRoot: string): Promise<string | undefined> {
      const res = await runProbe('gh', ['api', 'user', '--jq', '.login'], repoRoot)
      if (!res || res.exitCode !== 0) return undefined
      const login = res.stdout.trim()
      return login.length > 0 ? login : undefined
    },
  }
}

function assignmentFor(clis: CliAvailability): Record<string, RoleAssignment> {
  if (clis.claude && clis.codex) {
    return {
      richard: { adapter: 'claude', model: 'claude-opus-5-5' },
      jared: { adapter: 'claude', model: 'claude-sonnet-5-5' },
      dinesh: { adapter: 'claude', model: 'claude-sonnet-5-5' },
      gilfoyle: { adapter: 'codex', model: 'gpt-5-codex' },
    }
  }
  if (clis.claude) {
    return {
      richard: { adapter: 'claude', model: 'claude-opus-5-5' },
      jared: { adapter: 'claude', model: 'claude-sonnet-5-5' },
      dinesh: { adapter: 'claude', model: 'claude-sonnet-5-5' },
      gilfoyle: { adapter: 'claude', model: 'claude-opus-5-5' },
    }
  }
  return {
    richard: { adapter: 'codex', model: 'o3' },
    jared: { adapter: 'codex', model: 'gpt-5-codex' },
    dinesh: { adapter: 'codex', model: 'gpt-5-codex' },
    gilfoyle: { adapter: 'codex', model: 'o3' },
  }
}

async function renderConfig(templatesDir: string, clis: CliAvailability, githubHandle: string): Promise<string> {
  const templatePath = path.join(templatesDir, 'config.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(templatePath, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new InitError(`Cannot read init template "${templatePath}": ${detail}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InitError(`Invalid init template "${templatePath}": expected a JSON object`)
  }
  const config = parsed as {
    roles?: Record<string, { adapter?: string; model?: string }>
    runtime?: { notifications?: { githubHandle?: string; githubMention?: boolean } }
  }
  const assignments = assignmentFor(clis)
  for (const roleName of REQUIRED_ROLES) {
    const role = config.roles?.[roleName]
    if (!role || typeof role !== 'object') {
      throw new InitError(`Init template is missing role "${roleName}"`)
    }
    const assignment = assignments[roleName]
    if (!assignment) continue
    role.adapter = assignment.adapter
    role.model = assignment.model
  }
  if (!config.runtime) config.runtime = {}
  if (!config.runtime.notifications) config.runtime.notifications = {}
  config.runtime.notifications.githubHandle = githubHandle
  config.runtime.notifications.githubMention = githubHandle.length > 0
  return `${JSON.stringify(config, null, 2)}\n`
}

async function listRoleTemplates(templatesDir: string): Promise<string[]> {
  const rolesDir = path.join(templatesDir, 'roles')
  let names: string[]
  try {
    names = await readdir(rolesDir)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new InitError(`Cannot read init role templates in "${rolesDir}": ${detail}`)
  }
  const roleFiles = names.filter((name) => name.endsWith('.md'))
  if (roleFiles.length === 0) {
    throw new InitError(`Init role templates directory "${rolesDir}" is empty`)
  }
  return roleFiles
}

async function syncGitignore(repoRoot: string): Promise<void> {
  const gitignorePath = path.join(repoRoot, '.gitignore')
  const existing = existsSync(gitignorePath) ? await readFile(gitignorePath, 'utf8') : ''
  const present = new Set(existing.split(/\r?\n/))
  const missing = GITIGNORE_ENTRIES.filter((entry) => !present.has(entry))
  if (missing.length === 0) return
  const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
  await writeFile(gitignorePath, `${existing}${prefix}${missing.join('\n')}\n`, 'utf8')
}

/**
 * Strict preflight plus idempotent `.piedpiper` initialization.
 * Failed preflight checks throw before any project file is created.
 */
export async function runInit(input: RunInitInput): Promise<void> {
  const repoRoot = path.resolve(input.repoRoot)
  if (!(await input.probe.isGitRepository(repoRoot))) {
    throw new InitError(`${repoRoot} is not a git repository.\nFix: git init`)
  }
  const origin = await input.probe.getOriginUrl(repoRoot)
  if (!isGitHubOrigin(origin)) {
    throw new InitError(
      'No GitHub origin remote is configured.\nFix: git remote add origin <github-repo-url>',
    )
  }
  if (!(await input.probe.isGhAuthenticated(repoRoot))) {
    throw new InitError('gh is not authenticated.\nFix: gh auth login')
  }
  const clis = await input.probe.detectClis()
  if (!clis.claude && !clis.codex) {
    throw new InitError(
      'Neither the claude nor the codex CLI is installed.\nFix: install the claude CLI or the codex CLI',
    )
  }

  let githubHandle = ''
  try {
    githubHandle = (await input.probe.getGitHubLogin(repoRoot))?.trim() ?? ''
  } catch {
    githubHandle = ''
  }

  if (!input.github) {
    throw new InitError('GitHub port is unavailable: repository has no GitHub remote configured')
  }

  const templatesDir = input.templatesDir ?? defaultTemplatesDir()
  const configText = await renderConfig(templatesDir, clis, githubHandle)
  const roleTemplates = await listRoleTemplates(templatesDir)

  const piedpiperDir = path.join(repoRoot, '.piedpiper')
  const rolesDir = path.join(piedpiperDir, 'roles')
  const configPath = path.join(piedpiperDir, 'config.json')
  await mkdir(rolesDir, { recursive: true })

  for (const name of roleTemplates) {
    const dest = path.join(rolesDir, name)
    if (!input.force && existsSync(dest)) continue
    await copyFile(path.join(templatesDir, 'roles', name), dest)
  }
  if (input.force || !existsSync(configPath)) {
    await writeFile(configPath, configText, 'utf8')
  }
  await syncGitignore(repoRoot)
  await input.github.ensureLabels(STANDARD_GITHUB_LABELS)
}
