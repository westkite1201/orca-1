import { describe, expect, it } from 'vitest'
import {
  formatCreateProjectParentSummary,
  getCreateProjectDefaultParentAutoFill,
  getDefaultCreateProjectParent,
  joinCreateProjectPath
} from './create-project-defaults'

describe('create project defaults', () => {
  it('builds the POSIX default project parent', () => {
    expect(getDefaultCreateProjectParent('/Users/alice')).toBe('/Users/alice/jaws/projects')
  })

  it('builds the Windows default project parent', () => {
    expect(getDefaultCreateProjectParent('C:\\Users\\alice')).toBe(
      'C:\\Users\\alice\\jaws\\projects'
    )
  })

  it('derives the runtime project default from a resolved server home', () => {
    expect(getDefaultCreateProjectParent('/home/alice')).toBe('/home/alice/jaws/projects')
  })

  it('joins path previews without mixing separators', () => {
    expect(joinCreateProjectPath('/home/alice/jaws/projects', 'demo')).toBe(
      '/home/alice/jaws/projects/demo'
    )
    expect(joinCreateProjectPath('C:\\Users\\alice\\jaws\\projects', 'demo')).toBe(
      'C:\\Users\\alice\\jaws\\projects\\demo'
    )
  })

  it('auto-fills only the first empty local create step', () => {
    expect(
      getCreateProjectDefaultParentAutoFill({
        step: 'create',
        createParent: '',
        activeRuntimeEnvironmentId: null,
        defaultParent: '/Users/alice/jaws/projects',
        createStepAutoFilled: false
      })
    ).toEqual({ parent: '/Users/alice/jaws/projects' })
    expect(
      getCreateProjectDefaultParentAutoFill({
        step: 'create',
        createParent: '/tmp/project',
        activeRuntimeEnvironmentId: null,
        defaultParent: '/Users/alice/jaws/projects',
        createStepAutoFilled: false
      })
    ).toBeNull()
    expect(
      getCreateProjectDefaultParentAutoFill({
        step: 'create',
        createParent: '',
        activeRuntimeEnvironmentId: null,
        defaultParent: '/Users/alice/jaws/projects',
        createStepAutoFilled: true
      })
    ).toBeNull()
  })

  it('does not apply a local default while a runtime environment is active', () => {
    expect(
      getCreateProjectDefaultParentAutoFill({
        step: 'create',
        createParent: '',
        activeRuntimeEnvironmentId: 'env-1',
        defaultParent: '/Users/alice/jaws/projects',
        createStepAutoFilled: false
      })
    ).toBeNull()
  })

  it('uses a short local summary only for the local default parent', () => {
    expect(
      formatCreateProjectParentSummary({
        parent: '/Users/alice/jaws/projects',
        defaultParent: '/Users/alice/jaws/projects'
      })
    ).toBe('~/jaws/projects')
    expect(
      formatCreateProjectParentSummary({
        parent: '/home/alice/jaws/projects',
        defaultParent: '/home/alice/jaws/projects'
      })
    ).toBe('~/jaws/projects')
    expect(
      formatCreateProjectParentSummary({
        parent: 'C:\\Users\\alice\\jaws\\projects',
        defaultParent: 'C:\\Users\\alice\\jaws\\projects'
      })
    ).toBe('~/jaws/projects')
    expect(
      formatCreateProjectParentSummary({
        parent: '',
        defaultParent: '',
        runtimeEnvironmentId: 'env-1'
      })
    ).toBe('host folder not selected')
    expect(
      formatCreateProjectParentSummary({
        parent: '/Users/alice/jaws/projects',
        defaultParent: '/Users/alice/jaws/projects',
        isRemoteHost: true
      })
    ).toBe('/Users/alice/jaws/projects')
    expect(
      formatCreateProjectParentSummary({
        parent: '',
        defaultParent: '',
        isRemoteHost: true
      })
    ).toBe('host folder not selected')
  })

  it('keeps a configured Workspace Directory verbatim in the summary', () => {
    expect(
      formatCreateProjectParentSummary({
        parent: 'J:\\PROJECTS',
        defaultParent: 'J:\\PROJECTS'
      })
    ).toBe('J:\\PROJECTS')
    expect(
      formatCreateProjectParentSummary({
        parent: '/data/orca/projects',
        defaultParent: '/data/orca/projects'
      })
    ).toBe('/data/orca/projects')
    expect(
      formatCreateProjectParentSummary({
        parent: 'D:\\code\\orca\\projects',
        defaultParent: 'D:\\code\\orca\\projects'
      })
    ).toBe('D:\\code\\orca\\projects')
  })
})
