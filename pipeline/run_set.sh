#!/usr/bin/env bash
# Produce a whole set after choosing its base views:  bash run_set.sh A 201  (or pick first, then pass "-")
# Order matters: outfits first (the creator's class cards need them), then hair, hats, items.
set -euo pipefail
cd "$(dirname "$0")"
PY=../../venv/Scripts/python.exe
SET=$1
PICK=$2
[ "$PICK" = "-" ] || $PY sheet.py pick "$SET" --seed "$PICK"
for part in outfit_fighter outfit_cleric outfit_rogue outfit_wizard hair_bob hair_long hair_short hair_twintails hat_witch circlet ears_elf; do
  $PY sheet.py part "$SET" "$part" --seed 7 || echo "FAILED part $part"
  $PY sheet.py extract "$SET"   # extract after each part so the creator can be tried early
done
for item in longsword mace dagger staff shield_kite shield_round; do
  $PY sheet.py item "$SET" "$item" --seed 3 || echo "FAILED item $item"
done
$PY sheet.py extract "$SET"
$PY sheet.py contact "$SET"
echo "SET $SET DONE"
