import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const {
  PACKAGED_RUNTIME_PACKAGE_ROOTS,
  createPackagedRuntimeNodeModuleResources
} = require('../packaged-runtime-node-modules.cjs')

describe('Jaws electron-builder config', () => {
  it('does not publish or package the disabled updater', () => {
    expect(electronBuilderConfig.publish).toBeNull()
    expect(PACKAGED_RUNTIME_PACKAGE_ROOTS).not.toContain('electron-updater')
    expect(createPackagedRuntimeNodeModuleResources().map((resource) => resource.to)).not.toContain(
      join('node_modules', 'electron-updater')
    )
  })
})
