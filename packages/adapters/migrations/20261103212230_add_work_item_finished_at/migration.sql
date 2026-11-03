-- When commitStep closed a work item; NULL while it is open. A commit
-- closes one item and opens the next at the same instant, so a run's
-- items meet end to end and a run spans its first item's created_at to
-- its last item's finished_at. Items closed before this migration keep
-- NULL: their end was never recorded.
ALTER TABLE work_items ADD COLUMN finished_at timestamptz;
