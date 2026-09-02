-- Aligns stored precision with what a JS Date — and therefore every `at` the
-- API emits and every keyset cursor built from one — can represent. See the
-- comment on `at` in packages/db/src/schema.ts.
--
-- This rounds historical timestamps to the nearest millisecond. That is a real
-- (if sub-millisecond) rewrite of recorded audit times, accepted because the
-- API never exposed the microsecond component in the first place, and leaving
-- it in place makes paging skip rows.
ALTER TABLE "audit_log" ALTER COLUMN "at" SET DATA TYPE timestamp (3) with time zone;