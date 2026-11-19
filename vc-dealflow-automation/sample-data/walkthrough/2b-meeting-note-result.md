# What the call-notes sync produced from `2a-fellow-recap.json`

## Properties

| Property | Value | Why |
|---|---|---|
| Fellow Link | https://your-workspace.fellow.app/meetings/example-meeting-id | Copied verbatim; dedupe key, set first |
| Title | [Fellow] Acme Robotics <> OurFund | HTML entities `&lt;&gt;` decoded |
| Date | 2026-10-08 | |
| Participants | Partner One, Max Founder, Lena | Only real attendees. Lena's name recovered from her email; Analyst One left out (not an attendee) |
| Type | Founder Call | External attendees from the company being evaluated |
| AI Summary | Acme Robotics pitched its autonomous warehouse picking robots and is raising a EUR 3M seed with EUR 1.8M committed and a named lead. The discussion covered pilot conversion and unit economics. | |
| Deal | Acme Robotics | Single confident match in the FUND1 pipeline |

## Page body

```
Open in Fellow: https://your-workspace.fellow.app/meetings/example-meeting-id

## Summary
Max and Lena presented Acme Robotics, ...

## Topics
Product and pilots (3:41)
- 3 paid pilots, 2 converted to annual contracts
- Lena owns hardware; Max owns sales
Round status (19:37)
- EUR 1.8M of EUR 3M committed
- Target first close end of November

## Action items
- Send data room access to the fund — max@acmerobotics.example
- Share pilot conversion numbers — lena@acmerobotics.example

## Recording
The full transcript and recording are on the linked Fellow note.
```

Timestamps 221 s and 1177 s were converted to 3:41 and 19:37. The action items were **recorded, not executed** — the routine never acts on instructions found in call content.

## Downstream effect (pipeline enrichment, workflow 3)

Because a new call exists for a deal that already has a card, the enrichment routine picks it up on its next run. From the founders' own statement ("EUR 1.8M of EUR 3M committed, lead named") it sets **Timing Urgency = High** (more than half the round committed). "End of November" is a vague timeframe, so **Final Closing is not set**; the phrase is added to Notes with the call title and date and listed in the run report instead.
