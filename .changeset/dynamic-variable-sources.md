---
"scalemargin-dispatch-handler": minor
---

Dynamic variables now support real source types beyond field/concatenation: **constant**, **SQL query** (a SELECT against the connected lookup DB, parameter-bound and injection-safe), and **API fetch** (an HTTP endpoint with token interpolation + JSON-path extraction). SQL/API values resolve per recipient, cached within a campaign, timed out, and fall back with a warning on failure so a broken source can't wedge a dispatch. The admin Variables editor gains a per-source form and a live **Test** button; API header secrets are stored in the state DB and redacted in responses. The Logs viewer now expands each entry inline as an accordion below the row instead of a bottom panel.
