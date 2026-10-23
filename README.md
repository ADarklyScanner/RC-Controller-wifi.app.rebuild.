# FPV Car controller

A replacement controller for the **WL Tech FPV CAR** (the HD720 Wi-Fi camera module on 1/64 RC cars),
built because the stock app is poorly made. Two ways to run it:

- **Android app** (`app/`): install `FPV-Car.apk` from the [latest release](../../releases/latest). No Termux, no browser.
- **Termux** (`termux/fpv_car.py`): `python fpv_car.py serve`, then open http://127.0.0.1:8765.

Both share one screen (the app copies it from the Termux script at build time, `tools/extract_assets.py`).

## What it does

- Two-thumb sliders or a one-thumb joystick, 3 speeds plus MAX, 3 turn sharpnesses with full lock
- Circle left / right buttons, steering trim (the car's own), extra lock at full turn, less steering at speed
- Live 720p video (hardware decoded), photos and recordings saved to the phone's Gallery, optional date stamp
- Gallery with share and delete, connected timer (gold at 4:00, the battery lasts about five minutes),
  "Car disconnected" notice, PlayStation controller support (any Bluetooth gamepad: Xbox, 8BitDo and others work too)
- Shares the car politely: only one program on the phone can have the camera, so the app lets go of the car and
  the picture when it goes to the background, and the Termux version does the same when no controller page has been
  open for 5 seconds. Whichever is open (the app, the page in Chrome, or Nessari's drive screen) gets the car, and the
  screen says so when another one is holding the picture. In Chrome, turn mobile data off while driving (the app
  doesn't need this).
- Local commands for other apps on the phone: `GET http://127.0.0.1:8765/drive?t=0.5&s=0&ms=1000`, `/stop`, `/status`

## Android app only

`app/src/main/assets/app.js` is added after the shared screen by the app's own server, so these are in the APK and not
in the Termux version or the Chrome page (Settings > App):

- **Tap anywhere**: the spot you press becomes the centre. Two thumbs: left half throttle, right half steering. Stick:
  anywhere on the stick's half. Half a slider's length is full.
- **Stick straight zone**: no steering within this angle of straight; steering then builds gently to full lock at 90°.
- **Reverse speed** and **Gentle reverse start**: the car reverses faster than it goes forward, so reverse is scaled
  down and builds up over about a second. 100% and Off is the old behaviour.
- Settings fold into groups (Picture, Controls, Driving, Drift, Controller). **Test mode** (bottom of Settings) holds the
  slot tests, a speed check (screen refresh, touch reports, updates and messages to the car, camera pictures per second),
  a choice of screen updates (10 to 50 a second) and messages to the car (20, the stock app, to 100 a second), a steering
  speed test and a slot B / C test with the motor running.
- **Floor ruler** (Settings > Picture): lines on the floor at 5, 10, 20, 30 and 50 cm and 1 m in front of the car,
  each a tile wide, and a dotted line straight ahead. Drawn through this car's measured lens, so the lines bend the way
  the picture does. From Nessari's drive screen.
- **Kick start** (Settings > Driving): a slow speed from a stop, or a change between forward and back, gets about a
  tenth of a second at full (for the speed gear) first, so it actually starts rolling. From Nessari's drive screen.
- **Helpers** (Settings > Helpers, each with its own switch; from Nessari's drive screen): **stuck stop** (pushing
  throttle but the picture hasn't moved for a second: it stops pushing that way until you let go or go the other way),
  **corner limit** (full turn going forward eases off to 75%), **side nudge** (going straight, steers a little away from
  something close sweeping past one side, but not when something fills both sides), **speed bubble** (never slows you; brakes with a short burst of reverse
  only when something it's sure of on the floor, or a wall, is closer than the car can stop from its speed, and won't
  go forward with the nose 2 cm from it; after a brake, forward waits until you let go, back up, or it's clear), **straight hold** (with the steering at straight, the room above the floor
  acts as a compass and it keeps your heading when a tile edge knocks the car crooked) and **auto trim** (with straight
  hold on, a drive where it kept steering one way moves the car's trim 2 steps that way). They read a tiny grey copy
  of the picture (32 x 18) from the app 8 times a second, only while you drive; the speed bubble and straight hold
  also read a bigger one (320 x 180) while they're working. Corner limit, side nudge and straight hold start off, as
  in Nessari.
- **Modes** (M button; `modes.js`, loaded only the first time a mode is used; from Nessari's drive screen, without
  her brain or voice; modes drive at speed 2, and any stick, tap or Stop takes over):
  - **Tap to go**: tap the floor twice in the picture and it drives there (8 cm to 3 m), turning parked by the room
    compass and driving in legs of up to 50 cm with straight hold, the speed bubble and stuck stop. Switch in
    Settings > Controls.
  - **Come back** (to where it started, facing the way it first did), **Turn around**, **Start here**.
  - **Race mode**: a strip of tape across the track is the start line; it times your laps and keeps best times.
    **Car's laps**: it drives 3 laps between two lines of tape, 5% faster after a clean lap, 10% slower after one
    where it lost the lines.
  - **Follow**: a laser dot (red, green or blue), a tape line, between two lines, a wall on the left or right, the
    brightest or darkest part of the room.
  - **Explore**: it drives itself for a minute, veering from things close by, turning before walls and things on
    the floor, and working itself free when it gets stuck.
  - **Set-up tests**, kept on the phone: the **turning test** (a stepped circle that sets the compass scale and how
    far each steering pulse turns) and the **speed test** on floor tiles (cm a second at 50, 70 and 100%).
- **Car guide** (Settings, under Test mode): the paper sheet that came with the car, corrected by what was measured:
  connecting (open Wi-Fi, no password), battery and charging, speeds, camera, buttons and care.
- **Drift mode** (D button): throttle is light or full (full power can be lowered for slick tyres), nothing between;
  steering is stronger and not reduced at speed. Steering snap: a quick turn goes to full lock for a moment.
  Flick: reaching full lock at full throttle cuts power for one message (0.1 s), once per turn.

## Controller (PlayStation names; Xbox: A, B, X, Y, LB, RB, LT, RT, View, Menu)

- **Drive:** R2 forward, L2 reverse, left stick steers (right stick up/down also throttles), hold ✕ to brake
- **D-pad:** up/down speed gear (MAX too once unlocked), left/right turn gear
- **□** photo, **△** record, **L1 / R1** circle left / right, **○** stop (same as the Stop button)
- **Options:** settings. D-pad up/down picks a row, left/right changes it, ✕ presses it, ○ closes.
  The sticks still drive here, so trim and extra lock can be set on the move.
- **Share:** photos and videos. D-pad moves, ✕ opens (and plays/pauses a video), left/right next/previous,
  □ shares, △ deletes (twice to confirm), ○ back
- **Press the left stick:** whole picture / fill screen. **Press the right stick:** zoom 1×, 1.5×, 2×, 3×
- The controller buzzes at 4:00 (about a minute of battery left) and when the car drops out.
- If the controller disconnects mid-drive the car stops.
- **Worn controllers:** each controller is measured at rest when it connects and whenever it sits untouched for
  6 seconds. Stick and trigger drift is taken out, and a button or trigger that reads pressed with nobody touching it
  is ignored until it lets go. Settings > Test controller & dead zones shows live sticks, triggers and buttons, sets the
  stick and trigger dead zones, recalibrates on demand, and turns any button off for good. Kept per controller.

**How it was decoded, which toy it is for, and how to adapt it to yours:** [docs/HOW-IT-WAS-DECODED.md](docs/HOW-IT-WAS-DECODED.md)

## The car's protocol (decoded from packet captures)

Phone joins the car's open Wi-Fi `WL_FPV_CAR_xxxxxxxx`; car is `172.16.11.1`.

**Hello** (UDP to 23459, repeated every few seconds): `a88a2100 06000000 01000000 0000` and
`a88a2000 08000000 01000200 0000d204` (the last two bytes are 1234, the port the video goes to). The car answers
`a88a2100 02000000 0100` / `a88a2000 02000000 0100`. That is all it ever sends back: no battery or other telemetry.

**Drive** (UDP to 23458, 16 bytes every 50 ms):
`ca 47 d5 00 00 00 00 00 66 [steer] [throttle] [A] [B] [C] [xor] 99`
- steer, throttle: 128 = centre; steer < 128 left; throttle > 128 forward. Full range 0-255.
- A: the car's steering trim (128 = none; the stock app steps it by 2).
- B, C: unused by the stock app.
- xor = steer ^ throttle ^ A ^ B ^ C.
- The stock app's throttle bar shifts the resting throttle value (a throttle trim); its speed settings
  scale the stick (default top +/-38, highest +/-127).

**Video** (UDP from the car to the phone's port 1234): H.264, 1280x720, ~25 fps, keyframe about once a second.
Each frame is cut into pieces of up to 1440 bytes, each with a 32-byte little-endian header:
`0` magic `c6 6c a5 5a`, `4` frame size, `8` frame number, `20` piece count, `22` piece index, `24` offset in frame,
`28` piece length. Joined in order, a frame is plain Annex-B H.264.
