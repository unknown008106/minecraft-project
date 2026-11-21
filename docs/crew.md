# The crew

Helper bots on their own survival server that do what the owner (Live_Fonam) types in chat. They fight with the project's trained fighting network, and they mine, build, farm, explore, follow and fetch with scripts.

## Start it

The crew server is separate from the training server. It has its own folder (`server-crew/`), its own world, port 25566 and RCON (remote console) port 25576, so live training runs on the arena server are never touched. It reuses the training server's Paper jar and Java, so setting it up downloads nothing.

```
python3 server.py crew-setup     # once: makes server-crew/ (whitelist, operator, ports)
python3 server.py crew-start     # starts it in the background, 1 GB of heap
node bridge/crew/crew.js         # the bots join (Crew1 and Crew2)
python3 server.py crew-stop      # saves and stops the server
```

The server needs about 1.7 GB in all (1 GB of heap plus Java's own memory), the bots about 120 MB and the fighting network about 230 MB. On an 8 GB Mac with training running, check `memory_pressure` first.

Join `localhost:25566` in Minecraft as Live_Fonam. The whitelist holds Live_Fonam and the bot names, and Live_Fonam is an operator there. Spawn protection is off, because the bots are not operators and the default protection silently undid every block they broke near spawn. `python3 server.py crew-cmd <command>` runs one server command, for example `crew-cmd give Crew1 iron_pickaxe`.

Other options for the bots: `--bots 3` starts Crew1 to Crew3, `--names A,B` uses other names (add them to `bridge/crew/crew.config.json` and run crew-setup again so they are whitelisted), `--run runs/<version>` fights with another saved version, `--no-translator` turns plain words off.

## Commands

Only Live_Fonam's chat counts. Commands start with "!" because "/" is the server's own. Put a bot name right after the "!" to talk to one bot, otherwise every bot does it.

```
!kill [radius] [player]   attack every non-friend within the radius (default 50), all bots on one shared target
!guard [radius]           keep attacking hostile mobs and non-friend players that come within the radius (default 16)
!stop                     drop everything at once
!come                     walk to you once
!follow                   keep following you
!stay                     stop following or mining and stand still
!mine <block> [count]     mine a resource, default 5, for example !mine diamond 5
!status                   say what it is doing, its health, food, position and pickaxe
!give                     walk to you and drop everything it collected (keeps tools, weapons, armor, arrows, torches)
!human off|light|full     how human its mining looks
!quiet                    only the important news in chat (say it again for normal)
!verbose                  every bit of news in chat (say it again for normal)
!build <blueprint> [here | x y z] [north|east|south|west]
                          build a blueprint where you stand or at x y z, its front toward you unless you name a side
!farm [wheat|carrot|potato] [here]
                          with here: build the village wheat farm where you stand and keep it going, without: tend the nearest farm
!expand <build>           add one module to a farm or a wall the crew built (the small wheat farm becomes the large one)
!explore [radius]         scout around (default 64), report finds with coordinates, then come back
!design <name> <words>    have Claude Sonnet draw a new blueprint from your words (the translator does this for you)
!blueprints               list what it can build
!craft <item>             craft a wooden, stone, iron or diamond pickaxe, a furnace or a crafting table and hand it to you
```

Examples: `!Crew1 mine iron 10`, `!kill 30`, `!kill 20 Steve`, `!Crew2 come`, `!all stop`, `!build small_hut here`, `!build wall 120 64 -40 east`, `!farm wheat here`, `!expand wheat_farm`, `!explore 96`.

Build, farm, expand, explore and design go to one bot when you ask the whole crew (two bots on one site get in each other's way): the first one with nothing to do takes it.

Ore names work as you would say them: diamond, iron, coal, gold, copper, redstone, lapis, emerald, quartz, debris. Each covers the normal and the deepslate ore. Plurals work too ("diamonds"), and "wood" or "log" means any log. Anything else is taken as a block name, for example `!mine oak_log 8`.

## Plain words

A line that starts with "@crew", or with a bot name and no "!", goes to the translator: Claude Haiku 5.5 (the cheapest model) turns it into the commands above, and the bots say what they will run. For example "@crew go get me some diamonds and then come back" becomes `!mine diamond 5` then `!come`, and "@crew build me a small house here" becomes `!build small_hut here`. The translator knows the blueprint list. For something the list does not have ("@crew build me a watchtower here") it sends `!design watchtower ...` then `!build watchtower here`, and the bots draw the blueprint first (see New blueprints below). A bot runs a plan in order and waits for each job to end. Every command it gets back goes through the same parser as typed ones, so it can only ever run these commands. A request the commands cannot do gets a short "Can't do that". The key comes from `~/.config/anthropic/api.env` (with the workspace ID sent on every request). Without it the translator is off and says so. A reply takes several seconds.

## The crafter

Type `craft me a stone pickaxe` or `craft a furnace` in chat (no "!" needed, no translator, works without an API key; `!craft stone pickaxe`, `@crew craft ...` and `Crew1, craft ...` work too). It knows the wooden, stone, iron and diamond pickaxe, the furnace and the crafting table, and common names: wood pickaxe, cobblestone pickaxe, cobble pick, workbench. Friends in `crew.config.json` may ask too, and the item goes to whoever asked.

What it does, all with survival actions:

1. Remembers who asked and what, reads its real bag (as the server has it) and plans from Mojang's own 1.21.11 recipes (`bridge/crew/recipes/all-recipes-1.21.11.json`, item tags expanded). The copies of the item it already carries are its own: it makes a new one.
2. Uses what it carries first: logs become planks and sticks, any wood and any of cobblestone, cobbled deepslate or blackstone work. It uses a crafting table within 6 blocks, or crafts and places one (the 4 planks are counted in the plan) and picks it back up after.
3. Iron pickaxe: ingots it carries first. With raw iron it smelts only the ingots it lacks, in a furnace within reach or one it crafts from 8 cobblestone and places, with coal, or spare planks, logs or sticks as fuel, and checks the ingots are in the bag before crafting.
4. Short of something, it asks for the exact amounts ("For the stone pickaxe I need 1 cobblestone more") and keeps the request. Hand it over (drop it by the bot) or let the gatherer bring it: it looks at its bag every second and carries on by itself, no second command.
5. A fight takes control like it does from any job. When the fight ends it looks at the bag again and carries on. Only one mode runs the bot at a time (the mode manager).
6. It walks up to you and drops the item at your feet, and counts it given only when the server says you picked it up. Out of reach (more than 48 blocks, or out of sight), it keeps it, says it is ready, and brings it when you come close. A repeated request, a fight or a retry never makes a second copy: asking again while it waits is "already on it", asking again while it holds the item brings that one.

Its priority sits below kill, retreat, guard, eat, give and come, above build and mine. `!stop` ends its jobs (an item it made stays in its bag). `!status` says what it is waiting for.

### The gatherer integration point

The crafter asks the gatherer role through one mode name. Register a mode called `gather` in `makeModes` (`bridge/crew/behaviors.js`, anywhere below eat). When materials are missing the crafter calls

```
manager.setOn('gather', { items: [{ name: 'cobblestone', count: 1 }], for: 'craft', requester: 'Live_Fonam' })
```

`items` are the exact missing amounts (item names: `oak_log`, `cobblestone`, `raw_iron`, `diamond`, `coal`). The gather mode gets them and calls `this.finish('done')` (or `this.finish('error')`), which settles the promise `setOn` returned. The crafter then looks at the bag again: done and complete means it carries on; still short means it asks the gatherer once more, then asks the player in chat. Without a `gather` mode it asks the player straight away. The crafter does not wait inside its own mode, so the gather mode has control while it works.

## News in chat

The bots tell you what matters, briefly, and the same news from the same bot at most once every 10 seconds. Always said: "I died at x y z", "My pickaxe broke", "Inventory full, coming back" (then it walks over and drops its haul), "I am low on food and have none", and how a job ended ("Got 5 coal", "I couldn't find any more diamond nearby"). Said unless you typed !quiet: "Killed Steve", "Taking damage, retreating", "Low on food, eating", "Little food on me, getting some first", "Found diamond (2/5)" for diamonds, emeralds, gold and ancient debris. Only with !verbose: every block a job mines. Building, farming and exploring say what they are doing ("Building wheat_farm at x y z, front to the north", "Getting 2 oak_log first", "Crafting oak_planks, oak_slab, composter", "Farming wheat at x y z"), how they ended ("Built small_hut at x y z in 6.2 min", "For small_hut I still need 1 white_bed. Give me those or put them in a chest near the site", "I won't build there: oak planks at x y z could be yours") and every find while exploring ("Iron ore x3 at x y z").

## Staying alive

Below 14 food (of 20), or below 14 health while not fighting, a bot eats the best food it carries (raw food included, never rotten flesh or spider eyes). Before a mining job it checks its bag, and with under 10 food points it first hunts up to 3 nearby cows, pigs, sheep, chickens or rabbits and picks up what drops. With no food at all and a farm the crew built within 96 blocks, it walks there, harvests what is ripe, takes bread, wheat, carrots or potatoes from the farm chest, bakes bread from 3 wheat on a crafting table it places and picks back up, and eats (plan step B5). Cooking with a furnace and fuel comes later. Down to 6 health with an enemy within 10 blocks, and no kill order, it runs until it is 16 blocks clear or back above 10 health. Out of air in water, it swims up.

## How it works

Each bot runs a mode manager (`bridge/crew/modes.js`, after the mindcraft project's modes) ticked every game tick. Highest priority first: kill, retreat, guard, eat, give, come, build, mine, explore, farm, follow, idle. Build, mine and explore are one shot jobs, starting one ends the other two. The farm keeps going underneath them and comes back when they end. The highest mode that is on and wants control runs. A fight pauses a mining job, and the job carries on afterwards. Stop is checked before any mode on every tick and always wins: it turns every mode off, clears the pathfinder goal, the movement keys, digging and any fight.

Every mode belongs to one skill profile, and the manager switches profiles as control moves between modes: fight (kill and guard, the trained network), survive (retreat and eat), mine, build (build and farm), and move (give, come, explore, follow). Leaving the fight profile puts the network's keys away, leaving the mine profile stops digging. Each profile can be swapped for a learned one on its own.

Friends are the owner, every crew bot and the names in `friends` in `crew.config.json`. The bots never attack a friend. Every attack goes through a guard that blocks the swing when the target is a friend or a friend stands in the line of the swing, and a bow or crossbow holds its shot while a friend is in the line. In kill mode all bots share one focus target (`targets.js` Blackboard): the player the owner named, else the enemy nearest the owner, kept until it dies or leaves the radius. When nobody is left a bot says "Area clear" and goes idle. Kill and guard attack hostile mobs and non-friend players, never animals.

### Fighting is the trained network

`fight(bot, target)` in `bridge/crew/skills/fight.js` is the one entry point. Behind it each bot has a Fighter (`bridge/fighter.js`, the same class the training bridge uses) aimed at the target. Ten times a second it builds the 125 input observation, `crew_policy.py` picks an action with `pvpbot.versions.Player` (skill experts on, the version's own strategy runtime, one per bot), the action goes through the same 0 to 1 decision ping queue as `bridge.js`, and `Fighter.act` turns it into keys. The default version is L4-v0006 (`runs/exp014/L4/checkpoints/v0006-step-039564544`, since DEC-077, it replaced `runs/sim-oct26/L88` after the real GitHub check). Set `fighter_run` in `crew.config.json` or pass `--run` to drop in a later one, the memory network included, without touching the crew code.

Two things differ from the arena. The arena floor sits at height 100 and the Fighter reads the ground there, so the crew's Fighter reads it at the bot's own feet. There are no arena walls, so the network always sees itself in the middle of the arena. Until the fight has started (nobody hit yet, or nobody hit for 5 s) the bot walks to the target with pathfinder and hands it to the network within 5 blocks, his ask: aggressive to start a fight, then whatever works best. Training starts 25 to 27 blocks apart and every opponent walks in by itself, so the network never learned to open a fight against a mob or player that waits, and in the simulator its melee hits land at 2.7 to 3.8 blocks. Once anyone is hit the old rule is back: pathfinder only for a target further than 16 blocks, the network takes over within 10, so it can keep range and shoot.

The network was trained with the axe kit: diamond armor, a diamond axe in slot 1, a diamond sword in slot 2, a crossbow in slot 3, a bow in slot 4, a shield in the offhand and 6 arrows. When kill or guard starts, a bot that lacks any of it gets it through the server console. Whatever was in those slots is moved to the backpack first (and given back by the console if the move fails), and armor is only added to empty armor slots. Other inventories come with the general fighter later.

### Mining is scripted

The miner (`bridge/crew/skills/mine_branch.js`, plan step B1 upgraded in DEC-089) mines the way a careful player does in 1.21. It only goes for ore it could plausibly know about: ore with an open face on a tunnel or cave cell it has stood in or dug, or ore it can see from where it stands. Ore buried in rock is never found, so there is no X-ray.

For iron, coal and copper it first looks for caves: rays from its eyes find dark open air it can see, it walks to the far end of the cave, torches it and mines the ore in the walls. With no cave in sight, and always for diamonds (since 1.18 many diamonds next to air are never generated), it branch mines: a staircase down to the ore's best depth, then a 2 high main tunnel with a 12 block branch to each side every 3 blocks (2 solid blocks between branches, so every block between them shows a face), back to the main tunnel after each branch. Logs, sand and dirt it finds by walking on the surface.

The best depths come from the Minecraft wiki's ore pages (cited in the code): diamond and redstone Y -58, lapis 0, gold -16, iron 16, copper 48, coal 96 (so it mines just under the surface, it never climbs), emerald 90 in mountains, ancient debris 16 in the Nether.

Safety like a player: lava behind a wall it is about to open makes it turn, lava it can see next to it or under its next step gets a block (it keeps 32 cobblestone or dirt for that), a hole gets a bridge block or is only stepped into when the fall is 3 blocks or less, gravel and sand above a block are waited out before it steps under them, a water bucket goes on its feet when it burns, torches go on the right wall going in, and it records its path. When the job is done or the bag is full it walks home along that path (home is where the job started) and puts the haul in a chest within 8 blocks of home, keeping tools, armor, torches, food, buckets and 32 blocks. A full bag sends it back down to finish. With no chest at home and none carried it walks to you and drops the haul as before. It picks the fastest tool it carries that can harvest the block, says "I have no pickaxe" or "My pickaxe is too weak" when it cannot, and counts blocks dug and ore mined for the benchmark.

The old miner (one tunnel with the odd turn, plus anything within 4 blocks) is kept in `skills/mine.js` for the mining benchmark: `node bridge/crew/crew.js --miner old`.

The human setting adds random short pauses, eased looks around, small sideways detours on the way to an ore, a wobble on every head turn, and torches in dark places when it carries them. Off has none of it, light is the default, full pauses longer (1 to 6 seconds) and more often.

### Building from blueprints

A blueprint is a JSON (JavaScript Object Notation) file in `bridge/crew/blueprints/` (`skills/blueprint.js` has the full format): a size of at most 16 by 12 by 16, an origin (the cell that sits on the block under your feet, one block outside the front, so the build stands in front of you), a facing (the side its front is on), a palette of one character per block with block states such as facing, half and axis, and layers bottom up, each a list of rows from north to south. Layer 0 is the ground layer and replaces the grass. "." is air it clears and " " leaves the ground as it is. `!build` turns the blueprint to face you, or to the side you name, turning every facing and axis with it.

| blueprint | size | what it is | takes |
|---|---|---|---|
| wheat_farm | 7 by 9 | the plains village small farm, read from the vanilla 1.21.11 structure file (plains_small_farm_1.nbt): oak log border, a water channel down the middle, farmland rows on each side, wheat, a composter as the farmer's job site | 28 oak logs, 27 wheat seeds, 2 water buckets, a composter (7 slabs), a hoe |
| wheat_farm_large | 13 by 9 | the village large farm (plains_large_farm_1.nbt), two channels and two composters | 47 oak logs, 54 seeds, 2 water buckets, 2 composters, a hoe |
| small_hut | 5 by 5, 5 high | plank floor and walls, log corners, an oak door, a white bed, 2 wall torches, a slab roof | 59 planks, 25 slabs, 12 logs, a door, a bed, 2 torches (about 34 logs in all) |
| storage_room | 7 by 5, 5 high | cobblestone floor, oak walls, a door, 2 double chests on the back wall, 2 torches, a slab roof | 35 cobblestone, 46 planks, 35 slabs, 12 logs, 4 chests, a door, 2 torches |
| tree_farm | 9 by 9 | 4 oak saplings 4 apart on cleared ground, 5 torches | 4 saplings, 5 torches |
| wall | 9 long, 4 high | cobblestone with oak log posts at both ends and a cobblestone wall cap | 23 cobblestone, 7 cobblestone walls, 6 logs |

A build goes like a player's (`skills/build.js`):

1. The site. Every cell is checked before anything is touched. It only clears natural blocks: grass, dirt, stone, sand, gravel, flowers, leaves the game placed and logs of natural trees (a trunk that reaches natural leaves). Anything you could have placed (planks, glass, chests, beds, farmland, crops, logs without natural leaves) stops the job with one chat line naming the block and where it is, so a bot never wrecks one of your builds. Water or lava in the way stops it too. A cell that already holds the right block is left alone, so a build can be finished later or run again safely.
2. Materials. What the cells still need, from its bag, then from the chests within 16 blocks of the site (it takes only what the build needs). It fills empty buckets at water it can see. It says exactly what is missing and stops when something is out of its reach (a bed, a water bucket). The simple raw ones it gets itself (`skills/gather.js`): logs from natural trees it can see, cobblestone from stone it can see or a short staircase down, dirt, sand, coal (through the miner), seeds from grass. The simple ones it crafts (`skills/craft.js`, from the 1.21.11 recipes): planks, sticks, slabs, doors, torches, chests, fences, a hoe, a composter, on a crafting table it places off the site and picks back up. Crops start with the seeds it has, the harvest fills the rest.
3. Clearing, top down, digging again when gravel or sand falls in.
4. Placing, layer by layer, bottom up and outside in, a block with something to rest on before an overhang, a dirt scaffold under a block with nothing next to it (removed after, unless it fills a dip under the ground layer). Blocks with a facing (doors, beds, stairs, chests, fence gates) are placed while looking the right way, logs against the face of their axis, slabs and stairs against the right half. Farmland gets tilled with the hoe, water poured from buckets (two sources with a gap between make a third, so 2 buckets fill a channel of any length), then everything that hangs on others: doors, beds, torches, crops.
5. It walks with a pathfinder that never digs and never places stray blocks, prefers to stand outside the footprint, and opens doors. The job keeps its progress, so a fight or a meal can pause it and it carries on after.

What the crew built goes into `server-crew/crew-builds.json` (blueprint, where, facing, modules, crop), so `!farm` and `!expand` find it again. `!expand wheat_farm` adds one module (a divider of logs and another channel with its farmland), turning the small farm into the large one, and `!expand wall` adds 8 blocks of wall. The cells already built count as done.

### Farming

`!farm wheat here` builds the village wheat farm where you stand (unless the crew already has a farm within 24 blocks) and then tends it. `!farm wheat` tends the nearest farm the crew built. Tending (`skills/farm.js`) walks the rows, harvests wheat at age 7, replants, tills trampled farmland again, and once it carries 16 wheat puts the wheat (and seeds beyond the 32 it keeps for replanting) in a chest by the farm, placing one it carries or can craft when there is none. Then it waits by the entrance until something is ripe again. It never ends on its own, `!stop` or `!stay` ends it, and other jobs pause it. Carrots and potatoes use the same farm with their crop.

### Exploring

`!explore 64` (`skills/explore.js`) walks rings of waypoints within the radius, starting the way the bot faces, and a little way into caves it can see (at most 16 blocks below the start, never digging, at most 2 caves a trip). The same only what it can see rule as mining: blocks need a line of sight, animals and villagers count within 32 blocks with a clear line. Each find is said once with coordinates: a village (a bell, villagers, or several village blocks), a cave entrance, exposed ores grouped by kind, lava, water (at most 3 a trip) and animals for food with a count. After a time cap of 5 seconds per block of radius (90 seconds to 10 minutes) it walks back and sums up in one line.

### New blueprints from your words

When the translator finds no blueprint for what you ask, `!design <name> <words>` asks Claude Sonnet 5.5 (`bridge/crew/designer.js`, model claude-sonnet-5-5, the same key file and workspace header as the translator, a server side fallback if the model declines) for the blueprint JSON. The answer goes through the same checker as the library: 1.21.11 block names and states, at most 16 by 12 by 16, only blocks the builder can place, and the material count. A blueprint that fails gets one more try with the checker's errors. The bot says the size and the material list in chat before it builds, and the blueprint is saved in `server-crew/blueprints/` for next time. A reply takes up to a minute.

### Live tests

`node bridge/crew/livetest.js <test>` runs one live test from start to end on the frozen bench world (`bridge/crew/bench.json`): a world made once from seed 20261030 in `server-crew/bench/`, a pristine copy restored before every test, the same flat grass spot every time (17 88 -198 on the plains since BUG-119, the first spot was the spawn on a spruce canopy). `CREW_SPOT=x,y,z` runs a test at another spot of the same world, and the waiter (experiments/crew-live-wait.sh) takes a test marker ending in `@x,y,z` and a list in `CREW_TESTS`. The bot starts on the real ground 2 blocks east and 2 north of the spot, never on leaves or logs. It starts the crew server on it with `--config bench.properties --world-dir bench` (his own crew world is never touched), joins a test owner named CrewTester (whitelisted for the test, removed after), gives the kit over RCON, types the commands, saves a top-down picture built from block colors as a PNG (Portable Network Graphics) image to `runs/crew-tests/<test>.png` with the results in `<test>.json`, and stops the server by its PID. Tests: wheat_farm (build the farm, then one harvest, replant and store round with crops growing 100 times faster in the bench world only), mining_proof (a fresh bot with a stone pickaxe mines 5 iron then 10 coal), bench_old and bench_new (the mining benchmark below), small_hut, explore, translate. `node bridge/crew/livetest.js all` runs them in that order.

The mining benchmark mines 8 iron from the same spot with the same kit (an iron pickaxe, 48 torches, bread, 32 cobblestone, a water bucket) for at most 15 minutes, once with `--miner old` and once with the new miner, twice each, and writes ores per 100 blocks dug, minutes per ore, deaths, stuck events and the spot to `runs/crew-tests/bench.csv`. A benchmark that mines 0 ores is not passed (BUG-119). Blocks dug and ores come from the server's own player statistics, so both miners are measured the same way.

On the Mac, `experiments/crew-live-wait.sh` runs them with nobody watching: it waits for a free daytime slot (9:00 to 22:15, fewer than 4 runs, 20% memory free, the crew port free), runs one test at a time with a hard time limit, stops at 23:00 and carries on the next day after 9:00, gives up after its deadline and says why, stops the test, the crew and the bench server by their PIDs whatever happens, and commits and pushes runs/crew-tests itself. docs/handoff/DEC-089.md says what is done, what is next and how to resume. On his Windows PC the same tests run as jobs of the PC's job runner (docs/pc-setup.md), once docs/other-pc.md is on main.

## Files

```
bridge/crew/crew.js              starts the bots, reads the owner's chat, runs commands and plans
bridge/crew/commands.js          the chat parser and the command list
bridge/crew/modes.js             the priority mode manager
bridge/crew/behaviors.js         the crew's modes
bridge/crew/targets.js           friends, enemies, the shared focus, the friendly fire guard
bridge/crew/translator.js        plain words to commands through the Claude API
bridge/crew/skills/fight.js      fight(bot, target), the kit
bridge/crew/skills/policy.js     talks to crew_policy.py
bridge/crew/skills/mine.js       the old miner, kept for the benchmark, and the shared digging helpers
bridge/crew/skills/mine_branch.js  the miner: caves, branch mining, safety, home and the chest
bridge/crew/skills/human.js      the human-like touches
bridge/crew/skills/food.js       eating and gathering food
bridge/crew/skills/blueprint.js  the blueprint format, checker, turning and expanding
bridge/crew/skills/build.js      building: the site check, materials, clearing, placing
bridge/crew/skills/craft.js      crafting plans and the crafting table
bridge/crew/skills/crafter_plan.js  the crafter's planner on the 1.21.11 recipes, the craft request parser
bridge/crew/skills/crafter.js    a craft job: crafting by hand, smelting, handing the item over
bridge/crew/skills/gather.js     logs, cobblestone, dirt, sand, seeds, saplings, water
bridge/crew/skills/farm.js       tending a farm, food from the farm
bridge/crew/skills/explore.js    scouting
bridge/crew/skills/storage.js    chests: finding, reading, taking, storing
bridge/crew/skills/move.js       walking with a time limit
bridge/crew/designer.js          new blueprints through Claude Sonnet 5.5
bridge/crew/blueprints/          the blueprint library
bridge/crew/tools/village_farm.js  turns a vanilla village farm structure file into a blueprint
bridge/crew/tools/crafter_live.js  the crafter end to end on a running crew server (CrewTester plays the player)
bridge/crew/livetest.js          the live tests and the mining benchmark
bridge/crew/bench.json           the frozen bench world: seed, spot, benchmark kit
bridge/crew/crew.config.json     owner, bot names, friends, ports, the fighter version
crew_policy.py                   runs the trained network for the bots
server-crew/crew-builds.json     what the crew built (not in git, it belongs to the world)
```

Tests that need no server: `node --test bridge/crew/test/*.test.js` (89 tests, a fake 1.21.11 world in `test/mockbot.js`, the crafter's in `test/crafter.test.js`).

The crafter on a real server: start the crew server with nobody on it, then `node bridge/crew/tools/crafter_live.js` (or one scene: demo, six, iron, notable, far, twice). It starts Crew1 obeying CrewTester, logs CrewTester in, sets each scene up over RCON and types the requests in chat. Results go to `runs/crew-tests/crafter_live.json`.

## Later phases

Next: the newer fighters (the memory network, then the general fighter for any inventory) behind `fight(bot, target)`, teammates in the fighter's inputs for 2 against 1 and 2 against 2, mining and building learned from the owner's own recorded play in place of the human-like knobs (plan step B3), and a small learned dig chooser on top of the scripted miner (plan step B7).
