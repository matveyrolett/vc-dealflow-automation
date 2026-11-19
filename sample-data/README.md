# Sample data

Everything here is **fake** — invented companies, people and numbers — so the system can be understood and tested without any real deal data.

| File | What it is |
|---|---|
| `deal-log-FUND1-sample.csv`, `deal-log-FUND2-sample.csv` | Deal Flow Logs as the intake script writes them (same columns). NEEDS REVIEW rows appear in both, exactly as in production. |
| `deal-outcomes-sample.csv` | Each deal's current pipeline stage, as exported from the CRM. Used by the source analytics. |
| `walkthrough/1a → 1b` | A forwarded pitch email and exactly what the intake script produces from it. |
| `walkthrough/2a → 2b` | A Fellow call recap and the CRM meeting note the call-notes sync writes, plus the knock-on effect on the deal card. |
| `walkthrough/3` | An example task digest from the briefing workflow. |

The intake walkthrough (`1a → 1b`) was checked against the real parsing functions in `apps-script/intake.gs`.
