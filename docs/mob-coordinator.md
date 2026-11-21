# Mob coordinator

Plan only, nothing here is built yet.

## What it is

An invisible agent that makes hostile mobs work together. It has no body in the world. It watches the players and gives the mobs near them a shared plan.

Moves it should learn first:
- A creeper blows open a wall, then the zombies flood in through the hole.
- Endermen bridge a moat so the zombies can cross.
- Mobs learn where players walk and wait there.

## How it could work

Mineflayer bots are players, so they cannot steer mobs. The coordinator has to run on the server. Two ways in:

1. A Paper plugin. Paper lets a plugin send a mob to a spot, light a creeper and place blocks, so every move above fits. This is the real path.
2. RCON (remote console) commands from the crew code (`bridge/rcon.js`). Good for a quick test with summon, teleport and data commands, too blunt for real play.

## First steps

1. Log where players walk, block by block, on the crew server.
2. Script the creeper and zombie wall breach by hand and check it works in the real game.
3. Add the enderman bridge.
4. Only then let a small network choose which move to run and where.
