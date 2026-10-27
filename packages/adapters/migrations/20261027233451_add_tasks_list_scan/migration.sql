-- The task list's index (Store.listTasks), for the reason sessions carry
-- theirs: the PK's second column is a random id, so it cannot order by
-- time, and without this a page reads and sorts the namespace's whole
-- history to return one screenful. Tasks grow without bound like
-- sessions. Ascending: a leading equality on namespace lets the
-- newest-first order walk it backwards.
CREATE INDEX tasks_list_scan ON tasks (namespace, created_at, id);
