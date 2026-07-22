import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import type { Page } from '@stablyai/playwright-test'

// Manual-verification harness for the lift-and-part project header drag.
// Seeds enough projects to force the sidebar to scroll, then measures the
// dragged header's rendered position DURING a drag — the behaviour unit tests
// cannot see. Screenshots land under test-results for a human to eyeball.

const PROJECT_COUNT = 14
const tempRoots: string[] = []

function initializeGitRepo(repoPath: string): void {
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: repoPath, stdio: 'pipe' })
  writeFileSync(path.join(repoPath, 'README.md'), `# ${path.basename(repoPath)}\n`)
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath, stdio: 'pipe' })
}

function createProjectFixture(): string[] {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-header-drag-')))
  tempRoots.push(root)
  const repoPaths = Array.from({ length: PROJECT_COUNT }, (_, index) =>
    path.join(root, `e2e-drag-project-${String(index).padStart(2, '0')}`)
  )
  for (const repoPath of repoPaths) {
    initializeGitRepo(repoPath)
  }
  return repoPaths
}

async function seedProjects(page: Page, repoPaths: readonly string[]): Promise<string[]> {
  return page.evaluate(async (paths) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    for (const repoPath of paths) {
      await window.api.repos.add({ path: repoPath })
    }
    const state = store.getState()
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('repo')
    state.setProjectOrderBy('manual')

    const findSeeded = () =>
      paths.map((repoPath) => store.getState().repos.find((repo) => repo.path === repoPath))
    let repos = findSeeded()
    const deadline = Date.now() + 15_000
    while (repos.some((repo) => !repo) && Date.now() < deadline) {
      await state.fetchRepos()
      repos = findSeeded()
      if (repos.every((repo) => repo)) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return repos.map((repo, index) => {
      if (!repo) {
        throw new Error(`Project not loaded: ${paths[index]}`)
      }
      return repo.id
    })
  }, repoPaths)
}

function headerBox(page: Page, repoId: string) {
  return page.locator(`[data-repo-header-id="${repoId}"]`).boundingBox()
}

// The sidebar is virtualized, so a scrolled-past project is not in the DOM.
// Assert the rendered headers are the manual-order prefix (top-anchored list),
// which also proves the list overflows and scrolls.
async function expectRenderedManualPrefix(page: Page, ids: readonly string[]): Promise<void> {
  await expect
    .poll(
      async () => {
        const rendered = await renderedHeaderOrder(page, ids)
        return {
          count: rendered.length,
          matchesPrefix: rendered.every((id, index) => id === ids[index])
        }
      },
      { timeout: 15_000, message: 'headers did not render in manual order' }
    )
    .toEqual({ count: expect.any(Number), matchesPrefix: true })
  const rendered = await renderedHeaderOrder(page, ids)
  expect(rendered.length, 'sidebar should overflow so autoscroll is reachable').toBeGreaterThan(8)
  expect(rendered.length, 'some projects should be virtualized out of view').toBeLessThan(
    ids.length
  )
}

async function renderedHeaderOrder(page: Page, ids: readonly string[]): Promise<string[]> {
  const set = new Set(ids)
  return page.locator('[data-worktree-sidebar] [data-repo-header-id]').evaluateAll(
    (elements, expected) =>
      elements
        .map((el) => ({
          id: el.getAttribute('data-repo-header-id') ?? '',
          top: el.getBoundingClientRect().top
        }))
        .filter((entry) => expected.includes(entry.id))
        .sort((a, b) => a.top - b.top)
        .map((entry) => entry.id),
    [...set]
  )
}

test.afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

test.describe('project header drag interaction', () => {
  test('lifted header tracks the pointer and cancel restores the list', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const ids = await seedProjects(orcaPage, createProjectFixture())

    await expectRenderedManualPrefix(orcaPage, ids)

    const orderBefore = await renderedHeaderOrder(orcaPage, ids)
    const grab = await headerBox(orcaPage, ids[0]!)
    if (!grab) {
      throw new Error('top header box unavailable')
    }

    const startX = grab.x + grab.width / 2
    const startY = grab.y + grab.height / 2
    await orcaPage.mouse.move(startX, startY)
    await orcaPage.mouse.down()

    // Promote past the 4px threshold, then step down the list. At each step the
    // lifted header's box top must stay near the pointer, not lag behind at its
    // original slot (the "does it follow the cursor" property).
    const drifts: number[] = []
    for (const dy of [10, 60, 120, 180]) {
      await orcaPage.mouse.move(startX, startY + dy, { steps: 4 })
      const box = await headerBox(orcaPage, ids[0]!)
      if (!box) {
        throw new Error(`dragged header unmounted at dy=${dy}`)
      }
      // header top vs pointer: at grab the pointer sat height/2 into the header.
      const expectedTop = startY + dy - grab.height / 2
      drifts.push(Math.abs(box.y - expectedTop))
    }
    await orcaPage.screenshot({
      path: testInfo.outputPath('mid-drag-follow.png')
    })

    const maxDrift = Math.max(...drifts)
    testInfo.attach('pointer-follow-drift', {
      body: `per-step |header.top - pointer|: ${drifts.map((d) => d.toFixed(1)).join(', ')}px`,
      contentType: 'text/plain'
    })
    // A stationary (non-following) header would drift by the full move distance
    // (up to ~180px). Allow slack for the header offset and sub-pixel rounding.
    expect(maxDrift).toBeLessThan(24)

    // Cancel with Escape: every project section must be visible again, in the
    // original order, with nothing left folded.
    await orcaPage.keyboard.press('Escape')
    await orcaPage.mouse.up()

    await expect
      .poll(() => renderedHeaderOrder(orcaPage, ids), { timeout: 8_000 })
      .toEqual(orderBefore)
    await orcaPage.screenshot({ path: testInfo.outputPath('after-cancel.png') })
  })

  test('dragged header survives edge autoscroll', async ({ orcaPage }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const ids = await seedProjects(orcaPage, createProjectFixture())

    await expectRenderedManualPrefix(orcaPage, ids)

    const sidebarBox = await orcaPage.locator('[data-worktree-sidebar]').boundingBox()
    const grab = await headerBox(orcaPage, ids[0]!)
    if (!sidebarBox || !grab) {
      throw new Error('sidebar or header box unavailable')
    }

    const startX = grab.x + grab.width / 2
    const startY = grab.y + grab.height / 2
    await orcaPage.mouse.move(startX, startY)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(startX, startY + 12, { steps: 3 })

    // Park the pointer in the bottom autoscroll band and hold so the list keeps
    // scrolling underneath. The dragged header must remain mounted and under the
    // cursor the whole time — this is the case the final review flagged.
    const bottomBandY = sidebarBox.y + sidebarBox.height - 8
    await orcaPage.mouse.move(startX, bottomBandY, { steps: 6 })
    let unmountedAt = -1
    let worstDrift = 0
    for (let tick = 0; tick < 12; tick += 1) {
      await orcaPage.mouse.move(startX, bottomBandY)
      await orcaPage.waitForTimeout(120)
      const box = await headerBox(orcaPage, ids[0]!)
      if (!box) {
        unmountedAt = tick
        break
      }
      worstDrift = Math.max(worstDrift, Math.abs(box.y - (bottomBandY - grab.height / 2)))
    }
    await orcaPage.screenshot({ path: testInfo.outputPath('autoscroll-hold.png') })
    await orcaPage.mouse.up()

    testInfo.attach('autoscroll-result', {
      body: `unmountedAtTick=${unmountedAt} worstDrift=${worstDrift.toFixed(1)}px`,
      contentType: 'text/plain'
    })
    expect(unmountedAt, 'dragged header unmounted during autoscroll').toBe(-1)
    expect(worstDrift).toBeLessThan(40)
  })
})
