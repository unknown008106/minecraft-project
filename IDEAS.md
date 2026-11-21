# Ideas

Minecraft agents that play with you and against you. Nothing below is built yet. This is the list we pick from.

Terms used below:
- RL (reinforcement learning): the bot learns by playing many rounds and getting scored on each one.
- UHC (Ultra Hardcore): a Minecraft mode where health does not come back on its own, so golden apples, water buckets, lava, cobwebs and pearls all matter.
- Tick: 1/20 of a second, the game's clock.

## The agents

1. **Fighter.** A small network trained with RL in a fast simulator of Minecraft 1.21 combat, then played on a real server through a Mineflayer bot.
2. **Mob coordinator.** An invisible agent that makes hostile mobs work together. A creeper blows open a wall and the zombies flood in. Endermen bridge a moat. Mobs learn where players walk and wait there.
3. **Miner and gatherer.** Scripted moves do the digging. A small learned chooser picks the next move (keep the tunnel, branch, change depth, follow a cave, mine ore in sight, torch, go home) from only what the bot can see. It never knows where unseen ores are.
4. **Builder.** Builds from blueprints, later with redstone parts (an auto wheat farm with an observer and pistons, a hidden door).
5. **Goal agent.** One command like "get a diamond pickaxe from nothing" and it plans the rest. It asks the owner and waits 10 s when unsure, packs food for the trip, picks its fighter by kit (shield and axe means the axe fighter) and goes back to mining after a mob.
6. **Crafting planner.** Knows every 1.21 recipe and plans the full chain from raw blocks to the item.
7. **Plain language crew.** Talk to the bots in chat ("@crew mine iron", "@crew guard me"). A mode manager switches between fighting, mining and building by priority.
8. **Fighter selector.** A tiny network reads its own inventory and the enemy's gear during the 3-2-1 countdown and picks which specialist fights the round (axe, UHC, others later). Each specialist is its own network with its own size and design.
9. **Neuron screen.** A live second screen that shows which neurons in the fighter fire at each moment. Hover a neuron to see what it stands for. Pause and rewind to look at one decision, like the moment it chose to shield.
10. **Public challenge.** Anyone can play the fighter, best of 3, with a small cash prize if they win.

## Fighter skills

- Crit jumps: jump before a fully charged swing for 1.5 times damage, with sprint resets between hits.
- Shield baiting: raise and drop the shield so the enemy wastes an axe swing.
- Strafing and W tapping to reset sprint.
- Spacing: never hover at the exact distance where a jumping enemy lands a crit.
- Break and shoot: disable the enemy shield with the axe, then fire a crossbow that was loaded earlier inside the 5 s the shield is down.
- Axe follow up: a dedicated skill for those same 5 s after the shield breaks.
- Weapon reflex: switch from the crossbow to the axe when a melee enemy closes inside about 3.5 blocks.
- Load the crossbow only at a safe distance.
- Whiff guard: only swing when the aim ray actually meets the enemy's hitbox, because a missed swing resets the attack charge.
- Wall play: pin the enemy against a wall for combos and keep your own back off walls.
- Sprint knockback opener against mobs that chase.
- Golden apple timing as a learned choice, with absorption hearts as an input.
- Eat while the enemy holds its shield up, since it cannot swing behind it.
- Fake eat as bait (start eating, cancel, punish the rush).
- Cobwebs: break out of one fast, or place one at the enemy's feet after a knockback hit and swing while it is slowed.
- Pillar up 3 blocks and shoot down.
- UHC drills, one skill each with its own pass test: eat when low, put out fire with the water bucket, water clutch from a height, armor durability, get out of lava, get out of a cobweb, pour lava on the enemy, fishing rod, block placing, ender pearls.
- Missing items: the UHC fighter fights just as well with any item missing and never reaches for an item it does not have.
- Mace and wind charges, the newest 1.21 weapons.

## What the fighter sees

- The enemy's attack cooldown and the time since its last swing.
- Item durability and hunger for both players.
- The nearest 3 arrows in flight.
- Shield lockout after an axe hit (100 ticks) for both shields.
- A short memory of the last few decisions, or a small head that predicts the enemy's next move (swing, block, back off, heal).
- A grid of the blocks around both players, tall enough to see towers.
- Distance to the nearest wall behind each player.

## Opponents to train against

- A crit jumper.
- A healer that walks away when low, regenerates and comes back.
- A hit and run bot that lands one long reach hit and backs off.
- A loader punisher that rushes whenever our bot loads the crossbow.
- A mace and wind charge bot.
- An exploiter bot trained only to beat our current best.
- Open source PvP bots from GitHub as fixed benchmarks.
- Opponent styles summarized from YouTube PvP guides.

## Training ideas

- Gentle start for copied networks: freeze the copied part while the new parts settle, with a lower learning rate at first.
- Keep the best version by a fixed test panel, not the last one saved.
- An anchor to the starting network so a fine tune learns new things without forgetting old ones.
- A kit pair scoreboard that sends more practice to the kit matchups it loses most.
- A minimum share of plain axe fights so random kits do not dilute the main skill.
- Reach curriculum: chasing mobs start with shorter reach and grow to the real value as the bot improves.
- An opponent mix that follows the gaps, spending time where the bot is weakest.
- Blend several training seeds into one network.
- A shrinking border after 40 s, like UHC deathmatch, so stalling stops paying.
- Replay real losses: start simulator rounds from the exact openings the bot loses in the real game.
- Merge versions by weight math (averaging siblings of the same network).
- Farm check: before any new reward ships, prove the cheapest way to farm it loses points.

## Simulator and real game checks

- A self check before every real run: a second bot watches the first sprint, crouch, shield and swing, and the run refuses to start if the server sees anything different.
- A nightly watchdog that replays saved real game traces in the simulator and flags any drift.
- A head to head against the other public Minecraft PvP simulators on the same real game tests.
- One loader for every tool, with a test that fails if any tool plays a version differently from how it trained.
- Stop a real benchmark early when a version is clearly behind, and spend real game time on the versions that can still win.
- Every results file counts wins from our bot's side.
