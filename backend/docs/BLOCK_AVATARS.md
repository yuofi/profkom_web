# Block avatars

A block keeps one nullable `block_metadata.avatar_file_id`. The additive startup
migration leaves existing block IDs, revisions and membership history unchanged.
Block list/detail responses expose only `avatar_url`: an authenticated same-origin
`/api/files/{file_id}/content` address, or null. Task projections add
`scope_avatar_url`; unresolved assignments add `scope_title` and
`scope_avatar_url`. These fields describe only the scope of an already-readable
record; subevents and independent queues have no block avatar.

An editor creates an upload intent with `owner_kind="block"`, the stable block UUID
as `owner_id`, and `purpose="avatar"`, then completes it through the existing file
API. PNG, JPEG and WebP use the same 10 MiB limit, bounded metadata/signature
verification and create-only sealed snapshot as personal avatars. This existing
verification checks file signatures and size; it is not full image decoding.

`PATCH /api/blocks/{block_id}` accepts `avatar_file_id` with the usual
`expected_revision`. An omitted field preserves the current image; null clears it.
Binding requires a completed, sealed image uploaded by the current actor for that
exact block. Personal avatars, other blocks and another uploader's file are
rejected. The existing `edit_block` policy remains authoritative: the chair,
chair deputies, and that block's master/deputies may upload and edit. An unbound
file is readable only by its uploader while they retain editing rights; a bound
avatar is readable by the same active approved accounts that read block cards.
Every byte request repeats authorization.

Replacement and clearing queue both staging/sealed keys for the existing durable
object-deletion worker and remove the old file record in the same transaction.
Old URLs and attempts to rebind the retired ID stop immediately, independently of
when storage deletion succeeds. No provider call is required to read block/task
metadata, and no signed storage URL is exposed by these DTOs.
