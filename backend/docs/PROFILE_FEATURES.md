# Profiles, manual achievements and KKR templates

`profile_features_models.py` registers additive tables before `Base.metadata.create_all`.
`profile_features.py` owns the HTTP commands and `anonymize(session, uid, old_pid, new_pid)`
retention callback. It never dispatches external messages or provider requests.

## Profile editor

GET/PATCH `/profile/me/editor` keeps contact fields and an optional avatar choice in
one request transaction. The expected revision and fingerprint both protect the saved
baseline, including changes made through compatible older contact/avatar APIs. An
invalid avatar or contact command rolls everything back. Presets and completed owned
avatar files are accepted; replaced files are retired through the object-deletion queue.
DELETE `/profile/me/avatar-drafts/{id}` can discard only the actor's unused avatar.
It cannot remove somebody else's file or the current bound avatar.

The UI prepares uploads, but applies the avatar only with the profile's common Save.
Discarding or replacing an unused prepared image queues cleanup. Navigation guards cover
contact edits, the avatar choice, upload activity and the separate password form.

GET `/profiles/{id}/activity` is a public-to-approved-members projection of role and
membership intervals. It returns safe team labels, roles and known dates, never private
audit reasons, scores, task content or working links. Imported assignments without an
interval remain explicitly undated. The profile separates current blocks/events from
the chronological history. Read failures remove cached information.

## Manual achievements

The catalogue has an explicit global/block/event scope and a finite local-icon set.
The central `achievement.manage` policy grants chair/deputies and HR master global
management, plus actual block masters/event heads in their own scopes. Their deputies
do not acquire this extra permission. Scoped recipients must be actual members/leaders
of the team (an event includes its child-team organizers). Self-awards follow the same
permission and scope checks.

Each manual issue has a separate grant ID and a frozen title/description/icon/scope
snapshot. Repeated issues are independent. Catalogue editing or archival never changes
past grants. Revocation is versioned, keeps grant/event history and does not affect KKR.
Active awards and safe issue/revocation facts are public to approved members. Service
notes and revocation reasons are visible only to the recipient and current scope award
managers. UserRefs resolve against current account identity; event JSON stores no names.

## Notification preferences and disabled delivery infrastructure

The owner stores an independent email/Telegram/VK choice for tracker changes, new or
approved applications, and PGAS documents. Defaults are all off. PUT requires the saved
preference revision. The UI clearly states that sending is not connected.

`collect_delivery_event(session, recipient, kind, payload, event_key)` receives already
authorized internal recipients. It stores only source kind/ID, channel/category/key and
`not_connected` state, deduplicated by recipient+event key+channel. No titles, message
bodies, addresses, provider credentials or task data are copied. Notifications emitted
through `notifications.emit` call it in the same transaction. Other owning modules call
the same helper for their events. The future adapter must call `delivery_event_allowed`
again immediately before attempting delivery. No sender/worker is installed here.

## KKR templates

Personal templates remain owner-only; team templates use current original KKR scope
permissions. They never grant access to a team, assignment, recipient or private field.
Values include a work title/description, hours, evaluation and existing criteria flags.
GET/list, versioned edit/archive, copying and prepare all preserve ownership/scope.

Prepare only copies values to the current editor; dates, recipients and correction
reasons stay under user control. Assignment preparation changes only hours/evaluation,
never public task text/status. Saving still uses normal merit/assessment commands and
their complete existing validations, dates, season rules and self-rating restrictions.

The optional `template_selection: {template_id, revision}` accompanies the final save.
`capture_template_use(session, actor, selection, target_kind, target_id, actual_values)`
rechecks template visibility, archive state, revision and target scope inside that same
transaction. It stores the frozen template version/values and actual saved values in
`kkr_template_uses`. A stale/inaccessible/foreign-team template rolls back the complete
command. Later template edits cannot recalculate or rewrite the saved work. Closed
season corrections use the same callback through their owning correction service.

Retention nulls explicit actor/owner/grantee identity fields, transfers grant participant
identity, removes personal preferences/delivery state and leaves personal templates
personal even after their owner is gone. Known recipient ID slots in use snapshots are
anonymized precisely; numeric values and template version snapshots remain intact.

## Verification

`tests/test_profile_features.py` exercises real HTTP permissions, versions, snapshots,
rollback, public history, atomic avatar replacement/discard and retention. Frontend
`profile-features.test.tsx` covers preference categories, role privacy, safe template
draft application and cache revocation; the avatar regression checks common Save.
`profile-features.integration.test.tsx` drives the actual profile/award/assessment UI
against a disposable nonce-guarded localhost API with synthetic accounts and storage.
