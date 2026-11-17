-- The default session list's partial index (Store.listSessions) was named
-- sessions_active_list_scan, for the rows that are not archived. "Active"
-- now has one meaning for a session, that it has an open work item, and a
-- session that is not archived has no name of its own. So the index is
-- named for what it leaves out. A rename only: the definition and the
-- queries it serves are unchanged, and nothing refers to an index by name.
ALTER INDEX sessions_active_list_scan RENAME TO sessions_unarchived_list_scan;
