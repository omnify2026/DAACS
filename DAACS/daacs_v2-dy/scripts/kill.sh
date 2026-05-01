#!/bin/sh
set -e

for port in 8001 5173 5174 5175 5176 5177 5178 5179; do
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "Killing port $port: $pids"
    kill -9 $pids 2>/dev/null || true
  else
    echo "No process on port $port"
  fi
done
