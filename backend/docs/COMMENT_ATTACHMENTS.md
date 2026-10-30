# Comment attachments

Comments use their own file bindings, separate from task attachments and results.
Upload with `owner_kind="task"`, the existing task ID, and `purpose="comment"`.
Any current task reader may upload a comment file; this does not confer task-edit
or task-attachment permissions. Upload completion still verifies/seals the bytes.

`POST /api/tasks/{id}/comments` and `PATCH /api/comments/{id}` accept optional
`file_ids` (at most 100 unique completed IDs). Create defaults to an empty list;
omitting `file_ids` on PATCH preserves the current bindings, while `[]` removes
them. A comment may contain files without text, but cannot have neither. Newly
bound files must belong to this task, use the comment purpose and have been uploaded
by the acting user. An authorized editor of another user's comment may retain its
existing files. Comment DTOs expose `attachments` as safe FileRefs: ID, name, MIME
type and size only.

An unpublished file is readable only by its uploader while that user still has
current task access. A current comment binding publishes it to current task
readers. Byte/download/preview requests recheck that access. Removing the last
current binding revokes publication; its uploader can still read the own draft
within current task access. Old comment-history snapshots contain only FileRef
metadata and never authorize old bytes. Task membership/grant revocation also
revokes file access immediately.

Comment history records previous content and attachment metadata; task activity
contains an attachment diff, including attachment-only edits. Invalid later file
or mention validation rolls the entire HTTP command back. Existing SQLite comments
receive an additive `files_json` column defaulting to `[]`; old text/history, IDs,
indexes and triggers are retained. Account-retention explicitly reviews this new
JSON column.

Focused regression: `tests/test_comment_attachments.py`, together with contextual
file delivery/integrity, retention and tracker/history tests. All tests use
synthetic SQLite databases and mocked object storage.
