#!/bin/sh
set -e

if [ "$RUN_MIGRATIONS" = "true" ]; then
  echo "Running prisma migrate deploy..."
  ./node_modules/.bin/prisma migrate deploy
fi

if [ "$RUN_SEED" = "true" ]; then
  echo "Seeding database..."
  ./node_modules/.bin/prisma db seed || true
fi

exec "$@"
