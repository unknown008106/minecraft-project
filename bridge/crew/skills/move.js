// Walking with a time limit. pathfinder.goto can wait forever on a path it keeps replanning (the live test stood
// still for minutes in a tunnel, and a !give hung for 90 s), so every walk has a limit and fails when it runs out.

const GOTO_MS = 20000

async function goTo (bot, goal, token, ms = GOTO_MS) {
  if (token?.cancelled) return
  let timer
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      bot.pathfinder.setGoal(null)
      reject(new Error('path took too long'))
    }, ms)
  })
  try {
    await Promise.race([bot.pathfinder.goto(goal), limit])
  } catch (err) {
    if (token?.cancelled) return
    throw err
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { goTo, GOTO_MS }
