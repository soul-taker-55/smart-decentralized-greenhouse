# Phase 06 documentation — placement

Two files. Both NEW. Same convention as Phase 07 and Phase 05c: one record
(what was decided, found, and got wrong) and one plain-language README
(explains the phase to a reader who is not you).

## Where each goes

```
Phase_06_Vision/
├── PHASE_06_RECORD.md              ← NEW
└── Phase_06_Vision__README.md      ← NEW
```

Both at the top of `Phase_06_Vision/`, beside `6a_cam_firmware/` — matching
`Phase_07_Ledger/PHASE_07_RECORD.md` and
`Phase_07_Ledger/Phase_07_Ledger__README.md`.

## Git

```powershell
cd "C:\Users\medoo\Desktop\College\5th Year\CEA\Simulation\github\smart-decentralized-greenhouse"

git add "Phase_06_Vision/PHASE_06_RECORD.md"
git commit -m "Documenting Phase 06: phase record - sensor mismatch, two hardware faults, open items"

git add "Phase_06_Vision/Phase_06_Vision__README.md"
git commit -m "Documenting Phase 06: plain-language readme"

git push
git status --short
```

## What these say that you may want to check before pushing

The record does NOT claim the manual snapshot path works. It states plainly
that the server side is tested, the device side has not been observed working,
and that it should not be described as working until a row with
`trigger = 'manual'` exists in `camera_images`. If that changes before you
push, section 6.1 needs updating.

Also recorded as open: serial monitoring disconnected (§6.2), TLS verification
off (§6.3), device token exposed and needing rotation (§6.4), no retention
policy (§6.5), no image analysis (§6.6).

Section 7 records four methodology failures from this phase, including three
diagnostic tools that were proposed and withdrawn because they could not
distinguish anything, and a schema assumption caught by reading the schema. If
you would rather that section were shorter, it is the one to cut — but it is
the section an examiner is most likely to find credible.
