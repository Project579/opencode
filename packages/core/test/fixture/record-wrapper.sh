#!/bin/sh
# Generic recording wrapper: `record-wrapper.sh <log> [--resident] <command> [args...]`.
# Appends what it was asked to run to <log>, then runs it. With --resident it stays alive around the
# command (like a sandbox launcher that does not exec) and logs the child's pid instead.
log=$1
shift
if [ "$1" = "--resident" ]; then
  shift
  "$@" &
  echo $! >> "$log"
  wait
  exit $?
fi
printf '%s\n' "$*" >> "$log"
exec "$@"
