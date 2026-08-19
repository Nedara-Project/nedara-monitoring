#!/bin/bash
set -euo pipefail

cd "${HOME_DIR}"

echo "-- Starting up monitoring service ..."

# The application forces Flask-SocketIO's "threading" async mode, for which a
# multi-threaded worker is the documented choice. A single worker is mandatory:
# the SocketIO rooms and the collection threads live in the process.
# --no-control-socket: gunicorn 26 would otherwise try to create its control
# socket in the (read-only for the runtime user) application directory.
exec gunicorn app:app \
    --worker-class gthread \
    --workers 1 \
    --threads 24 \
    --no-control-socket \
    --bind 0.0.0.0:5000
