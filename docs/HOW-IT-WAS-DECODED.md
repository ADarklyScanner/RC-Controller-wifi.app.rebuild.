# How the car was decoded, and how to adapt this to your own toy

This controller was built by watching what the stock phone app sends to the car, working out
each byte, and checking the guesses on the real car. Nothing was taken from the stock app's code.
Everything below is what was observed on one car, in October 2026.

## Which toy this is for

| What | Seen on ours |
|---|---|
| Box | "TECH FPV CAR", ages 8+, orange off-roader with a camera on the roof (sold as a WLtoys 1/64 mini FPV car) |
| Camera module | Small black box with a wire aerial, labelled **"FPV CAR HD720"** |
| Wi-Fi it makes | **`WL_FPV_CAR_xxxxxxxx`** (8 digits), open, no password even though the box mentions one |
| Car's address | **172.16.11.1**; the phone gets 172.16.11.2 |
| Stock app | **WL Tech FPV CAR** (Google Play, `com.lg.wltechfpvcar`) |
| Video | 1280x720 H.264, about 25 frames a second |
| Battery | about 5 minutes of driving |

**Your toy probably works with this unchanged if** its camera says FPV CAR HD720, its Wi-Fi is named
`WL_FPV_CAR_...`, it uses the WL Tech FPV CAR app, and the car is at 172.16.11.1.
Other toys built on the same camera module (sold under other names) may be the same inside.

## Tools used (all free, no root)

- **PCAPdroid** (Play Store or F-Droid): records what one app sends and receives. Set *Dump mode* to
  *PCAP file*, pick the target app, start, use the app, stop, export the `.pcap`.
- **Termux** with Python, for the probe and test scripts in `termux/fpv_car.py`.
- A computer or any Python to read the `.pcap` files (the parsing here was a few lines of Python with
  `struct`; Wireshark works too).

## Step by step

1. **Find the network.** Connect the phone to the car's Wi-Fi and look at the phone's address in the
   Wi-Fi details. The car is almost always the `.1` of that range.
2. **First capture, summary only.** PCAPdroid's connection list showed the app talking UDP to two ports:
   **23459** (3 packets out, 3 back when the app opened, 1 when it closed) and **23458** (about 20
   packets a second, all the same size, nothing back). So 23459 is a start/stop "hello", 23458 is control.
3. **Second capture, full packets, slow deliberate moves.** Forward, back, left, right, stop, with
   pauses, then faster. Lining the bytes up against the moves showed:
   - every control packet is 16 bytes and starts `ca 47 d5 00 00 00 00 00 66` and ends `99`;
   - byte 9 follows the steering, byte 10 the throttle, both resting at 128;
   - byte 14 changes whenever 9 or 10 do: it is the XOR of bytes 9 to 13.
   A script that sent the same bytes drove the car the first time.
4. **The video was not in the capture**, even while it was playing. PCAPdroid only sees connections the
   app opens; the camera sends its video to the phone on its own. The clue was in the hello: it ends in
   `d2 04`, which is 1234 read little-endian. A probe that sent the hello and listened on port 1234 (the
   `probe` command in the Termux script) received about 300 KB a second, which is the video.
5. **Taking the video apart.** Every packet starts with `c6 6c a5 5a`. The rest of the 32-byte header
   gave itself away by counting: one field went 0, 1440, 2880... (offset in the frame), one said 1440
   (piece length), one stayed the same over a burst (frame size), one went up by one per burst (frame
   number). Joining the pieces in offset order gave frames starting `00 00 00 01`, plain H.264.
   ffmpeg decoded them to pictures straight away.
6. **The three unused bytes (11 to 13).** The stock app never changed them in normal driving. A test
   (*Settings > Tests*) stepped each one through values with the car standing still. Byte 11 moved the
   steering a little at a time: it is the car's own steering trim. Byte 12 made the motor hum on one value
   and was left alone. Byte 13 did nothing visible.
7. **The stock app's other controls.** A capture while tapping each control showed which send anything.
   Steering trim changes byte 11 in steps of 2. The throttle bar shifts the throttle's resting value
   (a throttle trim; high enough and the car creeps). The speed settings only scale the stick
   (default top +/-38, highest +/-127). The other buttons send nothing; they are settings inside the app.
8. **What the car sends back:** only the two short replies to the hello. No battery level, no signal.

## The protocol

See the README for the byte-by-byte version. In short:

- Hello, to **UDP 23459**, every few seconds: `a88a210006000000010000000000` and `a88a200008000000010002000000d204`.
- Drive, to **UDP 23458**, every 50 ms: `ca 47 d5 00 00 00 00 00 66 [steer] [throttle] [trim] 00 00 [xor] 99`.
- Video, from the car to **UDP 1234** on the phone: 32-byte header + up to 1440 bytes of H.264.

## Adapting it to a different toy

1. **Check the basics** with the probe: `python fpv_car.py probe` (Termux, phone on the toy's Wi-Fi,
   stock app closed). It sends the hello, listens for video, and writes a report to Downloads. If it sees
   video on port 1234 with `c66ca55a` headers, the video side is the same as ours.
2. **Capture the stock app** with PCAPdroid as in steps 2 and 3. Compare the control packet with ours:
   - Different address or ports: change `CAR_IP`, `CTRL_PORT`, `HELLO_PORT` (top of `termux/fpv_car.py`,
     and in `CarLink.kt` / `VideoLink.kt` for the app).
   - Different packet layout: change `packet()` in both places. Keep the 50 ms rate unless the stock app
     uses another.
   - Different hello: change `HELLO`. If the hello names another video port, change `VIDEO_PORT`.
3. **Video with a different wrapper:** look for a repeating start to every packet and fields that count
   up as described in step 5, then change the header reading in `Video._recv` (Termux) and
   `VideoLink.receive` (app). If the frames turn out to be JPEG (start `ff d8`) instead of H.264, the
   decoder part changes too.
4. **Test with the wheels off the ground** the first time, and keep the Stop button in reach.
5. The app rebuilds itself on every push to `main` (GitHub Actions) and publishes the APK as the latest
   release, so a fork can build its own version without installing Android tools.

## Safety and legal

Reading and re-creating the messages your own toy uses, so your own app can talk to it, is generally
fine; check your local rules if you plan to sell something. Don't use another company's brand name or
logo as your app's name. The signing key in `app/` is a plain build key for sideloading, not a secret;
a store release should use its own key.
