import { describe, expect, it } from 'vitest'
import { getJawsPlannerOutputJsonSchema, parseJawsPlannerOutput } from './planner-contract'

function walkSchema(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') {
    return []
  }
  const schema = value as Record<string, unknown>
  return [schema, ...Object.values(schema).flatMap((child) => walkSchema(child))]
}

describe('Jaws planner contract', () => {
  it('emits a strict structured-output schema without unsupported unions', () => {
    const schema = getJawsPlannerOutputJsonSchema() as Record<string, unknown>
    const objects = walkSchema(schema)

    expect(objects.some((entry) => 'oneOf' in entry || 'anyOf' in entry)).toBe(false)
    expect(schema.required).toEqual(['kind', 'question', 'plan'])
    expect((schema.properties as Record<string, unknown>).kind).toMatchObject({
      enum: ['question', 'plan']
    })
    expect((schema.properties as Record<string, unknown>).question).toMatchObject({
      type: ['string', 'null']
    })
  })

  it('accepts flat nullable fields emitted for either reply kind', () => {
    expect(
      parseJawsPlannerOutput(
        JSON.stringify({
          kind: 'question',
          question: 'Which scope should I use?',
          plan: null
        })
      )
    ).toEqual({ kind: 'question', question: 'Which scope should I use?' })

    expect(
      parseJawsPlannerOutput(
        JSON.stringify({
          kind: 'plan',
          question: null,
          plan: {
            goal: 'Inspect the repository',
            verificationCommand: 'pnpm test',
            maxConcurrency: 1,
            tasks: [
              {
                key: 'inspect',
                title: 'Inspect repository',
                objective: 'Read the repository and report evidence.',
                dependsOn: [],
                execution: 'read-only',
                fileScopes: [],
                acceptanceCriteria: ['A report identifies the relevant code paths.'],
                verificationCommands: ['git status --short']
              }
            ],
            linear: null,
            review: null
          }
        })
      )
    ).toMatchObject({ kind: 'plan', plan: { goal: 'Inspect the repository' } })
  })
})
