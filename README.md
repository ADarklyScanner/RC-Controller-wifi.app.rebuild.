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
  "Car disconnected" notice, PlayStation controller support
- Local commands for other apps on the phone: `GET http://127.0.0.1:8765/drive?t=0.5&s=0&ms=1000`, `/stop`, `/status`

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
