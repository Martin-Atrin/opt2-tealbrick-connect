-- 0008 (C107): every tool with outward effects resolves WITH a hold family. Rows written before 0.5.0 have no family
-- for `outward`; give them "outward" now (new rows get it from classify()). money/destructive rows already carry theirs.
UPDATE connect_tools SET hold_family = 'outward' WHERE effect = 'outward' AND hold_family IS NULL;
