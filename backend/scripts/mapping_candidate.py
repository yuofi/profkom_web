"""A candidate mapping for the operator to check before migrate_v13 --apply (decision 37).

    python scripts/mapping_candidate.py --database /abs/copy.db --out /abs/candidate.json --review /abs/review.json

Opens the database read-only, on the schema of the old site or a migrated one. `--out` is
a mapping file migrate_v13 accepts as is, with only what the data proves unambiguously:
- the chair: the only legacy super_user (АВ-16, a temporary chair for the checks);
- the HR block: the only block named HR;
- VK identities: the VK ID that the old VK login saved in the link of an account
  without a password (contact_info.vk = https://vk.com/id<number>), or in its address
  vk_<number>@vk.com. A VK ID named by two accounts, or already linked, is left out.

`--review` explains every entry and lists what needs a person: accounts without a VK
ID, conflicts, the blocks without a master (assigned by hand after the release, УВ-1).
Both files hold IDs only. Check them before use: a profile link is what the old site
saved, not a proof of ownership of the VK account.
"""

import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import migration_report  # noqa: E402


def candidate(c):
    found = migration_report.unresolved(c)
    mapping, notes = {}, {}
    supers = found["legacy_super_user_ids"]
    if found["chair_missing"] and len(supers) == 1:
        mapping["chair_user_id"] = supers[0]
        notes["chair"] = dict(proposed=supers[0], basis="the only legacy super_user")
    else:
        notes["chair"] = dict(proposed=None, legacy_super_user_ids=supers, chair_missing=found["chair_missing"])
    hr = found["hr_block_candidates"]
    if found["hr_block_missing"] and len(hr) == 1:
        mapping["hr_block_id"] = hr[0]
        notes["hr_block"] = dict(proposed=hr[0], basis="the only block named HR")
    else:
        notes["hr_block"] = dict(proposed=None, candidates=hr, hr_block_missing=found["hr_block_missing"])
    shared = {s["vk_user_id"] for s in found["vk_id_shared"]}
    proposed, by_evidence = [], {}
    for entry in found["vk_only"]:
        if entry["vk_user_id"] and entry["vk_user_id"] not in shared:
            proposed.append(dict(vk_user_id=entry["vk_user_id"], user_id=entry["user_id"]))
            by_evidence[entry["evidence"]] = by_evidence.get(entry["evidence"], 0) + 1
    if proposed:
        mapping["vk_identities"] = proposed
    notes["vk_identities"] = dict(
        proposed=len(proposed),
        by_evidence=by_evidence,
        pending_user_ids=[e["user_id"] for e in found["vk_only"] if e["state"] != "active"],
        without_vk_id=[e["user_id"] for e in found["vk_only"] if not e["vk_user_id"]],
        conflicting_user_ids=[e["user_id"] for e in found["vk_only"] if e["evidence"] == "conflicting"],
        shared=found["vk_id_shared"],
    )
    notes["not_proposed"] = dict(
        unmapped_blocks=len(found["unmapped_blocks"]),
        email_case_groups=found["email_case_groups"],
        incomplete_user_ids=found["incomplete_user_ids"],
        ambiguous_vk_copy=len(found["ambiguous_vk_copy"]),
    )
    return mapping, notes


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--review", required=True, type=Path)
    args = parser.parse_args()
    if not args.database.is_absolute() or not args.database.is_file():
        parser.error("Use an existing absolute database path")
    if args.database.resolve() in (args.out.resolve(), args.review.resolve()):
        parser.error("Write the files next to the database, not over it")
    with sqlite3.connect(args.database.as_uri() + "?mode=ro", uri=True) as c:
        mapping, notes = candidate(c)
    notes["source_sha256"] = hashlib.sha256(args.database.read_bytes()).hexdigest()
    args.out.write_text(json.dumps(mapping, ensure_ascii=False, indent=2) + "\n")
    args.review.write_text(json.dumps(notes, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(dict(mapping_fields=sorted(mapping), vk_identities=len(mapping.get("vk_identities", [])))))


if __name__ == "__main__":
    main()
