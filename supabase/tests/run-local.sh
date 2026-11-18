#!/usr/bin/env bash
# Applies all migrations to a throwaway local Postgres (with Supabase stubs) and runs rls.test.sql.
# Needs the postgresql-16 server binaries (Debian/Ubuntu: apt install postgresql). Run as root or any user.
set -euo pipefail
cd "$(dirname "$0")/../.."
PGBIN=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
DIR=$(mktemp -d); PORT=${PGPORT:-54329}
chmod 755 "$DIR"
RUN="bash -c"; [ "$(id -u)" = 0 ] && { chown postgres "$DIR"; RUN="su postgres -c"; }
$RUN "$PGBIN/initdb -D $DIR/data -A trust >/dev/null && $PGBIN/pg_ctl -D $DIR/data -o '-p $PORT -k $DIR' -l $DIR/log -w start >/dev/null"
trap "$RUN \"$PGBIN/pg_ctl -D $DIR/data -m immediate stop >/dev/null\"; rm -rf $DIR" EXIT
run() { if [ "$(id -u)" = 0 ]; then su postgres -c "psql -h $DIR -p $PORT -U postgres -v ON_ERROR_STOP=1 -q -X $*"; else psql -h $DIR -p $PORT -U postgres -v ON_ERROR_STOP=1 -q -X "$@"; fi; }
run "-d postgres -f $PWD/supabase/tests/stub.sql"
for f in supabase/migrations/*.sql; do echo "apply $f"; run "-d postgres -f $PWD/$f"; done
echo "re-apply reference data (idempotent)"; run "-d postgres -f $PWD/supabase/migrations/20261118000004_reference_data.sql"
run "-d postgres -o /dev/null -f $PWD/supabase/tests/rls.test.sql"
echo "ALL LOCAL SCHEMA TESTS PASSED"
