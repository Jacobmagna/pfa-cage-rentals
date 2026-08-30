-- Short display names for the facility TV board. The column itself is 0057;
-- this is the curated content, agreed name by name with Jacob 2026-08-30
-- (relaying Mark's wife, who asked for the blocked bars to say what is
-- blocking them rather than "Blocked").
--
-- WHY THESE ARE SHORTER THAN THE REAL NAMES: `programs.name` is written to be
-- unambiguous in the admin UI, and a 30-minute bar on the wall truncates
-- somewhere around 16-18 characters -- the same measurement that moved
-- DISPLAY_DEFAULT_HOURS from 4 to 3. `name` is unique-constrained and drives
-- coach, report and pay surfaces, so it is left alone.
--
-- CONVENTION: an unmarked program is BASEBALL; softball is the marked case.
-- That is what buys the space -- carrying both sport prefixes would push most
-- of these past the truncation point. Jacob's call, 2026-08-30.
--
-- MATCHED ON EXACT `name`. A program renamed in the admin UI simply keeps a
-- NULL display_name and falls back to its full name on the board -- wrong-but-
-- readable, never blank.
UPDATE "programs" SET "display_name" = 'Fall Travel' WHERE "name" = 'Baseball - Fall Travelball - Practice';--> statement-breakpoint
UPDATE "programs" SET "display_name" = 'HS Travel Game' WHERE "name" = 'Baseball - HS Summer Travelball - Game';--> statement-breakpoint
UPDATE "programs" SET "display_name" = 'HS Travel Prac' WHERE "name" = 'Baseball - HS Summer Travelball - Practice';--> statement-breakpoint
UPDATE "programs" SET "display_name" = 'Summer Program' WHERE "name" = 'HS Summer Program';--> statement-breakpoint
UPDATE "programs" SET "display_name" = 'Catching Program' WHERE "name" = 'HS Summer Program-Catching';--> statement-breakpoint
UPDATE "programs" SET "display_name" = 'Hitting Program' WHERE "name" = 'HS Summer Program-Hitting';--> statement-breakpoint
UPDATE "programs" SET "display_name" = 'Throwing Program' WHERE "name" = 'HS Summer Program-Throwing';--> statement-breakpoint
UPDATE "programs" SET "display_name" = 'Softball Program' WHERE "name" = 'Softball - HS Summer Program';--> statement-breakpoint
UPDATE "programs" SET "display_name" = 'Softball Travel' WHERE "name" = 'Softball - Travelball Practice';--> statement-breakpoint
UPDATE "programs" SET "display_name" = 'Youth Camp' WHERE "name" = 'Youth Summer Camp';
-- DELIBERATELY NOT SET: Cleaning, Front Desk, Homeschool and Manager. Their
-- agreed short form IS their full name, and the display already falls back to
-- `name` when display_name is NULL -- so writing them would add four rows to
-- maintain for no change on screen. NULL here means "no override needed", not
-- "forgotten". The first three are staff work types that should never occupy a
-- cage, so they should not reach the board at all.
