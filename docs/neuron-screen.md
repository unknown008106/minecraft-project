# Neuron screen for the fighter's network

Plan written at his ask. Nothing here is built yet.

## What it is

A live second screen that shows which neurons in the fighter's network fire at each moment of a fight. Hovering any neuron shows what it stands for.

## The network it shows

The fighter's policy network takes 125 inputs, passes them through 2 middle layers of 256 neurons and ends in 57 action options grouped into 11 decisions, `ACTION_DIMS = [3, 3, 2, 2, 18, 15, 3, 2, 5, 2, 2]` in pvpbot/sim/constants.py. The 18 options are turning steps (`YAW_STEPS`), the 15 are looking up or down (`PITCH_STEPS`) and the 5 pick the weapon (keep, axe, sword, crossbow, bow).

The 125 inputs (`OBS_DIM` in the same file) are 49 base numbers, a 7 by 7 grid of the ground around the bot (`GRID = 3`) and 27 more numbers. Comments in pvpbot/sim/constants.py explain slots 101 and up, for example slot 110 is the distance up to 48 blocks used for shooting. The first 49 have to be read from the code that builds the observation.

The middle layers use tanh, the library default (`MaskablePPO("MlpPolicy")` with no `activation_fn` set anywhere), so every middle neuron sits between -1 and 1. A second network of the same shape, the value network, scores how well the fight is going.

## The screen

The screen has 4 columns of dots, the inputs, layer 1, layer 2 and the actions. A dot's brightness shows how strongly that neuron fires right now, with one colour for positive and another for negative.

Only the strongest connections of the moment get drawn as lines. Drawing all of them would mean 112,128 lines (125 x 256 + 256 x 256 + 256 x 57).

The 49 ground grid inputs show as a small 7 by 7 map in place of 49 dots.

In each of the 11 decisions, the option the bot picked lights up.

A meter driven by the value network shows how well the bot thinks the fight is going.

A pause and rewind button freezes any moment, for example the moment it chose to shield, so that decision can be looked at neuron by neuron.

Rough sketch (the labels are examples):

```
INPUTS 125           LAYER 1 256     LAYER 2 256     ACTIONS 57
o your health        o o O o o       o o o o o       move    [forward]
o enemy distance --- o O o o o ----- o O o o o ----- turn    [left 10°]
o enemy health       o o o o O       o o o O o       attack  [swing]
[7 by 7 ground map]  O o o o o       O o o o o       ...
                                                     fight going well  ######....
hover a dot   ->   enemy distance = 2.4 blocks
```

## Hover

Hovering an input dot shows the variable's name and live value, for example "enemy distance = 2.4 blocks".

Middle neurons do not stand for 1 variable, so hovering one shows the 3 inputs that push it hardest at that moment, worked out by measuring how much each input moves that neuron right then.

Hovering an action option shows the action and how likely the bot was to pick it.

## How it plugs in

The fighter's decisions run in Python. Forward hooks on the policy and value layers copy every layer's numbers each time the bot decides, and a small websocket server sends them to the page, which draws on a canvas. The page keeps the last few minutes so pause and rewind work.

## Work list (estimates, about 4 to 6 h in all)

1. Turn the slot meanings into 125 short labels with units, about 1 h.
2. The hooks on the policy and value layers plus the websocket sender, about 1 h.
3. The page with the 4 columns, the strongest lines, the ground map, the meter, hover, and pause and rewind, about 1.5 to 3 h.
4. A test run against a bot to check every label and the timing, about 0.5 to 1 h.

## Open

Which network it shows is still open. The plan uses the trained fighter, and the same screen works on any small network, for example one trained from zero.
