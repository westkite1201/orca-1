import { describe, expect, it } from 'vitest'
import { normalizeJawsPlanningQuestion } from './jaws-planning-types'

describe('Jaws planning questions', () => {
  it('hides internal runtime details from Linear clarification prompts', () => {
    expect(
      normalizeJawsPlanningQuestion(
        '현재 Linear 이슈의 식별자·제목·설명·의존관계를 붙여주시겠어요? Orca 런타임이 꺼져 있고 네트워크도 차단되어 이슈를 조회할 수 없습니다.'
      )
    ).toBe(
      'Linear 이슈 정보를 확인할 수 없어요. 이슈 ID를 붙여 넣거나 Linear 연결 후 다시 시도해 주세요.'
    )
  })
})
