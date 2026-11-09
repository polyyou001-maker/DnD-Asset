#!/usr/bin/env bash
# Long body runs that survive the webui's CUDA OOM (it holds VRAM and fails every few hours):
# the webui is restarted and the run resumes. Finished frames are skipped by gen.
#   bash run_bodies.sh gen  <body> <state...>        generate the states, then check
#   bash run_bodies.sh redo <body> <list> [seed]     redo each "state dir pair" line of <list> (seed 7), then check
cd "$(dirname "$0")"
PY=../../venv/Scripts/python.exe
mkdir -p out/bodies
LOG="$PWD/out/bodies/webui.log"

restart_webui() {
  pid=$(netstat -ano | grep ':7860 ' | grep LISTENING | awk '{print $5}' | head -1)
  [ -n "$pid" ] && taskkill //PID "$pid" //T //F > /dev/null
  sleep 10
  echo "== webui start $(date +%H:%M) vram $(nvidia-smi --query-gpu=memory.used --format=csv,noheader)"
  (cd ../.. && venv/Scripts/python.exe launch.py --api --lowvram --opt-sdp-attention --skip-version-check \
    >> "$LOG" 2>&1 < /dev/null) > /dev/null 2>&1 &
  for _ in $(seq 1 90); do webui_up && return; sleep 10; done
}
webui_up() { curl -s -m 5 http://127.0.0.1:7860/sdapi/v1/progress > /dev/null; }

mode=$1 body=$2
case "$mode" in
  gen)
    shift 2
    for try in $(seq 1 10); do
      [ "$try" = 1 ] && webui_up || restart_webui
      if $PY -u bodies.py gen "$body" --states "$@" < /dev/null; then
        echo "== done $(date +%H:%M)"
        $PY -u bodies.py check "$body" < /dev/null
        exit 0
      fi
      echo "== failed $(date +%H:%M), restarting"
    done
    echo "== gave up"; exit 1 ;;
  redo)
    list=$3 seed=${4:-7}
    webui_up || restart_webui
    while read -r state dir pair; do
      pair=${pair%$'\r'}  # a list saved on Windows
      [ -n "$pair" ] || continue
      for _ in 1 2 3 4; do
        $PY -u bodies.py redo "$body" "$state" "$dir" "$pair" --seed "$seed" < /dev/null && break
        echo "== failed $state $dir $pair $(date +%H:%M)"; restart_webui
      done
    done < "$list"
    $PY -u bodies.py check "$body" < /dev/null
    echo "== done $(date +%H:%M)" ;;
  *)
    sed -n 2,5p "$0"; exit 2 ;;
esac
