import {
  DEFAULT_HARNESS_MAX_CONCURRENCY,
  HARNESS_EXECUTION_PLAN_VERSION,
  HARNESS_MAX_CONCURRENCY,
  type HarnessConcurrency,
  type HarnessExecutionItemV1,
  type HarnessExecutionPlanV1
} from '../../shared/harness-allocation-types'

const ITEM_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/

function invalid(message: string): never {
  throw new Error(`Invalid Harness execution plan: ${message}`)
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${field} must be a non-empty string.`)
  }
  return (value as string).trim()
}

function requireStringList(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value)) {
    invalid(`${field} must be an array of strings.`)
  }
  const values = value.map((entry, index) => requireNonEmptyString(entry, `${field}[${index}]`))
  if (!allowEmpty && values.length === 0) {
    invalid(`${field} must not be empty.`)
  }
  return values
}

function normalizeScope(scope: string, field: string): string {
  const normalized = scope.trim().replaceAll('\\', '/')
  if (normalized === '*') {
    return normalized
  }
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.includes('\u0000')
  ) {
    invalid(`${field} must be a repository-relative Git path.`)
  }
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.some((segment) => segment === '..')) {
    invalid(`${field} must not escape the repository.`)
  }
  if (segments.length === 0) {
    invalid(`${field} must be a non-empty repository-relative Git path.`)
  }
  return segments.join('/')
}

function validateConcurrency(value: unknown): HarnessConcurrency {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    invalid('maxConcurrency must be an integer from 1 to 3.')
  }
  if (value < 1 || value > HARNESS_MAX_CONCURRENCY) {
    invalid('maxConcurrency must be an integer from 1 to 3.')
  }
  return value as HarnessConcurrency
}

function validateItem(value: unknown, index: number): HarnessExecutionItemV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`items[${index}] must be an object.`)
  }
  const item = value as Record<string, unknown>
  const key = requireNonEmptyString(item.key, `items[${index}].key`)
  if (!ITEM_KEY_PATTERN.test(key)) {
    invalid(`items[${index}].key must match ${ITEM_KEY_PATTERN.source}.`)
  }
  const execution = item.execution
  if (execution !== 'read-only' && execution !== 'worktree') {
    invalid(`items[${index}].execution must be read-only or worktree.`)
  }
  const fileScopes = requireStringList(item.fileScopes, `items[${index}].fileScopes`, true).map(
    (scope, scopeIndex) => normalizeScope(scope, `items[${index}].fileScopes[${scopeIndex}]`)
  )
  const acceptanceCriteria = requireStringList(
    item.acceptanceCriteria,
    `items[${index}].acceptanceCriteria`
  )
  const verificationCommands = requireStringList(
    item.verificationCommands,
    `items[${index}].verificationCommands`
  )
  return {
    key,
    title: requireNonEmptyString(item.title, `items[${index}].title`),
    objective: requireNonEmptyString(item.objective, `items[${index}].objective`),
    execution,
    dependencies: requireStringList(item.dependencies, `items[${index}].dependencies`, true),
    fileScopes,
    acceptanceCriteria,
    verificationCommands
  }
}

function assertAcyclic(items: readonly HarnessExecutionItemV1[]): void {
  const byKey = new Map(items.map((item) => [item.key, item]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): void => {
    if (visiting.has(key)) {
      invalid(`dependency graph contains a cycle at ${key}.`)
    }
    if (visited.has(key)) {
      return
    }
    const item = byKey.get(key)
    if (!item) {
      invalid(`dependency target ${key} does not exist.`)
    }
    visiting.add(key)
    for (const dependency of item.dependencies) {
      if (dependency === item.key) {
        invalid(`item ${item.key} cannot depend on itself.`)
      }
      if (!byKey.has(dependency)) {
        invalid(`item ${item.key} depends on missing item ${dependency}.`)
      }
      visit(dependency)
    }
    visiting.delete(key)
    visited.add(key)
  }
  for (const item of items) {
    visit(item.key)
  }
}

export function normalizeHarnessExecutionPlan(value: unknown): HarnessExecutionPlanV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('plan must be an object.')
  }
  const plan = value as Record<string, unknown>
  if (plan.version !== HARNESS_EXECUTION_PLAN_VERSION) {
    invalid(`version must be ${HARNESS_EXECUTION_PLAN_VERSION}.`)
  }
  const revision = plan.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    invalid('revision must be a positive integer.')
  }
  const planHash = requireNonEmptyString(plan.planHash, 'planHash')
  const rawItems = plan.items
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 8) {
    invalid('items must contain between 1 and 8 entries.')
  }
  const items = rawItems.map((item, index) => validateItem(item, index))
  const keys = new Set<string>()
  for (const item of items) {
    if (keys.has(item.key)) {
      invalid(`item key ${item.key} is duplicated.`)
    }
    keys.add(item.key)
    if (new Set(item.dependencies).size !== item.dependencies.length) {
      invalid(`item ${item.key} has duplicated dependencies.`)
    }
  }
  assertAcyclic(items)
  const maxConcurrency =
    plan.maxConcurrency === undefined
      ? DEFAULT_HARNESS_MAX_CONCURRENCY
      : validateConcurrency(plan.maxConcurrency)
  return {
    version: HARNESS_EXECUTION_PLAN_VERSION,
    revision: revision as number,
    planHash,
    maxConcurrency,
    items
  }
}

export function assertHarnessExecutionPlan(
  value: unknown
): asserts value is HarnessExecutionPlanV1 {
  normalizeHarnessExecutionPlan(value)
}
