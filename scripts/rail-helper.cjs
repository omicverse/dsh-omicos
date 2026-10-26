/** Click a navigation page, opening the rail's 更多 menu first when the page lives there. */
async function clickRailPage(rail, name) {
  const target = rail.getByRole('button', { name, exact: true })
  if (!(await target.isVisible())) {
    await rail.getByRole('button', { name: '更多', exact: true }).click()
    await target.waitFor({ state: 'visible' })
  }
  await target.click()
}
module.exports = { clickRailPage }
