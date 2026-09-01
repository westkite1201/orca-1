import { z } from 'zod'
import { jawsPlanSchema, jawsPlanTaskSchema } from '../../shared/jaws-types'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'

export const JAWS_PLANNER_OUTPUT_BYTE_LIMIT = 256 * 1024

export const JAWS_PLANNER_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 64 * 1024,
  nestingDepth: 16
} as const

export const jawsPlannerQuestionSchema = z
  .object({
    kind: z.literal('question'),
    question: z.string().trim().min(1).max(4_000)
  })
  .strict()

const jawsPlannerTaskSchema = jawsPlanTaskSchema.extend({
  execution: z.enum(['read-only', 'worktree']),
  fileScopes: z.array(z.string().trim().min(1).max(1_024)).max(32),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(4_000)).min(1).max(16),
  verificationCommands: z.array(z.string().trim().min(1).max(4_000)).min(1).max(16)
})

const jawsPlannerPlanSchema = jawsPlanSchema.safeExtend({
  tasks: z.array(jawsPlannerTaskSchema).min(1).max(8)
})

export const jawsPlannerPlanReplySchema = z
  .object({
    kind: z.literal('plan'),
    plan: jawsPlannerPlanSchema
  })
  .strict()

export const jawsPlannerReplySchema = z.discriminatedUnion('kind', [
  jawsPlannerQuestionSchema,
  jawsPlannerPlanReplySchema
])

export type JawsPlannerQuestion = z.infer<typeof jawsPlannerQuestionSchema>
export type JawsPlannerPlanReply = z.infer<typeof jawsPlannerPlanReplySchema>
export type JawsPlannerReply = z.infer<typeof jawsPlannerReplySchema>

type JsonSchema = Record<string, unknown>

function isSchema(value: unknown): value is JsonSchema {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function nullableSchema(schema: JsonSchema): JsonSchema {
  const type = schema.type
  if (Array.isArray(type)) {
    return type.includes('null') ? schema : { ...schema, type: [...type, 'null'] }
  }
  if (typeof type === 'string') {
    const next: JsonSchema = { ...schema, type: [type, 'null'] }
    if (Array.isArray(schema.enum) && !schema.enum.includes(null)) {
      next.enum = [...schema.enum, null]
    }
    return next
  }
  return { anyOf: [schema, { type: 'null' }] }
}

function mergeObjectVariants(variants: JsonSchema[]): JsonSchema {
  const properties = new Map<string, JsonSchema[]>()
  for (const variant of variants) {
    const variantProperties = isSchema(variant.properties) ? variant.properties : {}
    for (const [key, value] of Object.entries(variantProperties)) {
      if (isSchema(value)) {
        properties.set(key, [...(properties.get(key) ?? []), value])
      }
    }
  }
  const merged: Record<string, JsonSchema> = {}
  for (const [key, schemas] of properties) {
    const normalized = schemas.map((schema) => normalizePlannerSchema(schema))
    const first = normalized[0]
    const same = normalized.every((schema) => JSON.stringify(schema) === JSON.stringify(first))
    const enums = normalized.every((schema) => Array.isArray(schema.enum))
      ? [...new Set(normalized.flatMap((schema) => schema.enum as unknown[]))]
      : null
    const combined = same ? first : enums ? { ...first, enum: enums } : first
    merged[key] = schemas.length === variants.length ? combined : nullableSchema(combined)
  }
  return {
    type: 'object',
    properties: merged,
    required: Object.keys(merged),
    additionalProperties: false
  }
}

function normalizePlannerSchema(input: JsonSchema): JsonSchema {
  const union = Array.isArray(input.oneOf)
    ? input.oneOf
    : Array.isArray(input.anyOf)
      ? input.anyOf
      : null
  if (union) {
    const variants = union.filter(isSchema)
    const nonNull = variants.filter((variant) => variant.type !== 'null')
    if (nonNull.length === 1 && variants.length === 2) {
      return nullableSchema(normalizePlannerSchema(nonNull[0]))
    }
    if (
      nonNull.length === variants.length &&
      nonNull.every((variant) => variant.type === 'object')
    ) {
      return mergeObjectVariants(nonNull)
    }
    return nullableSchema(normalizePlannerSchema(nonNull[0] ?? { type: 'object' }))
  }

  const schema = { ...input }
  delete schema.$schema
  delete schema.format
  delete schema.oneOf
  delete schema.anyOf
  if (schema.const !== undefined) {
    schema.enum = [schema.const]
    delete schema.const
  }
  if (schema.type === 'object' && isSchema(schema.properties)) {
    const required = new Set(Array.isArray(input.required) ? input.required : [])
    const properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => {
        const normalized = isSchema(value) ? normalizePlannerSchema(value) : {}
        return [key, required.has(key) ? normalized : nullableSchema(normalized)]
      })
    )
    schema.properties = properties
    schema.required = Object.keys(properties)
    schema.additionalProperties = false
  } else if (schema.type === 'array' && isSchema(schema.items)) {
    schema.items = normalizePlannerSchema(schema.items)
  }
  return schema
}

export function getJawsPlannerOutputJsonSchema(): object {
  return normalizePlannerSchema(jawsPlannerReplySchema.toJSONSchema())
}

export function parseJawsPlannerOutput(text: string): JawsPlannerReply {
  if (Buffer.byteLength(text, 'utf8') > JAWS_PLANNER_OUTPUT_BYTE_LIMIT) {
    throw new Error(`Planner output exceeds ${JAWS_PLANNER_OUTPUT_BYTE_LIMIT / 1024} KiB.`)
  }
  assertJsonTextStructureWithinLimits(text, JAWS_PLANNER_JSON_STRUCTURE_LIMITS)
  const parsed = JSON.parse(text) as unknown
  if (isSchema(parsed)) {
    if (parsed.kind === 'question' && parsed.plan === null) {
      delete parsed.plan
    } else if (parsed.kind === 'plan' && parsed.question === null) {
      delete parsed.question
    }
  }
  return jawsPlannerReplySchema.parse(parsed)
}
