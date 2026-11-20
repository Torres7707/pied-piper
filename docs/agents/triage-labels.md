# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Pied Piper workflow state labels

In addition to the five canonical triage labels above, Pied Piper uses two execution-state labels to coordinate parallel runs and reviews:

| Label         | Meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `in-progress` | Claimed by a Dinesh run; prevents another Dinesh from picking it up      |
| `in-review`   | PR opened and handed over to Gilfoyle for review                         |
