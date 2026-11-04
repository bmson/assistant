# Croner 11 schedule semantics

This dependency upgrade intentionally adopts Croner 11's timezone behavior for
recurring cron schedules:

- A fixed local time inside a spring-forward gap runs at the first valid local
  minute after the gap. For example, a 02:30 schedule runs at 03:00, rather
  than the 03:30 result from Croner 10.
- A fixed local time during a fall-back overlap runs once at its first
  occurrence.
- Interval patterns continue through both actual occurrences of a repeated
  fall-back hour. For example, a 01:00/01:30 pattern in Los Angeles may run
  again during the second 01:00 hour.

The change affects future recurrence calculation. The existing `nextRun`
helper still advances strictly past its reference instant; the UTC exact-boundary
test remains in place. Stored `next_run_at` instants and one-time/persisted
schedule instants are not reinterpreted or rewritten by this library upgrade.
