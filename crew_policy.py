"""The crew's fighting brain: runs one saved version of the trained network for every crew bot that is fighting.

    uv run crew_policy.py --run runs/exp014/L4/checkpoints/v0006-step-039564544

bridge/crew/crew.js starts this on its own. It reads one JSON line per decision on stdin,
{"id": 7, "key": "Crew1", "obs": [125 numbers]}, and writes {"id": 7, "action": [11 numbers]} on stdout.
The first line it writes is {"hello": {"name": ..., "rate": ..., "kind": ..., "fair": ...}} once the network is loaded.

The version runs through pvpbot.versions.Player with the skill experts on, the same way tournaments and play.py
run it: its own input scaling, its strategy runtime (tracked per bot, keyed by the bot's name) and the shooter
and blocker experts. Change --run to drop in a later version.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# DEC-082 (proposal 5): L1-v0010, now that the crew feeds it fair health. Switch back with
# --run runs/exp014/L4/checkpoints/v0006-step-039564544 (L4-v0006, DEC-077), also fighter_run_before in crew.config.json
DEFAULT_RUN = "runs/ft-oct29/L1/checkpoints/v0010-step-059565824"


def reply(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", default=DEFAULT_RUN, help="a saved version folder (model.zip and vecnormalize.pkl)")
    ap.add_argument("--no-skills", action="store_true", help="without the shooter and blocker experts")
    args = ap.parse_args()

    run = Path(args.run)
    if not run.is_absolute():
        run = ROOT / run
    if not (run / "model.zip").exists():
        reply({"error": f"no saved version at {args.run}"})
        return
    try:
        import torch
        torch.set_num_threads(1)  # one small network, and the training runs need the cores
        from pvpbot.versions import Player
        player = Player(run, skills=not args.no_skills)
    except Exception as err:  # a broken install or an old version folder, reported to the bots
        reply({"error": f"could not load {args.run}: {err}"})
        return
    # DEC-082: fair says the version trained with fair health (DEC-076), so the crew's fighter feeds its own estimate
    stage = json.loads((run / "stage.json").read_text()) if (run / "stage.json").exists() else {}
    reply({"hello": {"name": player.name, "rate": player.rate, "kind": player.kind_inputs,
                     "fair": bool(stage.get("fair_health"))}})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = {}
        try:
            msg = json.loads(line)
            action = player.act([msg["obs"]], keys=[msg["key"]])[0]
            reply({"id": msg["id"], "action": [int(x) for x in action]})
        except Exception as err:
            reply({"id": msg.get("id"), "error": str(err)})


if __name__ == "__main__":
    main()
