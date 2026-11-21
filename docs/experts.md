# The two skill experts

The fighter has 2 small helper networks, the skill experts. Each one takes over a few of the fighter's actions in one situation and hands them back when the situation ends. The shooting expert aims and fires the bow and crossbow. The blocking expert raises the shield against arrows. Their weights are in `weights/experts/`.

The fighter itself picks from 11 action heads: forward or back, left or right, sprint, jump, turn (yaw), look up or down (pitch), attack, use, weapon, sneak and lock aim.

Both experts were trained with PPO (Proximal Policy Optimization, the masked version from sb3-contrib) in the project's own Minecraft 1.21 combat simulator. The simulator plays 10 decisions per second.

## Shooting expert

### What it controls

It sets 4 of the 11 heads: turn, look, use and lock aim (always on). Loading the crossbow and starting a bow draw stay scripted. Its actions are deterministic.

It takes over when all of these hold:
- a bow or crossbow is in hand
- the enemy is at least 4.5 blocks away
- the fighter's strategy allows ranged play

It hands control back when the enemy's shield is raised and facing us, since an arrow into a facing shield is wasted.

### Network

- 2 layers of 128 for the policy and 2 layers of 128 for the value.
- 64 inputs: 32 from the fighter's own inputs, 2 for the lead offset (where to aim ahead of a moving target), and the change in 10 inputs over the last 1, 2 and 3 decisions. Inputs are normalised.
- 3 action heads: 9 sideways offsets and 9 up or down offsets around the lead point, plus fire or hold. Within 9 blocks only the coarse offsets are allowed. Fire is masked when there is nothing to fire.

### The drill

It starts from random weights.

- Our side holds a crossbow, or a bow in 30% of rounds. Arrows never run out and lock aim is on.
- Our side moves in 6 modes, so the expert learns to shoot while moving: still (20% of rounds), strafe (25%), walk in (15%), sprint in (15%), back off (15%) and jump while strafing (10%).
- The target starts 6 to 24 blocks away on a floor 30 blocks wide. Both sides are healed every step, so a round always lasts 200 decisions.
- There are 8 target kinds: still, straight line, strafing, turning, stop and go, jumping, shield user, and a person-like mover.
- Curriculum: target kind k joins once k/12 of the training is done, and the last 5/12 trains on all 8 kinds.

Reward per step:
- +0.1 per point of arrow damage
- −0.3 per missed arrow
- −0.2 more per arrow a shield stopped
- −0.002 per step

Settings: 512 arenas, 64 steps per arena per update, batch 4,096, 4 epochs, learning rate 3e-4, discount 0.98, GAE (generalized advantage estimation) 0.95, clip 0.2, entropy 0.01. Inputs and rewards are normalised. Training ran for 8,028,160 decisions.

### Pass bar and result

The bar is set against the scripted lead aim, which aims ahead of the target and holds fire at a raised shield. On every target kind, with at least 200 shots on each of 2 test seeds, the expert must hit more often than the scripted lead. It must also put no more shots into a facing shield. Both training seeds have to pass.

| Target kind | Expert hit rate | Scripted lead hit rate |
|---|---|---|
| Still | 99.7% | 98.9% |
| Straight | 95.8% | 91.0% |
| Strafe | 88.6% | 82.0% |
| Turns | 84.3% | 72.7% |
| Stop and go | 82.9% | 76.3% |
| Jumping | 81.4% | 56.2% |
| Shield | 87.4% | 59.0% |
| Person-like | 90.5% | 71.6% |
| Shots into a facing shield, all kinds | 0.05% | 1.07% |

Both seeds passed (seed 2 hit 90.4% on the person-like target). The seed 1 network is the one in this repo.

### How it got there

1. Drill version 1: our side only stood still or strafed. It passed its bar, but in real fights the fighters using it hit less than with the scripted lead (59.8% and 56.2% against 66.8% and 64.5%). In the drill our side never chased the target, so it never learned to shoot on the move.
2. Drill version 2 added the 6 movement modes. It passed its bar (person-like 94.8% against 80.3%), but in fights it still trailed the scripted lead.
3. The final expert is drill version 2 retrained in the simulator profile whose movement and knockback were checked against the real game.

## Blocking expert

### What it controls

It sets 3 of the 11 heads: turn, look and use (the shield). Its actions are sampled from the network.

It takes over when all of these hold:
- we hold no bow or crossbow
- the enemy holds or is using a bow or crossbow
- the enemy is at least 4.5 blocks away
- the fighter's strategy allows the shield

### Network

It is a full fighter network: 2 layers of 256 for the policy and 2 layers of 256 for the value, 125 inputs and the same 11 heads, of which the fighter uses 3 at runtime.

### Where it started

The blocker is a fighter that went through 2 block drills.

1. A fighter started from random weights (strategy letter A) and went through self-play evolution, where the best networks are copied and retrained under new strategy letters (F, then I, then G). The base is G13 at generation 7, after 28,992,256 decisions.
2. Block drill 1 added 1,911,296 decisions.
3. Block drill 2 added 6,317,568 decisions, then 1,687,296 more with a stricter pass window.

That makes 38,908,416 decisions in total. As the fighter's input set grew along the way (110 inputs, then 114, then 125, and a new 11th head), the network was widened to match.

### The drills

Both drills use strategy letter X: no melee, no ranged weapon and no crossbow opening, so blocking is the only useful skill.

Reward on top of the fighter's normal reward:
- +1.0 per arrow blocked
- −1.5 per arrow taken
- −0.02 per step with the shield up (so it does not hold the shield forever)

Block drill 1: a scripted archer only, 20 arrows a round. It passes at 90% blocked over the last 300 arrows.

Block drill 2: the shooter rotates through a scripted archer, a skeleton, a skeleton with a Power III bow and a pillager, switching every 300,000 decisions, with 10 arrows a round. It passes when all 4 reach 90% blocked over a 300 arrow window. The final round of training raised the window to 1,000 arrows.

Settings: 256 arenas, 64 steps per arena per update, batch 4,096, 8 epochs, learning rate 3e-4, discount 0.995, GAE 0.95, clip 0.2, entropy 0.01.

### Result

At the end of block drill 2, over 1,000 arrows each, it blocked 92% of the archer's arrows, 90% of the skeleton's, 92% of the Power III skeleton's and 95% of the pillager's.

Fight check, 2 seeds pooled. "Old blocker" is the block drill 1 network. L2 is a full fighter strategy using each blocker.

| Share of arrows blocked | Archer | Skeleton | Power III skeleton | Pillager |
|---|---|---|---|---|
| New blocker alone | 83% | 91% | 91% | 98% |
| Old blocker alone | 88% | 32% | 38% | 27% |
| L2 with the new blocker | 76% | 26% | 31% | 11% |
| L2 with the old blocker | 71% | 14% | 16% | 9% |

With the new blocker, L2 won 87% of fights against the skeleton (up from 81%) and 84% against the Power III skeleton (up from 72%).

### How it got there

1. Training a fighter directly against ranged mobs did not teach blocking. It learned to rush instead and blocked only 2% and 4% of arrows.
2. Block drill 1 (archer only) passed its bar but did not generalise: alone it blocked 17% of the pillager's arrows, and in fights 32%, 38% and 27% of the skeleton, Power III skeleton and pillager arrows.
3. Block drill 2 added the mobs. Its first pass was judged on a 300 arrow window that turned out to be too short a sample, and in fights its archer share fell to 65%, so it was not used. Training went on with the 1,000 arrow window, which gave the final network.

## Files

| Folder | Files |
|---|---|
| `weights/experts/shooter/` | `model.zip` (network), `vecnormalize.pkl` (input normalisation) |
| `weights/experts/blocker/` | `model.zip`, `vecnormalize.pkl`, `stage.json` (training settings) |

The blocker's `stage.json` has 2 fields to read with care. Its `from` field names the block drill 1 checkpoint, because the drill script always writes the drill's starting point there. Its `opponent` field is an unused default, since the block drill never trained against zombies.

The fighter loads the shooter from the folder named in the `AXEBOT_SHOOTER` setting, with `AXEBOT_LEAD`, `AXEBOT_SHIELD_HOLD` and `AXEBOT_AIM_OFFSET` on.
