#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .tmp
export TMPDIR="$PWD/.tmp"
export KMP_USE_SHM=0

command="${1:-}"
case "$command" in
  setup)
    if [[ ! -x .venv/bin/python ]]; then
      python3.12 -m venv .venv
    fi
    .venv/bin/python -m pip install --upgrade pip setuptools wheel
    .venv/bin/python -m pip install -r requirements.txt
    .venv/bin/python scripts/get_models.py
    ;;
  eval)
    shift
    .venv/bin/python scripts/eval.py "$@"
    ;;
  serve)
    exec .venv/bin/uvicorn app:app --host 0.0.0.0 --port 8788
    ;;
  test)
    exec .venv/bin/python -m pytest -q
    ;;
  *)
    echo "usage: ./run.sh {setup|eval|serve|test} [arguments]" >&2
    exit 2
    ;;
esac
