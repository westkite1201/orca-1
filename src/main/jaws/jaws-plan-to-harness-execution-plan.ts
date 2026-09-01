import { createHash } from 'node:crypto'
import {
  HARNESS_EXECUTION_PLAN_VERSION,
  type HarnessExecutionPlanV1
} from '../../shared/harness-allocation-types'
import type { JawsPlan } from '../../shared/jaws-types'
import { normalizeHarnessExecutionPlan } from '../harness/allocation-validation'

type AllocatableJawsTask = JawsPlan['tasks'][number] &
  Required<
    Pick<
      JawsPlan['tasks'][number],
      'execution' | 'fileScopes' | 'acceptanceCriteria' | 'verificationCommands'
    >
  >

const HARNESS_KEY_MAX_LENGTH = 48
const HARNESS_KEY_HASH_LENGTH = 8

function baseHarnessItemKey(key: string): string {
  return key.toLowerCase().replaceAll('_', '-')
}

function hashedHarnessItemKey(key: string): string {
  const base = baseHarnessItemKey(key)
  const hash = createHash('sha256').update(key).digest('hex').slice(0, HARNESS_KEY_HASH_LENGTH)
  return `${base.slice(0, HARNESS_KEY_MAX_LENGTH - HARNESS_KEY_HASH_LENGTH - 1)}-${hash}`
}

function createHarnessKeyMap(plan: JawsPlan): Map<string, string> {
  const baseCounts = new Map<string, number>()
  for (const task of plan.tasks) {
    const base = baseHarnessItemKey(task.key)
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1)
  }
  const keyMap = new Map<string, string>()
  for (const task of plan.tasks) {
    const base = baseHarnessItemKey(task.key)
    const harnessKey =
      base.length > HARNESS_KEY_MAX_LENGTH || (baseCounts.get(base) ?? 0) > 1
        ? hashedHarnessItemKey(task.key)
        : base
    if (keyMap.has(task.key)) {
      throw new Error(`Duplicate Jaws task key: ${task.key}`)
    }
    keyMap.set(task.key, harnessKey)
  }
  const uniqueHarnessKeys = new Set(keyMap.values())
  if (uniqueHarnessKeys.size !== keyMap.size) {
    throw new Error('Jaws task keys cannot be converted into unique Harness item keys.')
  }
  return keyMap
}

export function createHarnessExecutionPlanFromJawsPlan(args: {
  plan: JawsPlan
  revision: number
  planHash: string
}): HarnessExecutionPlanV1 | null {
  const tasks = args.plan.tasks
  if (!tasks.every(isAllocatableJawsTask)) {
    return null
  }
  const keyMap = createHarnessKeyMap(args.plan)
  return normalizeHarnessExecutionPlan({
    version: HARNESS_EXECUTION_PLAN_VERSION,
    revision: args.revision,
    planHash: args.planHash,
    maxConcurrency: args.plan.maxConcurrency,
    items: tasks.map((task) => ({
      key: keyMap.get(task.key) ?? task.key,
      title: task.title,
      objective: task.objective,
      execution: task.execution,
      dependencies: task.dependsOn.map((dependency) => keyMap.get(dependency) ?? dependency),
      fileScopes: [...task.fileScopes],
      acceptanceCriteria: [...task.acceptanceCriteria],
      verificationCommands: [...task.verificationCommands]
    }))
  })
}

function isAllocatableJawsTask(task: JawsPlan['tasks'][number]): task is AllocatableJawsTask {
  return (
    task.execution !== undefined &&
    task.fileScopes !== undefined &&
    Boolean(task.acceptanceCriteria?.length) &&
    Boolean(task.verificationCommands?.length)
  )
}
