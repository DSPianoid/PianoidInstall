# dev-pedalcal — 2026-11-05

**Report (user):** "pedal is inverted, and calibration did not fix it" (new controller board: Cmod A7 fa8c2d2 + Micro fw v3, blank EEPROM = factory map).

## Measured (read-only GET /controller + GET /midi/input, 4 Hz, live stack)
- Only X12 has a pedal; it was calibrated + SAVED by the user at 14:07:14 (switch, linear, min 323 / max 714).
- Released raw 313-326 -> CC64 0, backend sustain up; pressed raw 711-715 -> CC64 127, down. 3/3 presses clean. Pianoid port polarity normal.
- User confirmed afterwards: "Polarity is ok".

## Root cause of the original inversion
POL_AUTO of an uncalibrated switch latches the pin level ONCE at power-up as "released" (micro_usb_midi.ino initInput). The pedal is normally-closed (rest LOW); plugged in after power-up it latched HIGH -> inverted. A calibrated switch follows the captured travel (pctl_logic.h position(), works for min > max) and ignores the latch, so the user's calibration fixed it. Calibration already derives the polarity from the capture order; nothing sorts / clamps min/max (dialog, backend, firmware).

## Changes (Tunner, FE only; no firmware, no controller writes)
- PedalAssignDialog: a calibrated input shows "from calibration (normal / reversed)" instead of the polarity select.
- PedalCalibrateDialog: states the derived direction; Apply resets an explicit polarity to auto (SET_MSG after SET_CAL; firmware would invert a calibrated continuous input twice); first step picks Switch (on / off) / Continuous (half pedal); continuous captures released / half / pressed (curve Through mid); Revert restores calibration, type, polarity.
- utils/pianoidController: calibratedDirection, directionText.
- Docs: MIDI_SYSTEM.md (Calibrate / Pedal assignments rows, boot-latch paragraph, half-pedal setup).

## Verification
Jest PianoidControllerSection 9/9 (4 new); merged dev targeted 10 suites / 53 tests green. NOT live-verified on the device (would write to the controller).

## Commits
Tunner 5573fd9, 0ae0e4b -> dev merge a122d1e. Install 077a8ed, 1395215 -> master merge 1ce6e0b. Local only, not pushed.
