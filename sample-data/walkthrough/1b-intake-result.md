# What the intake script produced from `1a-forwarded-email.txt`

## Drive

```
FUND1 deal folders/
└── Acme Robotics/
    ├── Acme Robotics - Email          ← Google Doc (below)
    └── Documents/
        ├── Acme Robotics - Deck.pdf     ← DocSend link converted to PDF (arrives ~1 min later)
        └── Acme Robotics - Deck (OCR)   ← searchable copy for the AI agents
```

## Email Doc (`Acme Robotics - Email`)

```
Fund: FUND1
Deal: Acme Robotics
──────────────
Source
Source marker (set by forwarder): Network — Jane Doe (Example Labs)
Forwarded to deal inbox by: partner1@your-fund.com
Original sender: Max Founder <max@acmerobotics.example>
Original To: Partner One <partner1@your-fund.com>
Original Cc: Jane Doe <jane@examplelabs.example>
Forward chain: Max Founder <max@acmerobotics.example> → partner1@your-fund.com → deals@your-fund.com
Source hints (evidence only, not a classification): Original email had Cc: Jane Doe
  <jane@examplelabs.example> (check whether this is an introduction). Body contains
  introduction/referral wording.
──────────────
From: Max Founder <max@acmerobotics.example>
Date: Tue, 6 Oct 2026 at 14:02
Subject: Acme Robotics - Seed deck
──────────────
Hi! Following Jane's intro, here is our seed deck.

Deck: https://docsend.com/view/abc123example
...
```

## Deal Flow Log — FUND1 (one new row)

| Timestamp | Status | Fund | Deal Name | Attachment Count | Error / Notes | Source Code | Source Detail |
|---|---|---|---|---:|---|---|---|
| 2026-10-06 14:05:12 | PROCESSED | FUND1 | Acme Robotics | 0 | DocSend conversion queued for "Acme Robotics - Deck.pdf" (using a password found in the email) — will be added to Documents automatically once ready (checked every minute). | N | Jane Doe (Example Labs) |

Things to notice:
- The password on the line below the link was matched to it and used for the conversion.
- The "Deck:" label in front of the link became the PDF's file name.
- The conversion runs asynchronously: a separate 1-minute trigger polls for the finished PDF, saves it, and creates the OCR copy.
- The routing line and the forwarder's own note were removed from the stored body, as was the forwarded header (including the Cc line — see the regression test in `tests.gs`).
