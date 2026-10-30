#!/usr/bin/env bash
# run-tileserver-supervised.sh — keep the demo tileserver-rs up on :8080.
#
# WHY: the tileserver is the instance OpenClaw runs so it can monitor and
# analyse tile behaviour. It must survive an external kill (OOM) and be
# cleanly stoppable before a release rebuild (which needs the memory back).
#
# NOT a systemd/docker unit — this container has neither. It is a small
# watchdog loop: (re)start the binary, wait, restart on death.
#
# USAGE:
#   ./run-tileserver-supervised.sh start   # start the watchdog (idempotent)
#   ./run-tileserver-supervised.sh stop    # stop watchdog + server
#   ./run-tileserver-supervised.sh status  # one-line state
#   ./run-tileserver-supervised.sh logs    # tail the current log
#
# State lives in $RUNDIR so stop/status find it regardless of cwd.

set -u

REPO_TS="$(cd "$(dirname "$0")/../../../../tileserver-rs" && pwd)"
BIN="$REPO_TS/target/release/tileserver-rs"
CFG="$(cd "$(dirname "$0")/.." && pwd)/config.toml"
RUNDIR="${TILESERVER_RUNDIR:-/tmp/tileserver-supervisor}"
LOG="$RUNDIR/tileserver.log"
PIDFILE="$RUNDIR/watchdog.pid"
SERVERPID="$RUNDIR/server.pid"

# 1 GiB budget: sized for the 20-asset io-lulc mosaic (20 x 16 MB = 320 MB
# peak). Must be passed at launch — it is not durable in config.toml.
export TILESERVER_DATASET_CACHE_MAX_BYTES="${TILESERVER_DATASET_CACHE_MAX_BYTES:-1073741824}"

is_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

watchdog_loop() {
    mkdir -p "$RUNDIR"
    while :; do
        if [ -x "$BIN" ]; then
            "$BIN" --config "$CFG" >>"$LOG" 2>&1 &
            echo $! > "$SERVERPID"
            wait $! 2>/dev/null
        fi
        # Fell through: the server exited (crash / OOM kill). Log and back off
        # briefly so a hard-failing binary does not spin the CPU.
        echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') supervisor: server exited, restarting in 3s" >>"$LOG"
        sleep 3
    done
}

case "${1:-status}" in
    start)
        if is_alive "$(cat "$PIDFILE" 2>/dev/null)"; then
            echo "already running (watchdog pid $(cat "$PIDFILE"))"
            exit 0
        fi
        mkdir -p "$RUNDIR"
        setsid nohup bash -c "$(declare -f watchdog_loop); RUNDIR='$RUNDIR' LOG='$LOG' BIN='$BIN' CFG='$CFG' SERVERPID='$SERVERPID'; watchdog_loop" \
            >>"$LOG" 2>&1 < /dev/null &
        echo $! > "$PIDFILE"
        sleep 1
        echo "started: watchdog pid $(cat "$PIDFILE")"
        ;;
    stop)
        for f in "$PIDFILE" "$SERVERPID"; do
            p="$(cat "$f" 2>/dev/null || true)"
            if is_alive "$p"; then kill -TERM "$p" 2>/dev/null; fi
        done
        # Belt and braces: the binary itself.
        pkill -x tileserver-rs 2>/dev/null || true
        rm -f "$PIDFILE" "$SERVERPID"
        echo "stopped"
        ;;
    status)
        p="$(cat "$PIDFILE" 2>/dev/null || true)"
        s="$(cat "$SERVERPID" 2>/dev/null || true)"
        if is_alive "$p"; then
            printf 'watchdog: up (pid %s)  server: %s  ' "$p" \
                "$(is_alive "$s" && echo "up (pid $s)" || echo "restarting")"
        else
            printf 'watchdog: down  '
        fi
        printf 'health: %s\n' "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/health 2>/dev/null || echo 000)"
        ;;
    logs)
        tail -n "${2:-40}" "$LOG"
        ;;
    *)
        echo "usage: $0 {start|stop|status|logs [n]}" >&2
        exit 2
        ;;
esac
