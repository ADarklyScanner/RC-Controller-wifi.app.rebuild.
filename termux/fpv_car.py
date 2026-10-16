#!/usr/bin/env python3
"""
fpv_car.py - drive the WL Tech FPV CAR (HD720 camera module) from Termux.

Protocol (decoded from PCAPdroid captures of the stock app, Oct 2026):
  Car IP 172.16.11.1, phone must be on the WL_FPV_CAR_xxxx Wi-Fi.
  Port 23459  hello/start:  a88a2100 06000000 01000000 0000
                            a88a2000 08000000 01000200 0000d204
  Port 23458  control, 16 bytes, sent every 50 ms (20/sec):
     ca 47 d5 00 00 00 00 00 66 [steer] [throttle] 80 00 00 [xor] 99
     steer/throttle: 0x80 = centre. throttle > 0x80 forward, < 0x80 reverse.
                     steer < 0x80 left, > 0x80 right.
     xor = steer ^ throttle ^ 0x80 ^ 0x00 ^ 0x00
  Stock app, default settings: +/-38 (0x5a..0xa6). Its throttle bar is a throttle
  trim (shifts the resting value; above ~132 the car creeps) and its speed settings
  reach the full +/-127. Here: speeds 1-3 = +/-25/51/76, MAX = +/-127.
  Video: after the hello the camera sends H.264 (1280x720, ~25 fps) to UDP port 1234,
  split into 1440-byte pieces with a 32-byte header - see class Video.

Controller page: live camera, touch sliders, 3 speed / 3 turn gears, PlayStation
controller, record + photo buttons, circle-left/right buttons, settings (fit, zoom,
brightness, flip, control size/see-through, circle speed, steering trim).
Recordings go to Movies as .mp4, photos to Pictures as 720p .jpg (both need ffmpeg).

Use:
  python fpv_car.py test            # short forward/back/left/right wiggle
  python fpv_car.py keys            # latching: w/s speed 3 levels each way, a/d turn 3 levels, x straight, space stop
  python fpv_car.py serve           # controller page + local HTTP commands on 127.0.0.1:8765
      open http://127.0.0.1:8765 for the controller (touch sliders or PlayStation controller)
  python fpv_car.py probe           # looks for the camera feed, saves a report to Downloads
      GET /drive?t=0.5&s=-0.3&ms=1500    t,s in -1..1, ms = how long, then auto-stop
      GET /stop    GET /status    GET /record?on=1|0    GET /video (H.264 frame stream)
  From Python:  from fpv_car import Car; c=Car(); c.start(); c.drive(0.5,0,1.0)
"""
import socket, sys, threading, time

CAR_IP = "172.16.11.1"
CTRL_PORT = 23458
HELLO_PORT = 23459
HELLO = [bytes.fromhex("a88a210006000000010000000000"),
         bytes.fromhex("a88a200008000000010002000000d204")]
LIMIT = 76          # speed 3 (+/-76 of 127): twice the stock app's default +/-38
STEER_LIMIT = 127   # steering: full range, as the stock app sends at its 100% setting
OC_LIMIT = 127      # MAX: full range; the stock app's top speed setting sends the same (capture 2026-10-14)
RATE = 0.05         # 20 packets/sec, same as the app


EXTRA_DEFAULT = (0x80, 0x00, 0x00)   # bytes 11-13: the stock app never changes them


def packet(steer_byte, thr_byte, extra=EXTRA_DEFAULT):
    b11, b12, b13 = extra
    x = steer_byte ^ thr_byte ^ b11 ^ b12 ^ b13
    return bytes([0xca, 0x47, 0xd5, 0, 0, 0, 0, 0, 0x66,
                  steer_byte, thr_byte, b11, b12, b13, x, 0x99])


def to_byte(v, limit):
    v = max(-1.0, min(1.0, float(v)))
    return 0x80 + int(round(v * limit))


class Car:
    def __init__(self, ip=CAR_IP, limit=LIMIT):
        self.ip, self.limit = ip, limit
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.settimeout(0.5)
        self.steer = self.thr = 0.0
        self.oc = False             # overclock: throttle uses OC_LIMIT instead of the app's limit
        self.trim = 0               # the car's own steering trim (byte 11 = 128 + trim)
        self.boost = 0              # extra lock: trim pushed this much further at full turn
        self.extra = EXTRA_DEFAULT  # test values for the unknown bytes 11-13
        self.extra_until = 0.0      # they go back to the defaults on their own after this
        self.until = 0.0            # auto-stop time; 0 = hold until changed
        self.lock = threading.Lock()
        self.running = False
        self.quiet = None           # serve: a function that says nobody is using the car from here

    def hello(self):
        ok = False
        for p in HELLO:
            self.sock.sendto(p, (self.ip, HELLO_PORT))
            try:
                self.sock.recvfrom(64); ok = True
            except OSError:
                pass
        return ok

    def start(self):
        alive = self.hello()
        self.running = True
        threading.Thread(target=self._loop, daemon=True).start()
        return alive

    def _loop(self):
        while self.running:
            with self.lock:
                if self.until and time.time() > self.until:
                    self.steer = self.thr = 0.0; self.until = 0.0; self.oc = False
                if self.extra_until and time.time() > self.extra_until:
                    self.extra_until = 0.0
                if not self.extra_until:    # extra lock: at full turn, lean the trim the same way
                    side = 1 if self.steer >= 0.95 else -1 if self.steer <= -0.95 else 0
                    self.extra = self._base(side)
                pkt = packet(to_byte(self.steer, STEER_LIMIT),
                             to_byte(self.thr, OC_LIMIT if self.oc else self.limit), self.extra)
                idle = not self.thr and not self.steer
            if idle and self.quiet and self.quiet():
                # no page open and standing still: say nothing, so the app or Nessari can drive the car
                time.sleep(RATE); continue
            try:
                self.sock.sendto(pkt, (self.ip, CTRL_PORT))
            except OSError:
                pass
            time.sleep(RATE)

    def set(self, throttle, steer, seconds=None, oc=False):
        """throttle/steer -1..1. seconds=None holds until changed. oc=True: overclocked throttle."""
        with self.lock:
            self.thr, self.steer, self.oc = throttle, steer, oc
            self.until = time.time() + seconds if seconds else 0.0

    def _base(self, side=0):
        return (max(0, min(255, 0x80 + self.trim + side * self.boost)), 0x00, 0x00)

    def set_boost(self, boost):
        with self.lock: self.boost = max(0, min(48, int(boost)))

    def set_trim(self, trim):
        """Slot A is the car's own steering trim."""
        with self.lock:
            self.trim = max(-60, min(60, int(trim)))
            if not self.extra_until: self.extra = self._base()

    def set_extra(self, slot, value, seconds=3.0):
        """Test one byte (slot 0-2 = bytes 11-13). Reverts after `seconds` unless
        set again, so a closed page never leaves a test value running."""
        with self.lock:
            e = list(self._base()); e[slot] = max(0, min(255, int(value)))
            self.extra = tuple(e); self.extra_until = time.time() + seconds

    def clear_extra(self):
        with self.lock: self.extra = self._base(); self.extra_until = 0.0

    def drive(self, throttle, steer=0.0, seconds=1.0):
        """Blocking: drive for `seconds`, then stop."""
        self.set(throttle, steer, seconds)
        time.sleep(seconds + RATE * 2)

    def stop(self):
        self.set(0, 0)

    def close(self):
        self.stop(); time.sleep(0.2); self.running = False
        self.sock.sendto(HELLO[0], (self.ip, HELLO_PORT))   # app sends this on exit


class Video:
    """Receives the camera stream.

    After the hello, the camera sends UDP to the phone's port 1234 (the d204 in
    the hello = 1234). Each packet: 32-byte header + up to 1440 bytes of H.264.
      0  c6 6c a5 5a          magic
      4  u32 frame size       total bytes of this frame
      8  u32 frame number     (+ 4 more bytes, together they identify the frame)
      20 u16 piece count      22 u16 piece index
      24 u32 offset in frame  28 u32 piece length
    A finished frame is plain Annex-B H.264, 1280x720 ~25 fps, keyframe ~1/sec.
    """
    MAGIC = b"\xc6\x6c\xa5\x5a"

    def __init__(self, ip=CAR_IP, port=1234):
        import os
        self.ip, self.port = ip, port
        self.subs = []                  # one queue per open video page
        self.sock = None
        self.quiet = None               # serve: a function that says nobody is using the car from here
        self.lock = threading.Lock()
        self.last_frame = 0.0
        self.rec_file = self.rec_path = None
        self.rec_started = 0.0
        self.rec_waiting_key = False
        self.rec_first = None
        self.fps = 25
        self.gop = []                   # frames since the last keyframe, for photos
        p = os.path.expanduser("~/storage/pictures")
        self.pic_dir = p if os.path.isdir(p) else os.path.expanduser("~")
        d = os.path.expanduser("~/storage/movies")
        self.rec_dir = d if os.path.isdir(d) else os.path.expanduser("~")

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()
        threading.Thread(target=self._keepalive, daemon=True).start()

    def _idle(self):
        return bool(self.quiet and self.quiet() and not self.rec_file)

    def _run(self):
        """Holds the camera's port only while the controller page is open. Only one program on the
        phone can have it; if the FPV Car app or Nessari has it, wait until they let go."""
        told = False
        while True:
            if self._idle():
                time.sleep(0.5); continue
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)
                s.bind(("0.0.0.0", self.port))
            except OSError:
                s.close()
                if not told:
                    told = True
                    print("camera: port 1234 is busy (the FPV Car app or Nessari has the picture). "
                          "Close the app (swipe it away) or Nessari's drive screen; the picture comes here by itself.")
                time.sleep(2); continue
            if told: print("camera: got the picture")
            told = False
            s.settimeout(1.0); self.sock = s
            with self.lock:
                for q in self.subs: q.need_key = True
            try: self._recv(s)
            finally:
                self.sock = None; s.close()

    def _keepalive(self):
        # the app repeats its hello every few seconds; do the same so the stream keeps coming
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try: s.bind(("0.0.0.0", HELLO_PORT))
        except OSError: pass
        s.settimeout(0.3)
        while True:
            for p in HELLO if not self._idle() else ():
                try: s.sendto(p, (self.ip, HELLO_PORT)); s.recvfrom(64)
                except OSError: pass
            time.sleep(3)

    @staticmethod
    def is_key(buf):
        i = 0
        while True:
            i = buf.find(b"\x00\x00\x00\x01", i)
            if i < 0 or i + 4 >= len(buf): return False
            if buf[i + 4] & 31 in (5, 7): return True
            i += 4

    def _recv(self, sock):
        import struct
        frames, newest = {}, 0
        need_key = True                # after any lost frame, wait for the next keyframe
        while not self._idle():
            try: data = sock.recv(2048)
            except socket.timeout: continue
            except OSError: return
            if len(data) < 32 or data[:4] != self.MAGIC: continue
            size, fno, _ts, _z, count, _idx, off, ln = struct.unpack("<IIIIHHII", data[4:32])
            f = frames.setdefault(fno, [size, count, {}])
            f[2][off] = data[32:32 + ln]
            if fno + 100 < newest:            # camera restarted its counter
                frames.clear(); newest = fno; need_key = True
                f = frames.setdefault(fno, [size, count, {}]); f[2][off] = data[32:32 + ln]
            if fno > newest:
                for old in [k for k in frames if k < fno - 2]:
                    del frames[old]; need_key = True     # never completed = lost
                newest = fno
            if len(f[2]) == f[1]:
                buf = b"".join(f[2][o] for o in sorted(f[2])); del frames[fno]
                if len(buf) != size: need_key = True; continue
                key = self.is_key(buf)
                if need_key and not key: continue
                need_key = False
                self._publish(buf, key)

    def _publish(self, buf, key):
        self.last_frame = time.time()
        with self.lock:
            if key: self.gop = [buf]
            elif self.gop and len(self.gop) < 400: self.gop.append(buf)
            for q in list(self.subs):
                if q.qsize() > 6:                     # page fell behind ~1/4 s: skip to the next keyframe
                    with q.mutex: q.queue.clear()
                    q.put((b"", "skip")); q.need_key = True
                if q.need_key and not key: continue   # every viewer starts on a keyframe
                q.need_key = False
                q.put((buf, key))
            if self.rec_file:
                if self.rec_waiting_key and not key: return
                if self.rec_waiting_key: self.rec_first = time.time()
                self.rec_waiting_key = False
                self.rec_file.write(buf)

    def subscribe(self):
        import queue
        q = queue.Queue(); q.need_key = True
        with self.lock: self.subs.append(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            if q in self.subs: self.subs.remove(q)

    @property
    def live(self):
        return time.time() - self.last_frame < 2

    # ---- date and time on photos and videos (settings > "Date & time stamp") ----
    @staticmethod
    def _font_file():
        """Optional custom font for the stamp: put a .ttf at ~/.fpv_car/font-700.ttf."""
        import os
        path = os.path.expanduser("~/.fpv_car/font-700.ttf")
        return path if os.path.exists(path) else None

    def _stamp_filter(self, base_epoch, moving):
        """drawtext for the bottom-right corner. base_epoch is already shifted to the
        phone's local time (the page sends its UTC offset), so gmtime prints local time."""
        f = self._font_file()
        font = ("fontfile='" + f.replace("\\", "/").replace(":", "\\:") + "':") if f else ""
        if moving:   # clock that runs with the video
            text = "%{pts\\:gmtime\\:" + str(int(base_epoch)) + "\\:%Y-%m-%d %H\\\\\\:%M\\\\\\:%S}"
        else:
            text = time.strftime("%Y-%m-%d %H\\\\\\:%M\\\\\\:%S", time.gmtime(base_epoch))
        return (f"drawtext={font}text='{text}':x=w-tw-24:y=h-th-20:fontsize=30:"
                "fontcolor=white:box=1:boxcolor=0x16011e@0.55:boxborderw=8")

    def snapshot(self, flip=False, stamp=False, tz_min=0):
        """Full-quality 720p JPEG of the newest frame, saved to Pictures. Needs ffmpeg."""
        import os, shutil, subprocess
        if not shutil.which("ffmpeg"): return None
        with self.lock: data = b"".join(self.gop)
        if not data: return None
        stem = os.path.join(self.pic_dir, time.strftime("car_%Y%m%d_%H%M%S"))
        path, k = stem + ".jpg", 2
        while os.path.exists(path):                 # two photos in the same second
            path = f"{stem}_{k}.jpg"; k += 1
        filters = ["hflip,vflip"] if flip else []
        if stamp: filters.append(self._stamp_filter(time.time() + tz_min * 60, False))
        vf = ["-vf", ",".join(filters)] if filters else []
        r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "h264", "-i", "pipe:0"] + vf +
                           ["-q:v", "2", "-update", "1", path], input=data)
        if r.returncode != 0 and stamp:          # drawtext missing on this ffmpeg: save it plain
            return self.snapshot(flip, False, tz_min)
        return path if r.returncode == 0 and os.path.exists(path) else None

    def record(self, on, stamp=False, tz_min=0):
        """Start/stop. On stop the raw stream becomes an .mp4 (no re-encode), or, with
        stamp, a re-encoded .mp4 with the running date and time. Stamping runs in the
        background and the file appears in the gallery when it is done."""
        import os
        with self.lock:
            if on and not self.rec_file:
                name = time.strftime("car_%Y%m%d_%H%M%S")
                self.rec_path = os.path.join(self.rec_dir, name + ".h264")
                self.rec_file = open(self.rec_path, "wb")
                self.rec_waiting_key = True; self.rec_started = time.time(); self.rec_first = None
                return self.rec_path
            if not on and self.rec_file:
                self.rec_file.close(); self.rec_file = None
                src = self.rec_path
            else:
                return self.rec_path
        start = self.rec_first or self.rec_started
        mp4 = src[:-5] + ".mp4"
        if stamp:
            threading.Thread(target=self._finish, args=(src, mp4, start, True, tz_min), daemon=True).start()
            return mp4
        self._finish(src, mp4, start, False, tz_min)
        return self.rec_path

    def _finish(self, src, mp4, start, stamp, tz_min):
        import os, shutil, subprocess
        if not shutil.which("ffmpeg"): return
        made = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start))
        part = mp4[:-4] + ".part.mp4"            # not shown in the gallery until finished
        base = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(self.fps), "-i", src]
        meta = ["-metadata", "creation_time=" + made, "-movflags", "+faststart"]
        ok = False
        if stamp:
            vf = self._stamp_filter(start + tz_min * 60, True)
            ok = subprocess.run(base + ["-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
                                        "-pix_fmt", "yuv420p"] + meta + [part]).returncode == 0
        if not ok:                                # plain copy (also the fallback if stamping fails)
            ok = subprocess.run(base + ["-c", "copy"] + meta + [part]).returncode == 0
        if ok:
            os.replace(part, mp4); os.remove(src)
            if self.rec_path == src: self.rec_path = mp4


def cmd_test(c):
    for name, t, s in [("forward", .5, 0), ("back", -.5, 0), ("left", .4, -1), ("right", .4, 1)]:
        print(name); c.drive(t, s, 1.0); time.sleep(0.5)
    print("done")


def cmd_keys(c):
    """Latching controls: the car keeps doing what you set until you change it.
    Speed has 3 levels each way (-3..+3), steering has 3 sharpnesses each way.
    w/s step speed up/down (through 0 into reverse), a/d step steering,
    x = straighten wheels, space = full stop, q = quit."""
    import termios, tty
    fd = sys.stdin.fileno(); old = termios.tcgetattr(fd)
    print("w/s speed (3 forward, 3 reverse), a/d turn (3 each way), x straighten, space stop, q quit")
    t = s = 0                        # levels -3..3
    lim = lambda v: max(-3, min(3, v))
    bar = lambda v: ("<" * -v).rjust(3) + "|" + (">" * v).ljust(3)
    try:
        tty.setcbreak(fd)
        while True:
            k = sys.stdin.read(1).lower()
            if k == "q": break
            if k == "w": t = lim(t + 1)
            elif k == "s": t = lim(t - 1)
            elif k == "a": s = lim(s - 1)
            elif k == "d": s = lim(s + 1)
            elif k == "x": s = 0
            elif k == " ": t = s = 0
            else: continue
            c.set(t / 3, s / 3)
            gear = f"F{t}" if t > 0 else f"R{-t}" if t < 0 else "N "
            print(f"\rspeed {gear}   turn {bar(s)}   ", end="", flush=True)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        print()


JOYSTICK_PAGE = """<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover">
<title>FPV Car</title><link rel=manifest href=/manifest.webmanifest><meta name=theme-color content="#16011e">
<meta name=mobile-web-app-capable content=yes><link rel=icon href=/icon-192.png><style>
@font-face{font-family:"Car Display";src:url(/font-400.ttf) format("truetype");font-weight:400;font-display:swap}@font-face{font-family:"Car Display";src:url(/font-700.ttf) format("truetype");font-weight:700;font-display:swap}
:root{--bg:#16011e;--bg1:#1d0128;--bg2:#280137;--bg3:#3a0a47;--line:#52125c;--soft:#3a0a47;--text:#ece6ee;--dim:#c0c0c0;--faint:#9a88a1;--knob:#3a0a47;--acc:#bf40bf;--acc-ink:#16011e;--gold:#ffd700;--red:#ff7b7b;--glass:rgba(22,1,30,.62);--display:"Car Display",system-ui,-apple-system,sans-serif;--sz:1;--op:1}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:var(--bg);color:var(--dim);font:13px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;touch-action:none;overflow:hidden;user-select:none;-webkit-user-select:none}
button{font:inherit;color:inherit;cursor:pointer}
#view{position:fixed;inset:0;overflow:hidden;background:radial-gradient(ellipse at center,#280137 0%,var(--bg) 72%)}
#view canvas,#view img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none;transform-origin:center;transition:transform .2s}
#view.fill canvas,#view.fill img{object-fit:cover}
#flash{position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;transition:opacity .35s}
#flash.on{opacity:.55;transition:none}
.ui{opacity:var(--op);transition:opacity .2s}
.ib{width:calc(40px*var(--sz));height:calc(40px*var(--sz));display:grid;place-items:center;border-radius:50%;border:1px solid var(--line);background:var(--glass);padding:0}
.ib svg{width:55%;height:55%;stroke:var(--text);fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.ib.on{background:var(--acc);border-color:var(--acc)}.ib.on svg{stroke:var(--acc-ink)}
#orbL{position:fixed;top:12px;left:16px}#ctime{position:fixed;top:calc(12px + 20px*var(--sz) - 10px);left:calc(16px + 40px*var(--sz) + 10px);display:none;align-items:center;gap:6px;font:600 13px var(--display);color:var(--text);font-variant-numeric:tabular-nums;text-shadow:0 1px 3px #000;transition:color .4s}#ctime.on{display:flex}#ctime i{width:7px;height:7px;border-radius:50%;background:#68e59c;box-shadow:0 0 6px #68e59c}#ctime.late{color:var(--gold)}#ctime.late i{background:var(--gold);box-shadow:0 0 6px var(--gold);animation:pulse 1.2s ease-in-out infinite}.info{color:var(--faint);font-size:12px;margin:2px 0 6px}
.tests{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:6px 0 4px}.tests button{padding:9px 0;border:1px solid var(--line);border-radius:8px;background:var(--bg2);color:var(--text);font:600 13px var(--display)}
#mdown,#mup{width:44px;justify-content:center;font-size:18px}#mhold.on{background:var(--acc);border-color:var(--acc);color:var(--acc-ink)}
.tests button.on{background:var(--acc);border-color:var(--acc);color:var(--acc-ink)}
#tpill{position:fixed;top:calc(64px*var(--sz));left:50%;transform:translateX(-50%);display:none;align-items:center;gap:10px;padding:8px 14px;border-radius:20px;background:rgba(40,1,55,.92);border:1px solid var(--acc);color:var(--text);font:600 14px var(--display);font-variant-numeric:tabular-nums;z-index:3}
#tpill.on{display:flex}#tpill i{width:8px;height:8px;border-radius:50%;background:var(--acc);animation:pulse 1s ease-in-out infinite}#orbR{position:fixed;top:12px;right:16px}
.ib.on .spin{animation:spin 2.4s linear infinite;transform-origin:center}
@keyframes spin{to{transform:rotate(360deg)}}
#gears{position:fixed;top:14px;left:50%;transform:translateX(-50%);width:max-content;max-width:calc(100vw - 130px);display:flex;gap:18px;align-items:center;flex-wrap:wrap;justify-content:center}.tools{display:flex;gap:8px}.tools .ib{width:calc(34px*var(--sz));height:calc(34px*var(--sz))}
.grp{display:flex;align-items:center;gap:5px}.grp span{margin-right:3px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);font-family:var(--display);text-shadow:0 1px 3px #000,0 0 8px #000}
.grp button{width:calc(34px*var(--sz));height:calc(34px*var(--sz));border-radius:50%;border:1px solid var(--line);background:var(--glass);color:var(--dim);font-size:14px;padding:0}
.grp button.oc{display:none;border-color:var(--gold);color:var(--gold);font-family:var(--display);font-size:12px}body.ocu .grp button.oc{display:inline-block}.grp button.oc.sel{background:var(--gold);border-color:var(--gold);color:#16011e;animation:ocp 1.4s ease-in-out infinite}@keyframes ocp{50%{box-shadow:0 0 0 6px rgba(255,215,0,.28)}}body.ocon #thr .knob.on,body.ocon #joy .knob.on{background:var(--gold);box-shadow:0 0 0 6px rgba(255,215,0,.22)}.warn{margin:2px 0 8px;color:var(--gold);font-size:12px;line-height:1.45}
.grp button.sel{background:var(--acc);border-color:var(--acc);color:var(--acc-ink);font-weight:700}
#side{position:fixed;right:16px;top:calc(64px*var(--sz));display:flex;flex-direction:column;gap:10px;align-items:center}
#photo,#rec{display:none}
#rec i{width:36%;height:36%;border-radius:50%;border:2px solid var(--red)}
#rec.on{background:var(--glass);border-color:var(--red)}#rec.on i{background:var(--red);animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
#rtime{position:fixed;right:calc(66px*var(--sz) + 8px);display:none;color:#fff;font-variant-numeric:tabular-nums;text-shadow:0 1px 3px #000}
#rtime.on{display:block}
#gp{display:none}#gp.on{display:grid}#gp svg{stroke:var(--acc)}
.slot{position:fixed;bottom:22px}#joy{display:none;width:calc(180px*var(--sz));height:calc(180px*var(--sz))}#joy.L{left:22px}#joy.R{right:22px}#joy .track{border-radius:50%}#joy .track::after{left:50%;top:20%;bottom:20%;width:1px}#joy .track::before{content:"";position:absolute;background:var(--line);top:50%;left:20%;right:20%;height:1px}body.joy #thr,body.joy #str{display:none}body.joy #joy{display:block}body.joyR #side{right:auto;left:16px;top:calc(64px*var(--sz))}
#thr{left:22px;width:calc(84px*var(--sz));height:min(calc(260px*var(--sz)),calc(100vh - 96px))}
#str{right:22px;width:min(calc(300px*var(--sz)),40vw);height:calc(84px*var(--sz))}
.track{position:absolute;inset:0;border-radius:999px;border:1px solid var(--line);background:rgba(22,1,30,.45)}
.track::after{content:"";position:absolute;background:var(--line)}
#thr .track::after{left:20%;right:20%;top:50%;height:1px}#str .track::after{top:20%;bottom:20%;left:50%;width:1px}
.knob{position:absolute;width:calc(64px*var(--sz));height:calc(64px*var(--sz));border-radius:50%;background:var(--knob);left:50%;top:50%;translate:-50% -50%;transition:background .15s,box-shadow .15s}
.knob.on{background:var(--acc);box-shadow:0 0 0 6px rgba(191,64,191,.22)}
#stop{position:fixed;bottom:34px;left:50%;transform:translateX(-50%);padding:calc(12px*var(--sz)) calc(26px*var(--sz));border:0;border-radius:24px;background:var(--bg2);color:var(--text);font-size:14px;font-family:var(--display);border:1px solid var(--line)}
#saved{position:fixed;bottom:96px;left:50%;transform:translateX(-50%);padding:8px 12px;border-radius:10px;background:rgba(40,1,55,.92);color:var(--text);border:1px solid var(--line);font-size:12px;opacity:0;transition:opacity .4s;pointer-events:none;white-space:nowrap}#saved.on{opacity:1}
#sheet{position:fixed;top:0;right:0;bottom:0;width:min(300px,86vw);background:var(--bg1);border-left:1px solid var(--line);padding:18px 18px 24px;overflow-y:auto;touch-action:pan-y;transform:translateX(100%);transition:transform .25s ease;z-index:5}
#sheet.on{transform:none}
.gpf{outline:2px solid var(--acc);outline-offset:2px;border-radius:8px}
#scrim{position:fixed;inset:0;z-index:4;display:none}#scrim.on{display:block}
#sheet h3{margin:0 0 14px;font-size:14px;font-weight:700;color:var(--text);font-family:var(--display);letter-spacing:.02em}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:40px}
.row label{color:var(--text);font-size:13px;white-space:nowrap}.row output{color:var(--faint);font-variant-numeric:tabular-nums;font-size:12px;min-width:34px;text-align:right}
.row input[type=range]{flex:1;accent-color:var(--acc);min-width:0}
.seg{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}.seg button{border:0;background:none;padding:6px 12px;color:var(--dim)}.seg button.sel{background:var(--acc);color:var(--acc-ink);font-weight:600}
.sep{height:1px;background:var(--line);margin:10px 0}
#reset{margin-top:14px;width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:none;color:var(--dim)}
@media (orientation:portrait){#gears{top:calc(64px*var(--sz))}#side{top:calc(120px*var(--sz))}#str{width:calc(100vw - 150px)}#stop{bottom:calc(140px*var(--sz));left:auto;right:22px;transform:none}}
#gal{position:fixed;inset:0;background:var(--bg);z-index:6;display:none;flex-direction:column;touch-action:pan-y}#gal.on{display:flex}.bar{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;gap:10px}.bar h2{margin:0;font-size:17px;font-weight:700;color:var(--text);font-family:var(--display)}#grid{flex:1;overflow-y:auto;padding:0 16px 20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;align-content:start}.cell{position:relative;aspect-ratio:16/9;border-radius:8px;overflow:hidden;background:var(--bg2);border:0;padding:0}.cell img,.cell video{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}.cell .dur{position:absolute;right:6px;bottom:6px;display:flex;align-items:center;gap:4px;padding:2px 6px;border-radius:6px;background:rgba(0,0,0,.65);color:#fff;font-size:11px;font-variant-numeric:tabular-nums}.cell .dur::before{content:"";border-left:7px solid #fff;border-top:4px solid transparent;border-bottom:4px solid transparent}#empty{color:var(--faint);grid-column:1/-1;text-align:center;padding:60px 0}#viewer{position:fixed;inset:0;background:#000;z-index:7;display:none;flex-direction:column}#viewer.on{display:flex}#vbody{flex:1;min-height:0;display:grid;place-items:center}#vbody img,#vbody video{max-width:100%;max-height:100%;object-fit:contain}.act{display:flex;gap:8px}.pill{height:36px;padding:0 14px;border-radius:18px;border:1px solid var(--line);background:var(--bg2);color:var(--text);display:flex;align-items:center;gap:6px}.pill.warn{border-color:var(--red);color:#16011e;background:var(--red)}
#padt{position:fixed;inset:0;background:var(--bg);z-index:8;display:none;flex-direction:column;touch-action:pan-y}#padt.on{display:flex}
#ptbody{flex:1;overflow-y:auto;padding:0 16px 20px;display:flex;flex-wrap:wrap;gap:16px 24px;align-content:start}
.ptcol{display:flex;flex-direction:column;gap:8px;min-width:260px;flex:1}.ptsticks{display:flex;gap:14px;align-items:flex-end}
.ptsticks div{text-align:center;color:var(--faint);font-size:11px}.ptsticks canvas{display:block;width:120px;height:120px}
.ptt{display:grid;grid-template-columns:28px 1fr 40px;gap:8px;align-items:center;font-size:12px;color:var(--dim)}.ptt i{position:relative;height:14px;border-radius:7px;background:var(--bg2);border:1px solid var(--line);overflow:hidden}
.ptt i b,.ptt i s{position:absolute;left:0;top:0;bottom:0}.ptt i b{background:var(--line)}.ptt i s{background:var(--acc)}.ptt i u{position:absolute;top:0;bottom:0;width:2px;background:var(--gold)}
#ptbtns{display:grid;grid-template-columns:repeat(auto-fill,minmax(54px,1fr));gap:6px}#ptbtns button{padding:8px 0;border:1px solid var(--line);border-radius:8px;background:var(--bg2);color:var(--dim);font-size:12px}
#ptbtns button.on{background:var(--acc);border-color:var(--acc);color:var(--acc-ink)}#ptbtns button.ign{text-decoration:line-through;border-color:var(--red);color:var(--red);background:none}#ptbtns button.ign.on{background:rgba(255,123,123,.25)}
#ptcal{margin-top:4px;width:100%;padding:10px;border:1px solid var(--acc);border-radius:8px;background:none;color:var(--text)}
#lost{position:fixed;inset:0;display:none;place-items:center;pointer-events:none;z-index:2}#lost.on{display:grid}
#lost .card{pointer-events:auto;display:flex;align-items:center;gap:14px;padding:16px 20px;border-radius:16px;background:rgba(22,1,30,.88);border:1px solid var(--line);max-width:min(420px,80vw)}
#lost b{display:block;font:700 16px var(--display);color:var(--text);margin-bottom:3px}#lost span{color:var(--dim);font-size:13px;line-height:1.45}
#lost .spin{flex:none;width:26px;height:26px;border-radius:50%;border:3px solid var(--line);border-top-color:var(--acc);animation:spin 1s linear infinite}
body.down #view canvas,body.down #view img{filter:grayscale(1) brightness(.45)!important}
html.app,html.app body{background:transparent}html.app #view{background:transparent}html.app body.down #view{background:rgba(10,0,14,.62)}
#off{position:fixed;inset:0;display:none;place-items:center;text-align:center;padding:24px;background:var(--bg);color:var(--dim);font-size:15px;line-height:1.6;z-index:9}#off code{color:var(--text);background:var(--bg2);padding:2px 8px;border-radius:6px}#off.on{display:grid}
</style></head><body>
<div id=view><canvas id=cam></canvas><img id=mj alt=""></div><div id=flash></div>
<div class=ui>
<button class=ib id=orbL title="Circle left"><svg viewBox="0 0 24 24" style="transform:scaleX(-1)"><g class=spin><path d="M18.5 8.5A7.5 7.5 0 1 0 19.5 13"/><path d="M19 4v4.5h-4.5"/></g></svg></button>
<div id=ctime title="Connected"><i></i><span>0:00</span></div>
<button class=ib id=orbR title="Circle right"><svg viewBox="0 0 24 24"><g class=spin><path d="M18.5 8.5A7.5 7.5 0 1 0 19.5 13"/><path d="M19 4v4.5h-4.5"/></g></svg></button>
<div id=gears>
 <div class=grp id=sp><span>Speed</span><button>1</button><button>2</button><button>3</button><button class=oc>MAX</button></div>
 <div class=grp id=tn><span>Turn</span><button>1</button><button>2</button><button>3</button></div>
 <div class=tools>
  <button class=ib id=galb title="Photos &amp; videos"><svg viewBox="0 0 24 24"><rect x=4 y=4 width=7 height=7 rx=1.5 /><rect x=13 y=4 width=7 height=7 rx=1.5 /><rect x=4 y=13 width=7 height=7 rx=1.5 /><rect x=13 y=13 width=7 height=7 rx=1.5 /></svg></button>
  <button class=ib id=cfg title="Settings"><svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx=16 cy=7 r=2 /><circle cx=10 cy=17 r=2 /></svg></button>
 </div>
</div>
<div id=side>
 <button class=ib id=photo title="Photo"><svg viewBox="0 0 24 24"><path d="M4 8.5h3l1.6-2.2h6.8L17 8.5h3v10H4z"/><circle cx=12 cy=13.2 r=3.3 /></svg></button>
 <button class=ib id=rec title="Record"><i></i></button>
 <div class=ib id=gp title="Controller connected"><svg viewBox="0 0 24 24"><path d="M6 9h12a4 4 0 0 1 3.9 4.9l-.8 3.3a2 2 0 0 1-3.4.9L15.5 16h-7l-2.2 2.1a2 2 0 0 1-3.4-.9l-.8-3.3A4 4 0 0 1 6 9z"/></svg></div>
</div>
<div id=rtime>0:00</div>
<div class=slot id=thr><div class=track></div><div class=knob></div></div>
<div class=slot id=str><div class=track></div><div class=knob></div></div>
<div class=slot id=joy><div class=track></div><div class=knob></div></div>
<button id=stop>Stop</button>
</div>
<div id=saved></div><div id=lost><div class=card><div class=spin></div><div><b id=lostT>Waiting for the car</b><span id=lostS>Turn the car on and connect this phone to its Wi-Fi. The picture comes up by itself.</span></div></div></div><div id=tpill><i></i><span></span></div>
<div id=scrim></div>
<div id=sheet>
 <h3>Picture</h3>
 <div class=row><label>Fit</label><div class=seg id=fit><button data-v=contain>Whole</button><button data-v=fill>Fill screen</button></div></div>
 <div class=row><label>Zoom</label><input type=range id=zoom min=1 max=3 step=.1><output></output></div>
 <div class=row><label>Brightness</label><input type=range id=bright min=.6 max=1.8 step=.05><output></output></div>
 <div class=row><label>Date &amp; time stamp</label><div class=seg id=stamp><button data-v=0>Off</button><button data-v=1>On</button></div></div>
 <div class=row><label>Flip upside down</label><div class=seg id=flip><button data-v=0>Off</button><button data-v=1>On</button></div></div>
 <p class=info id=vpath></p>
 <div class=sep></div><h3>Controls</h3>
 <div class=row><label>Style</label><div class=seg id=style><button data-v=sliders>Two thumbs</button><button data-v=joyL>Stick L</button><button data-v=joyR>Stick R</button></div></div>
 <div class=row><label>Size</label><input type=range id=size min=.7 max=1.4 step=.05><output></output></div>
 <div class=row><label>See-through</label><input type=range id=opac min=.25 max=1 step=.05><output></output></div>
 <div class=sep></div><h3>Driving</h3>
 <div class=row><label>Circle speed</label><input type=range id=orbit min=.15 max=.8 step=.05><output></output></div>
 <div class=row><label>Less steering at speed</label><input type=range id=ssr min=0 max=.7 step=.05><output></output></div>
 <div class=row><label>Extra lock at full turn</label><input type=range id=boost min=0 max=48 step=4><output></output></div>
 <p class=info>Extra lock leans the car's own trim into a full turn for a tighter circle (the trick from the stock app). It eases back after the turn, so set it to 0 if the car drifts for a moment afterwards.</p>
 <div class=row><label>Full speed</label><div class=seg id=ocu><button data-v=0>Off</button><button data-v=1>Unlock</button></div></div>
 <p class=warn>Adds a MAX speed: the car's full range, which the stock app only reaches with its speed turned all the way up (speed 3 here is already twice the stock app's normal top speed). Drains the battery faster. Resets to speed 3 every time the app opens.</p>
 <div class=row><label>Steering trim</label><input type=range id=trim min=-40 max=40 step=2><output></output></div>
 <div class=sep></div><h3>Tests</h3>
 <p class=info>Tries the three slots in the drive message the stock app never changes, one value at a time, with the car standing still. Wheels off the ground, then watch the car and the camera and note the value when anything happens. Stop ends a test.</p>
 <div class=tests><button data-slot=0>Slot A</button><button data-slot=1>Slot B</button><button data-slot=2>Slot C</button></div>
 <p class=info>Found so far: Slot A is the car's steering trim (it is the Steering trim setting above). Slot B made the motor sound on one of its values.</p>
 <div class=row><label>Hold a value</label><div class=seg id=mslot><button data-v=1>B</button><button data-v=2>C</button><button data-v=0>A</button></div></div>
 <div class=row><button class=pill id=mdown>−</button><output id=mval style="flex:1;text-align:center;color:var(--text);font:700 18px var(--display)">1</output><button class=pill id=mup>+</button><button class=pill id=mhold>Hold</button></div>
 <div class=sep></div><h3>Controller</h3>
 <button class=pill id=ptb style="width:100%;justify-content:center;margin-bottom:8px">Test controller &amp; dead zones</button>
 <p class=info>Worn controller? It measures itself when it connects and whenever it sits untouched for a few seconds: stick drift is taken out, and a button or trigger that reads pressed with nobody touching it is ignored until it lets go. The dead zones set how far you push before anything happens.</p>
 <p class=info>PlayStation names (Xbox: A, B, X, Y, LB, RB, LT, RT, View, Menu). R2 forward, L2 reverse, left stick steers, hold ✕ to brake. D-pad: speed and turn gears. □ photo, △ record, L1 / R1 circle. ○ stops. Options: these settings (D-pad picks and changes a row, ✕ presses it). Share: photos and videos. Press the left stick: whole picture or fill screen. Press the right stick: zoom. The controller buzzes at 4:00 and if the car drops out.</p>
 <button id=reset>Reset to defaults</button>
</div>
<div id=gal><div class=bar><h2>Photos &amp; videos</h2><button class=ib id=galx title=Close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div><div id=grid></div></div>
<div id=viewer><div class=bar><button class=ib id=vback title=Back><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
 <div class=act><button class=pill id=vshare>Share</button><button class=pill id=vdel>Delete</button></div></div><div id=vbody></div></div>
<div id=padt><div class=bar><h2>Controller test</h2><button class=ib id=ptx title=Close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
<div id=ptbody>
 <div class=ptcol>
  <div class=ptsticks><div><canvas id=ptL width=120 height=120></canvas>Left stick</div><div><canvas id=ptR width=120 height=120></canvas>Right stick</div></div>
  <p class=info>Grey dot: what the stick says. Purple dot: what the car gets. The shaded circle is the dead zone; the purple dot stays in the middle until you push past it.</p>
  <div class=ptt><span>L2</span><i id=ptL2><b></b><s></s><u></u></i><output>0</output></div>
  <div class=ptt><span>R2</span><i id=ptR2><b></b><s></s><u></u></i><output>0</output></div>
  <p class=info>Grey bar: the trigger. Gold line: where it starts to count. Purple: what the car gets.</p>
 </div>
 <div class=ptcol>
  <div id=ptbtns></div>
  <p class=info>Lit: pressed now. Red and crossed out: ignored (it pressed itself, or you turned it off). Tap a button here to turn it off or on for good.</p>
  <div class=row><label>Stick dead zone</label><input type=range id=ptdzs min=0 max=.5 step=.01><output></output></div>
  <div class=row><label>Trigger dead zone</label><input type=range id=ptdzt min=0 max=.5 step=.01><output></output></div>
  <div class=row><label>Check itself when idle</label><div class=seg id=ptauto><button data-v=0>Off</button><button data-v=1>On</button></div></div>
  <button id=ptcal>Recalibrate now (hands off)</button>
  <p class=info id=ptinfo></p>
 </div>
</div></div>
<div id=off><div>Car server isn't running.<br>In Termux: <code>python fpv_car.py serve</code></div></div>
<script>
const $=q=>document.querySelector(q);
// inside the Android app (window.CarApp) video, photos, sharing and the controller are native
const APP=!!window.CarApp;if(APP)document.documentElement.classList.add('app');
// ---------- settings (remembered on this phone) ----------
const DEF={sg:2,tg:3,ocu:0,stamp:0,ssr:.4,boost:32,style:'sliders',fit:'contain',zoom:1,bright:1,flip:0,size:1,opac:1,orbit:.35,trim:0};
let cfg={...DEF};try{Object.assign(cfg,JSON.parse(localStorage.carcfg||'{}'))}catch(e){}
if(cfg.sg>3)cfg.sg=3;   // overclock never survives a restart
if(Math.abs(cfg.trim)<1)cfg.trim=0;   // the old software trim was a fraction
const save=()=>{try{localStorage.carcfg=JSON.stringify(cfg)}catch(e){}};
const fmt={zoom:v=>(+v).toFixed(1)+'×',bright:v=>Math.round(v*100)+'%',size:v=>Math.round(v*100)+'%',opac:v=>Math.round((1-v)*100)+'%',orbit:v=>Math.round(v*100)+'%',ssr:v=>Math.round(v*100)+'%',boost:v=>v?'+'+v:'Off',trim:v=>(v>0?'R ':v<0?'L ':'')+Math.abs(v)};
function apply(){const r=document.documentElement.style;r.setProperty('--sz',cfg.size);r.setProperty('--op',cfg.opac);
 $('#view').classList.toggle('fill',cfg.fit==='fill');
 const tf=`scale(${cfg.zoom}) rotate(${cfg.flip?180:0}deg)`,fl=`brightness(${cfg.bright}) contrast(${1+(cfg.bright-1)*.25})`;
 for(const el of [$('#cam'),$('#mj')]){el.style.transform=tf;el.style.filter=fl}
 if(APP)try{CarApp.view(cfg.fit,+cfg.zoom,+cfg.flip,+cfg.bright)}catch(e){}
 for(const id of ['zoom','bright','size','opac','orbit','trim','ssr','boost']){const i=$('#'+id);i.value=cfg[id];i.nextElementSibling.textContent=fmt[id](cfg[id])}
 if(!cfg.ocu&&cfg.sg>3)cfg.sg=3;document.body.classList.toggle('ocu',!!cfg.ocu);
 for(const id of ['fit','flip','style','ocu','stamp'])document.querySelectorAll('#'+id+' button').forEach(b=>b.classList.toggle('sel',b.dataset.v==String(cfg[id])));
 document.body.classList.toggle('joy',cfg.style!=='sliders');document.body.classList.toggle('joyR',cfg.style==='joyR');
 $('#joy').className='slot '+(cfg.style==='joyR'?'R':'L');
 drawChips()}
for(const id of ['zoom','bright','size','opac','orbit','trim','ssr','boost'])$('#'+id).oninput=e=>{cfg[id]=+e.target.value;apply();save();if(id==='trim'||id==='boost')sendTrim()};
const sendTrim=()=>{fetch('/trim?v='+cfg.trim).catch(()=>{});fetch('/boost?v='+cfg.boost).catch(()=>{})};   // the car's own trim (slot A) and extra lock
for(const id of ['fit','flip','style','ocu','stamp'])document.querySelectorAll('#'+id+' button').forEach(b=>b.onclick=()=>{cfg[id]=(id==='flip'||id==='ocu'||id==='stamp')?+b.dataset.v:b.dataset.v;apply();save()});
$('#reset').onclick=()=>{const g={sg:Math.min(cfg.sg,3),tg:cfg.tg};cfg={...DEF,...g};apply();save()};
const sheet=(on)=>{$('#sheet').classList.toggle('on',on);$('#scrim').classList.toggle('on',on)};
$('#cfg').onclick=()=>sheet(true);$('#scrim').onpointerdown=()=>sheet(false);

// ---------- gears ----------
function drawChips(){document.querySelectorAll('#sp button').forEach((b,i)=>b.classList.toggle('sel',i+1===cfg.sg));document.body.classList.toggle('ocon',cfg.sg===4);
 document.querySelectorAll('#tn button').forEach((b,i)=>b.classList.toggle('sel',i+1===cfg.tg))}
document.querySelectorAll('#sp button').forEach((b,i)=>b.onclick=()=>{cfg.sg=i+1;drawChips();save()});
document.querySelectorAll('#tn button').forEach((b,i)=>b.onclick=()=>{cfg.tg=i+1;drawChips();save()});

// ---------- circle buttons ----------
let orbit=0;
function setOrbit(d){orbit=orbit===d?0:d;$('#orbL').classList.toggle('on',orbit===-1);$('#orbR').classList.toggle('on',orbit===1)}
$('#orbL').onclick=()=>setOrbit(-1);$('#orbR').onclick=()=>setOrbit(1);

// ---------- touch sliders (spring back to centre; both thumbs at once) ----------
const touch={t:null,s:null};
function slider(id,axis){const el=$('#'+id),k=el.querySelector('.knob'),key=axis==='y'?'t':'s';
 const span=()=>((axis==='y'?el.clientHeight:el.clientWidth)-k.offsetWidth)/2;
 const set=v=>{k.style.transform=axis==='y'?`translateY(${-v*span()}px)`:`translateX(${v*span()}px)`};
 const read=e=>{const r=el.getBoundingClientRect(),c=axis==='y'?r.top+r.height/2:r.left+r.width/2;
  const v=axis==='y'?-(e.clientY-c)/span():(e.clientX-c)/span();return Math.max(-1,Math.min(1,v))};
 el.onpointerdown=e=>{el.setPointerCapture(e.pointerId);touch[key]=read(e);if(orbit)setOrbit(0)};
 el.onpointermove=e=>{if(touch[key]!==null)touch[key]=read(e)};
 el.onpointerup=el.onpointercancel=()=>{touch[key]=null};
 return{set,k}}
const T=slider('thr','y'),S=slider('str','x');
// one-thumb joystick (settings > Style)
const J=$('#joy'),JK=J.querySelector('.knob');
const jrad=()=>(J.clientWidth-JK.offsetWidth)/2;
function jread(e){const r=J.getBoundingClientRect();let x=(e.clientX-r.left-r.width/2)/jrad(),y=-(e.clientY-r.top-r.height/2)/jrad();
 const m=Math.hypot(x,y);if(m>1){x/=m;y/=m}touch.s=x;touch.t=y}
let jOn=false;
J.onpointerdown=e=>{J.setPointerCapture(e.pointerId);jOn=true;jread(e);if(orbit)setOrbit(0)};
J.onpointermove=e=>{if(jOn)jread(e)};
J.onpointerup=J.onpointercancel=()=>{jOn=false;touch.t=touch.s=null};
const Jset=(t,s)=>{JK.style.transform=`translate(${s*jrad()}px,${-t*jrad()}px)`;JK.classList.toggle('on',!!(t||s))};

// ---------- PlayStation / any gamepad ----------
// Driving: R2 forward, L2 reverse, left stick steer (right stick up/down also throttle), hold X to brake.
// D-pad up/down speed gear, left/right turn gear, Square photo, Triangle record, L1/R1 circle left/right.
// Circle stop (like the Stop button), Options settings, Share photos & videos, L3 whole / fill screen, R3 zoom.
// In settings: D-pad up/down picks a row, left/right changes it, X presses it, Circle or Options closes.
// In photos & videos: D-pad moves, X opens (plays / pauses a video), left/right next / previous,
// Square shares, Triangle deletes (twice to confirm), Circle goes back.
let prevBtn=[],braking=false,padWas=false,padWarned=false;const dz=v=>v;   // dead zones are in the calibration below

// ---------- calibration for worn controllers: drifting sticks, triggers that never rest at 0, buttons that press themselves ----------
// Each controller is measured at rest: stick and trigger drift is taken out, and anything that reads pressed with nobody
// touching it is ignored until it has let go for a moment. It runs when a controller connects, from Recalibrate, and by
// itself when the controller has sat untouched for 6 s (at most every 30 s). Dead zones: push past them before anything
// moves. Everything is remembered per controller on this phone.
const CALDEF={dzs:.15,dzt:.12,auto:1,rest:[0,0,0,0],trest:[0,0],stuck:[],off:[]};
let calAll={};try{calAll=JSON.parse(localStorage.carcal||'{}')}catch(e){}
let cal={...CALDEF},calId=null,calLast=null,calSteadyAt=0,calDoneAt=0;const calRel={};
const rawVal=(g,i)=>g.buttons[i]?+g.buttons[i].value||0:0;
function calFor(g){const id=g.id||'controller';if(calId!==id){calId=id;cal={...CALDEF,...(calAll[id]||{})};calDoneAt=0}return cal}
function calSave(){if(calId===null)return;calAll[calId]=cal;try{localStorage.carcal=JSON.stringify(calAll)}catch(e){}}
// full: on connect and Recalibrate (anything held counts). Otherwise (idle check) a fully pressed trigger is never
// taken for stuck, so holding R2 steady on a straight never switches the throttle off.
function calibrate(g,full){const c=calFor(g);
 c.rest=[0,1,2,3].map(i=>{const v=+(g.axes[i]||0);return Math.abs(v)<(full?.6:.35)?+v.toFixed(3):(c.rest[i]||0)});
 c.trest=[6,7].map((i,k)=>{const v=rawVal(g,i);return v<.9?+v.toFixed(3):(c.trest[k]||0)});
 const st=[];g.buttons.forEach((b,i)=>{const v=rawVal(g,i);if((i===6||i===7)?(full&&v>=.9):v>.5)st.push(i)});
 c.stuck=full?st:[...new Set([...c.stuck,...st])];calDoneAt=Date.now();calSave();ptNote()}
function calWatch(g){const now=Date.now(),snap=[...g.axes.slice(0,4).map(Number),...g.buttons.map((b,i)=>rawVal(g,i))];
 if(!calLast||snap.length!==calLast.length||snap.some((v,i)=>Math.abs(v-calLast[i])>.03)){calLast=snap;calSteadyAt=now;return}
 if(cal.auto&&!ptCount&&now-calSteadyAt>6000&&now-calDoneAt>30000)calibrate(g,false)}
function calApply(g){const c=calFor(g),now=Date.now();
 if(c.stuck.length){const keep=c.stuck.filter(i=>{if(rawVal(g,i)>.1){delete calRel[i];return true}
   if(!calRel[i])calRel[i]=now;return now-calRel[i]<1500});            // works again once it has let go for 1.5 s
  if(keep.length!==c.stuck.length){c.stuck=keep;calSave();ptNote()}}
 const ign=i=>c.stuck.includes(i)||c.off.includes(i);
 const axes=[0,1,2,3].map(i=>{const v=(+(g.axes[i]||0))-(c.rest[i]||0),a=Math.abs(v);return a<=c.dzs?0:Math.sign(v)*Math.min(1,(a-c.dzs)/(1-c.dzs))});
 const buttons=g.buttons.map((b,i)=>{if(ign(i))return{value:0,pressed:false};
  if(i===6||i===7){const d=Math.min(.9,(c.trest[i-6]||0)+c.dzt),v=rawVal(g,i),o=v<=d?0:Math.min(1,(v-d)/(1-d));return{value:o,pressed:o>.5}}
  return{value:rawVal(g,i),pressed:!!(b&&b.pressed)}});
 return{id:g.id,mapping:g.mapping,buttons,axes}}

// ---------- controller test screen ----------
const PTN=['✕','○','□','△','L1','R1','L2','R2','Share','Options','L3','R3','↑','↓','←','→','PS'];
let ptCount=0;
const ptOn=()=>$('#padt').classList.contains('on');
PTN.forEach((n,i)=>{const b=document.createElement('button');b.textContent=n;b.onclick=()=>{if(calId===null)return;
 cal.off=cal.off.includes(i)?cal.off.filter(x=>x!==i):[...cal.off,i];calSave()};$('#ptbtns').appendChild(b)});
function ptNote(){const el=$('#ptinfo');if(!el)return;
 if(calId===null){el.textContent='No controller yet. Connect one and press any button.';return}
 const ig=[...new Set([...cal.stuck,...cal.off])].map(i=>PTN[i]);
 el.textContent='Controller: '+calId+'. '+(ig.length?'Ignored now: '+ig.join(', ')+'.':'Nothing ignored.')+(calDoneAt?' Last measured '+new Date(calDoneAt).toLocaleTimeString()+'.':'')}
function ptSync(){$('#ptdzs').value=cal.dzs;$('#ptdzs').nextElementSibling.textContent=Math.round(cal.dzs*100)+'%';
 $('#ptdzt').value=cal.dzt;$('#ptdzt').nextElementSibling.textContent=Math.round(cal.dzt*100)+'%';
 document.querySelectorAll('#ptauto button').forEach(b=>b.classList.toggle('sel',+b.dataset.v===+cal.auto));ptNote()}
$('#ptdzs').oninput=e=>{cal.dzs=+e.target.value;calSave();ptSync()};$('#ptdzt').oninput=e=>{cal.dzt=+e.target.value;calSave();ptSync()};
document.querySelectorAll('#ptauto button').forEach(b=>b.onclick=()=>{cal.auto=+b.dataset.v;calSave();ptSync()});
$('#ptb').onclick=()=>{sheet(false);touch.t=touch.s=null;fetch('/stop').catch(()=>{});$('#padt').classList.add('on');ptSync()};
$('#ptx').onclick=()=>{$('#padt').classList.remove('on');ptCount=0;$('#ptcal').textContent='Recalibrate now (hands off)'};
$('#ptcal').onclick=()=>{if(ptCount)return;if(!lastGp){ptNote();return}ptCount=3;
 const step=()=>{if(!ptOn()){ptCount=0;return}if(--ptCount>0){$('#ptcal').textContent='Hands off… '+ptCount;setTimeout(step,1000);return}
  if(lastGp)calibrate(lastGp,true);$('#ptcal').textContent='Done. Recalibrate again';padBuzz(150,.4)};
 $('#ptcal').textContent='Hands off… 3';setTimeout(step,1000)};
function ptStick(cv,rx,ry,ox,oy,rest){const g=cv.getContext('2d'),W=cv.width,R=W/2-6,C=W/2,css=getComputedStyle(document.documentElement);
 g.clearRect(0,0,W,W);g.strokeStyle=css.getPropertyValue('--line').trim();g.lineWidth=2;g.beginPath();g.arc(C,C,R,0,7);g.stroke();
 g.fillStyle='rgba(191,64,191,.18)';g.beginPath();g.arc(C+rest[0]*R,C+rest[1]*R,Math.max(2,cal.dzs*R),0,7);g.fill();
 g.fillStyle='#9a88a1';g.beginPath();g.arc(C+rx*R,C+ry*R,6,0,7);g.fill();
 g.fillStyle=css.getPropertyValue('--acc').trim();g.beginPath();g.arc(C+ox*R,C+oy*R,7,0,7);g.fill()}
function ptDraw(raw,g){const bs=document.querySelectorAll('#ptbtns button');
 PTN.forEach((n,i)=>{const b=bs[i];if(!b)return;b.classList.toggle('on',rawVal(raw,i)>.5);b.classList.toggle('ign',cal.stuck.includes(i)||cal.off.includes(i))});
 const a=k=>+(raw.axes[k]||0);
 ptStick($('#ptL'),a(0),a(1),g.axes[0],g.axes[1],[cal.rest[0],cal.rest[1]]);ptStick($('#ptR'),a(2),a(3),g.axes[2],g.axes[3],[cal.rest[2],cal.rest[3]]);
 [6,7].forEach(i=>{const el=$(i===6?'#ptL2':'#ptR2'),v=rawVal(raw,i),o=g.buttons[i].value,d=Math.min(.9,(cal.trest[i-6]||0)+cal.dzt);
  el.querySelector('b').style.width=(v*100)+'%';el.querySelector('s').style.width=(o*100)+'%';el.querySelector('u').style.left=(d*100)+'%';
  el.nextElementSibling.textContent=Math.round(o*100)+'%'})}
function buzz(ms,strong,gp){try{if(APP)CarApp.buzz(ms,strong);else gp&&gp.vibrationActuator&&gp.vibrationActuator.playEffect('dual-rumble',{duration:ms,strongMagnitude:strong,weakMagnitude:strong*.6}).catch(()=>{})}catch(e){}}
let lastGp=null;const padBuzz=(ms,strong)=>{if(lastGp)buzz(ms,strong,lastGp)};
// settings sheet: one row at a time
let fi=0;
const fItems=()=>[...document.querySelectorAll('#sheet .row,#ptb,#sheet .tests button,#reset')];
function fShow(){const L=fItems();document.querySelectorAll('.gpf').forEach(e=>e.classList.remove('gpf'));if(!L.length)return;fi=(fi+L.length)%L.length;
 const el=L[fi];el.classList.add('gpf');el.scrollIntoView({block:'nearest'})}
function fStep(d){const el=fItems()[fi];if(!el)return;
 const r=el.querySelector('input[type=range]');
 if(r){const v=Math.min(+r.max,Math.max(+r.min,+(+r.value+d*(+r.step||1)).toFixed(3)));r.value=v;r.oninput({target:r});return}
 const sg=el.querySelectorAll('.seg button');
 if(sg.length){let i=[...sg].findIndex(b=>b.classList.contains('sel'));i=Math.min(sg.length-1,Math.max(0,i+d));sg[i].click();return}
 if(el.querySelector('#mdown'))(d<0?$('#mdown'):$('#mup')).click()}
function fPress(){const el=fItems()[fi];if(!el)return;
 if(el.tagName==='BUTTON')return el.click();
 if(el.querySelector('#mhold'))return $('#mhold').click();
 const sg=el.querySelectorAll('.seg button');
 if(sg.length){const i=[...sg].findIndex(b=>b.classList.contains('sel'));sg[(i+1)%sg.length].click()}}
// photos & videos: a grid, then one at a time
let gi=0;
function gShow(){const c=[...document.querySelectorAll('#grid .cell')];document.querySelectorAll('.gpf').forEach(e=>e.classList.remove('gpf'));if(!c.length)return;
 gi=Math.min(c.length-1,Math.max(0,gi));c[gi].classList.add('gpf');c[gi].scrollIntoView({block:'nearest'})}
function gMove(dx,dy){const c=[...document.querySelectorAll('#grid .cell')];if(!c.length)return;
 if(dx){gi+=dx}else{let cols=1;while(cols<c.length&&c[cols].offsetTop===c[0].offsetTop)cols++;const n=gi+dy*cols;if(n>=0&&n<c.length)gi=n}
 gShow()}
function vStep(d){if(!cur)return;const i=media.findIndex(m=>m.name===cur.name)+d;if(i>=0&&i<media.length){gi=i;openView(media[i]);gShow()}}
function readPad(){let gp=null;if(APP){try{gp=JSON.parse(CarApp.pad()||'null')}catch(e){}}
 else gp=[...(navigator.getGamepads?navigator.getGamepads():[])].find(Boolean);
 $('#gp').classList.toggle('on',!!gp);
 if(!gp){if(padWas){padWas=false;braking=false;prevBtn=[];document.querySelectorAll('.gpf').forEach(e=>e.classList.remove('gpf'))}lastGp=null;return null}
 const raw=gp;lastGp=raw;
 if(!padWas){padWas=true;calibrate(raw,true);   // measure it at rest the moment it connects
  if(!APP&&raw.mapping!=='standard'&&!padWarned){padWarned=true;toast('In the browser the buttons of this controller may be mixed up. The app reads them properly.')}}
 calWatch(raw);gp=calApply(raw);
 if(!prevBtn.length)prevBtn=gp.buttons.map(x=>!!x.pressed);   // the press that woke it isn't acted on
 if(ptOn()){ptDraw(raw,gp);if(gp.buttons[9]&&gp.buttons[9].pressed&&!prevBtn[9])$('#ptx').onclick();
  prevBtn=gp.buttons.map(x=>!!x.pressed);braking=false;return null}
 const b=i=>gp.buttons[i]?gp.buttons[i].value:0,pr=i=>!!(gp.buttons[i]&&gp.buttons[i].pressed),edge=i=>pr(i)&&!prevBtn[i];
 const thrIn=()=>{let t=b(7)-b(6);if(!t)t=dz(-(gp.axes[3]||0));return t};
 const inSheet=$('#sheet').classList.contains('on'),inGal=$('#gal').classList.contains('on'),inView=$('#viewer').classList.contains('on');
 let out={t:thrIn(),s:dz(gp.axes[0]||0)};
 if(inView){   // one photo or video
  if(edge(1))closeView(),gShow(); if(edge(14))vStep(-1); if(edge(15))vStep(1);
  if(edge(0)){const v=$('#vbody video');if(v)v.paused?v.play().catch(()=>{}):v.pause()}
  if(edge(2))$('#vshare').click(); if(edge(3))$('#vdel').click();
  if(edge(8))closeView(),$('#gal').classList.remove('on');
  braking=false;out=null}
 else if(inGal){   // the grid (driving waits, as it does for touch)
  if(edge(12))gMove(0,-1); if(edge(13))gMove(0,1); if(edge(14))gMove(-1,0); if(edge(15))gMove(1,0);
  if(edge(0)){const c=document.querySelectorAll('#grid .cell')[gi];if(c)c.click()}
  if(edge(1)||edge(8))$('#gal').classList.remove('on');
  if(!document.querySelector('#grid .gpf'))gShow();
  braking=false;out=null}
 else if(inSheet){   // settings: the sticks and triggers still drive, so trim can be set on the move
  if(!document.querySelector('#sheet .gpf'))fShow();
  if(edge(12)){fi--;fShow()} if(edge(13)){fi++;fShow()} if(edge(14))fStep(-1); if(edge(15))fStep(1);
  if(edge(0))fPress(); if(edge(1)||edge(9))sheet(false);
  braking=false}
 else{
  if(edge(12)){cfg.sg=Math.min(cfg.ocu?4:3,cfg.sg+1);drawChips();save()} if(edge(13)){cfg.sg=Math.max(1,cfg.sg-1);drawChips();save()}
  if(edge(15)){cfg.tg=Math.min(3,cfg.tg+1);drawChips();save()} if(edge(14)){cfg.tg=Math.max(1,cfg.tg-1);drawChips();save()}
  if(edge(2))photo(); if(edge(3))toggleRec(); if(edge(4))setOrbit(-1); if(edge(5))setOrbit(1);
  if(edge(1)){$('#stop').onclick();toast('Stopped')}
  if(edge(9)){fi=0;sheet(true)}
  if(edge(8)){gi=0;openGal()}
  if(edge(10)){cfg.fit=cfg.fit==='fill'?'contain':'fill';apply();save();toast(cfg.fit==='fill'?'Fill screen':'Whole picture')}
  if(edge(11)){const Z=[1,1.5,2,3];cfg.zoom=Z[(Z.findIndex(z=>z>=+cfg.zoom-.01)+1)%Z.length]||1;apply();save();toast('Zoom '+fmt.zoom(cfg.zoom))}
  braking=pr(0);if(braking&&orbit)setOrbit(0)}
 if(!inSheet)document.querySelectorAll('#sheet .gpf').forEach(e=>e.classList.remove('gpf'));
 prevBtn=gp.buttons.map(x=>!!(x&&x.pressed));
 return out}

// ---------- drive loop ----------
let sentZero=true;
function tick(){const p=readPad();
 let t=touch.t!==null?touch.t:(p?p.t:0),s=touch.s!==null?touch.s:(p?p.s:0);
 if(braking)t=s=0;
 if(orbit&&(t||s)&&touch.t===null&&touch.s===null&&p)setOrbit(0);   // any stick input cancels circling
 T.set(t);S.set(s);Jset(t,s);T.k.classList.toggle('on',t!==0||orbit!==0);S.k.classList.toggle('on',s!==0||orbit!==0);
 const oc=cfg.sg===4;   // OC: full stick = full protocol range (server switches to OC_LIMIT)
 let ot=+(oc?t:t*cfg.sg/3).toFixed(2),os=+(s*cfg.tg/3).toFixed(2);
 if(ot&&!(orbit&&!t&&!s)){const sf=Math.abs(ot)*(oc?1:76/127);os=+(os*(1-cfg.ssr*sf)).toFixed(2)}   // less steering the faster it goes
 if(orbit&&!t&&!s){ot=cfg.orbit;os=orbit;T.set(cfg.orbit);S.set(orbit);Jset(cfg.orbit,orbit*.7)}
 if(ot||os){fetch(`/drive?t=${ot}&s=${os}&ms=350${oc&&!orbit?'&oc=1':''}`).catch(()=>{});sentZero=false}
 else if(!sentZero){fetch('/stop').catch(()=>{});sentZero=true}}
setInterval(tick,100);
$('#stop').onclick=()=>{touch.t=touch.s=null;setOrbit(0);endTest();mstop();fetch('/stop').catch(()=>{});sentZero=true};

// ---------- tests of the unknown slots (bytes 11-13 of the drive message) ----------
// A normally 128 (a centred channel like steering): tried below and above centre.
// B and C normally 0 (flags?): each single bit, then all on.
const TEST_VALUES=[[128,104,80,52,152,176,204,128],[1,2,4,8,16,32,64,128,255,0],[1,2,4,8,16,32,64,128,255,0]];
let test=null;
function endTest(){if(!test)return;clearInterval(test.timer);test=null;fetch('/extra').catch(()=>{});
 $('#tpill').classList.remove('on');document.querySelectorAll('.tests button').forEach(b=>b.classList.remove('on'))}
function runTest(slot){const was=test&&test.slot;endTest();mstop();if(was===slot)return;
 setOrbit(0);sheet(false);const vals=TEST_VALUES[slot],name='ABC'[slot];let i=0,held=0;
 document.querySelector(`.tests button[data-slot="${slot}"]`).classList.add('on');$('#tpill').classList.add('on');
 const step=()=>{if(i>=vals.length){endTest();toast('Slot '+name+' test done');return}
  const v=vals[i];$('#tpill span').textContent=`Slot ${name}  =  ${v}  (${i+1}/${vals.length})`;
  fetch(`/extra?slot=${slot}&v=${v}`).catch(()=>{});if(++held>=4){held=0;i++}};   // each value ~2 s
 test={slot,timer:setInterval(step,500)};step()}
document.querySelectorAll('.tests button').forEach(b=>b.onclick=()=>runTest(+b.dataset.slot));
// manual: step through one slot's values and hold one as long as wanted, driving or not
const MSTEPS=[[...Array(256).keys()],[1,2,4,8,16,32,64,128,255,3,5,6,7,9,10,12,15,17,24,48,96,192],[1,2,4,8,16,32,64,128,255]];
let mslot=1,mi=0,mhold=null;
function mshow(){const v=MSTEPS[mslot][mi];$('#mval').textContent=v;
 document.querySelectorAll('#mslot button').forEach(b=>b.classList.toggle('sel',+b.dataset.v===mslot));
 if(mhold){$('#tpill span').textContent=`Holding slot ${'ABC'[mslot]}  =  ${v}`}}
function mstop(){if(!mhold)return;clearInterval(mhold);mhold=null;$('#mhold').classList.remove('on');$('#mhold').textContent='Hold';
 $('#tpill').classList.remove('on');fetch('/extra').catch(()=>{})}
document.querySelectorAll('#mslot button').forEach(b=>b.onclick=()=>{mslot=+b.dataset.v;mi=mslot===0?128:0;mshow()});
$('#mdown').onclick=()=>{mi=(mi-1+MSTEPS[mslot].length)%MSTEPS[mslot].length;mshow()};
$('#mup').onclick=()=>{mi=(mi+1)%MSTEPS[mslot].length;mshow()};
$('#mhold').onclick=()=>{if(mhold)return mstop();endTest();
 mhold=setInterval(()=>fetch(`/extra?slot=${mslot}&v=${MSTEPS[mslot][mi]}`).catch(()=>{}),500);
 $('#mhold').classList.add('on');$('#mhold').textContent='Release';$('#tpill').classList.add('on');mshow()};
mshow();
addEventListener('gamepadconnected',()=>$('#gp').classList.add('on'));

// ---------- camera: H.264 decoded by the phone's hardware (WebCodecs), ffmpeg image feed as backup ----------
const cv=$('#cam'),cx=cv.getContext('2d');let dec=null,started=false,gotFrame=false,useMjpeg=false,behind=false;
function showLive(){$('#photo').style.display='grid';$('#rec').style.display='grid';
 $('#vpath').textContent=APP?'Video: decoded by the app (fastest).':useMjpeg?'Video: backup picture feed (ffmpeg). Slower than the hardware decoder.':"Video: the phone’s hardware decoder.";
 if(!conn0){conn0=Date.now();$('#ctime').classList.add('on')}}
// how long the car has been connected; turns gold at 4:00 because the battery lasts about five minutes
let conn0=null,miss=0;
setInterval(()=>{if(!conn0)return;const s=(Date.now()-conn0)/1000|0;
 $('#ctime span').textContent=(s/60|0)+':'+String(s%60).padStart(2,'0');$('#ctime').classList.toggle('late',s>=240);
 if(s===240)padBuzz(600,1)},1000);   // the battery has about a minute left: a buzz in his hands
function codecFrom(buf){for(let i=0;i<buf.length-8;i++)if(buf[i]==0&&buf[i+1]==0&&buf[i+2]==0&&buf[i+3]==1&&(buf[i+4]&31)==7)
 return 'avc1.'+[buf[i+5],buf[i+6],buf[i+7]].map(x=>x.toString(16).padStart(2,'0')).join('');return null}
function newDecoder(){if(dec)try{dec.close()}catch(e){}started=false;
 dec=new VideoDecoder({output:f=>{if(cv.width!==f.displayWidth){cv.width=f.displayWidth;cv.height=f.displayHeight}
   cx.drawImage(f,0,0);f.close();gotFrame=true;if(cv.style.display!=='block'){cv.style.display='block';showLive()}},
  error:()=>{dec=null}})}
function mjpeg(){if(useMjpeg)return;useMjpeg=true;const im=$('#mj');
 im.onload=()=>{im.style.display='block';showLive()};im.onerror=()=>setTimeout(()=>{im.src='/video.mjpg?'+Date.now()},1500);
 im.src='/video.mjpg'}
async function video(){if(APP)return;
 let ok=false;try{ok=('VideoDecoder' in window)&&(await VideoDecoder.isConfigSupported({codec:'avc1.42001f'})).supported}catch(e){}
 if(!ok)return mjpeg();
 setTimeout(()=>{if(!gotFrame)fetch('/status').then(r=>r.json()).then(j=>{if(j.video&&!gotFrame)mjpeg()}).catch(()=>{})},5000);
 while(!useMjpeg){try{const r=await fetch('/video',{cache:'no-store'});const rd=r.body.getReader();let pend=new Uint8Array(0),ts=0;newDecoder();
  while(true){if(useMjpeg){rd.cancel();try{dec&&dec.close()}catch(e){}break}const{value,done}=await rd.read();if(done)break;
   const m=new Uint8Array(pend.length+value.length);m.set(pend);m.set(value,pend.length);pend=m;
   while(pend.length>=5){const n=new DataView(pend.buffer,pend.byteOffset).getUint32(0),k=pend[4];if(pend.length<5+n)break;
    const fr=pend.slice(5,5+n);pend=pend.slice(5+n);
    if(k===2){newDecoder();continue}
    if(!dec)newDecoder();
    if(!started){if(k!==1)continue;const c=codecFrom(fr);if(!c)continue;dec.configure({codec:c,optimizeForLatency:true});started=true}
    if(k===1)behind=false;
    if(!behind&&dec.decodeQueueSize>2)behind=true;   // falling behind: drop to the next keyframe
    if(behind)continue;
    dec.decode(new EncodedVideoChunk({type:k===1?'key':'delta',timestamp:(ts+=40000),data:fr}))}}}catch(e){}
  await new Promise(r=>setTimeout(r,1000))}}
video();

// ---------- photo + record (saved on the phone by the script, full 720p) ----------
function toast(msg){const el=$('#saved');el.textContent=msg;el.classList.add('on');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('on'),3000)}
function flash(){const f=$('#flash');f.classList.add('on');requestAnimationFrame(()=>requestAnimationFrame(()=>f.classList.remove('on')))}
function photo(){if($('#photo').style.display!=='grid')return;flash();
 if(APP){let n='';try{n=CarApp.photo(+cfg.flip,+cfg.stamp)}catch(e){}toast(n?'Saved '+n:'Photo failed');return}
 fetch('/snapshot?flip='+cfg.flip+'&stamp='+cfg.stamp+'&tz='+(-new Date().getTimezoneOffset())).then(r=>{if(!r.ok)throw 0;return r.json()}).then(j=>toast('Saved '+j.file.split('/').pop()))
 .catch(()=>{ // no ffmpeg: grab what's on screen instead
  const src=useMjpeg?$('#mj'):cv,c=document.createElement('canvas');c.width=src.naturalWidth||src.width;c.height=src.naturalHeight||src.height;
  const g=c.getContext('2d');if(cfg.flip){g.translate(c.width,c.height);g.rotate(Math.PI)}g.drawImage(src,0,0);
  c.toBlob(b=>{const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='car_'+Date.now()+'.jpg';a.click();toast('Saved to Downloads')},'image/jpeg',.92)})}
$('#photo').onclick=photo;
let recOn=false,recT0=0,recTimer=null;
function toggleRec(){if($('#rec').style.display!=='grid')return;
 fetch('/record?on='+(recOn?0:1)+'&stamp='+cfg.stamp+'&tz='+(-new Date().getTimezoneOffset())).then(r=>r.json()).then(j=>{recOn=j.recording;$('#rec').classList.toggle('on',recOn);$('#rtime').classList.toggle('on',recOn);
  clearInterval(recTimer);
  if(recOn){recT0=Date.now();const r=$('#rec').getBoundingClientRect();$('#rtime').style.top=(r.top+r.height/2-8)+'px';$('#rtime').textContent='0:00';
   recTimer=setInterval(()=>{const s=(Date.now()-recT0)/1000|0;$('#rtime').textContent=(s/60|0)+':'+String(s%60).padStart(2,'0')},500)}
  else if(j.file)toast(cfg.stamp&&!APP?'Adding date & time… it shows in the gallery when done':'Saved '+j.file.split('/').pop())}).catch(()=>{})}
$('#rec').onclick=toggleRec;

// ---------- gallery: everything the car has saved on this phone ----------
let media=[],cur=null;
const fmtDur=d=>isFinite(d)?(d/60|0)+':'+String(Math.round(d%60)).padStart(2,'0'):'';
function openGal(){$('#gal').classList.add('on');touch.t=touch.s=null;fetch('/stop').catch(()=>{});
 fetch('/media/list',{cache:'no-store'}).then(r=>r.json()).then(list=>{media=list;const g=$('#grid');g.innerHTML='';
  if(!list.length){g.innerHTML='<div id=empty>No photos or videos yet.</div>';return}
  for(const m of list){const b=document.createElement('button');b.className='cell';const src='/media/file/'+encodeURIComponent(m.name);
   if(m.type==='photo')b.innerHTML=`<img loading=lazy src="${src}" alt="">`;
   else{b.innerHTML=`<video preload=metadata muted playsinline src="${src}#t=0.3"></video><span class=dur></span>`;
    const v=b.querySelector('video');v.onloadedmetadata=()=>{b.querySelector('.dur').textContent=fmtDur(v.duration)}}
   b.onclick=()=>openView(m);g.appendChild(b)}}).catch(()=>{})}
function openView(m){cur=m;const src='/media/file/'+encodeURIComponent(m.name),vb=$('#vbody');
 vb.innerHTML=m.type==='photo'?`<img src="${src}" alt="">`:`<video src="${src}" controls autoplay playsinline></video>`;
 $('#vdel').classList.remove('warn');$('#vdel').textContent='Delete';$('#viewer').classList.add('on')}
function closeView(){$('#viewer').classList.remove('on');$('#vbody').innerHTML='';cur=null}
$('#galb').onclick=openGal;$('#galx').onclick=()=>$('#gal').classList.remove('on');$('#vback').onclick=closeView;
$('#vdel').onclick=()=>{const b=$('#vdel');
 if(!b.classList.contains('warn')){b.classList.add('warn');b.textContent='Tap to confirm';clearTimeout(b.t);b.t=setTimeout(()=>{b.classList.remove('warn');b.textContent='Delete'},3000);return}
 fetch('/media/delete?name='+encodeURIComponent(cur.name)).then(()=>{closeView();openGal()})};
$('#vshare').onclick=async()=>{if(!cur)return;if(APP){try{CarApp.share(cur.name)}catch(e){}return}try{const r=await fetch('/media/file/'+encodeURIComponent(cur.name));const blob=await r.blob();
 const f=new File([blob],cur.name,{type:blob.type});if(navigator.canShare&&navigator.canShare({files:[f]}))await navigator.share({files:[f]});else toast('Sharing not supported here')}catch(e){}};

// ---------- full screen, home-screen app, server check ----------
const standalone=matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
function lock(){try{screen.orientation.lock('landscape').catch(()=>{})}catch(e){}}
function goFull(){const d=document.documentElement;
 if(!document.fullscreenElement&&d.requestFullscreen)d.requestFullscreen({navigationUI:'hide'}).then(lock).catch(()=>{});else lock()}
if(!APP){if(standalone)lock();else addEventListener('pointerdown',goFull,{once:true,capture:true});
 if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{})}
let everLive=false,downAt=0;
function carState(live,busy){
 if(live&&APP&&$('#photo').style.display!=='grid')showLive();
 if(live){everLive=true;miss=0;if(downAt){downAt=0;$('#lost').classList.remove('on');document.body.classList.remove('down')}return}
 if(++miss<2)return;                                   // ~2 s without a frame
 if(!downAt){downAt=Date.now();touch.t=touch.s=null;setOrbit(0);fetch('/stop').catch(()=>{});if(everLive)padBuzz(900,1);
  conn0=null;$('#ctime').classList.remove('on','late')}
 if(busy){$('#lostT').textContent='Another controller has the car';
  $('#lostS').textContent=(APP?'The Termux version (fpv_car.py serve) or Nessari’s drive screen is holding the picture. Close that page, or stop the script with Ctrl+C,':'The FPV Car app or Nessari’s drive screen is holding the picture. Close it (swipe the app away)')+' and the picture comes here by itself.'}
 else if(everLive){$('#lostT').textContent='Car disconnected';
  $('#lostS').textContent='No picture or control. The battery may be flat, or the car is out of Wi-Fi range. It reconnects by itself.'+(APP?'':' If it stays like this, turn mobile data off.')}
 else{$('#lostT').textContent='Waiting for the car';
  $('#lostS').textContent='Turn the car on and connect this phone to its Wi-Fi. The picture comes up by itself.'+(APP?'':' Turn mobile data off while you drive: with it on, the phone sends the car’s messages over mobile data and they never arrive.')}
 $('#lost').classList.add('on');document.body.classList.add('down')}
let polls=0;
setInterval(()=>fetch('/status',{cache:'no-store'}).then(r=>r.json()).then(j=>{$('#off').classList.remove('on');
 if(++polls%3===0)sendTrim();carState(!!j.video,!!j.busy)})
 .catch(()=>{if(!APP)$('#off').classList.add('on');conn0=null;$('#ctime').classList.remove('on','late')}),1000);
apply();sendTrim();
</script></body></html>"""


MANIFEST = """{"name":"FPV Car","short_name":"FPV Car","start_url":"/","scope":"/","display":"fullscreen",
"orientation":"landscape","background_color":"#16011e","theme_color":"#16011e",
"icons":[{"src":"/icon-192.png","sizes":"192x192","type":"image/png","purpose":"any maskable"},
{"src":"/icon-512.png","sizes":"512x512","type":"image/png","purpose":"any maskable"}]}"""

# keeps a copy of the page so the app still opens (and says what to do) when the script isn't running
SERVICE_WORKER = """const C='car-v8';
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/icon-192.png'])));self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{if(e.request.mode!=='navigate')return;
 e.respondWith(fetch(e.request).then(r=>{const k=r.clone();caches.open(C).then(c=>c.put('/',k));return r}).catch(()=>caches.match('/')))});"""

ICON_192 = "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAYtklEQVR42u2dz3Mcx3XH3+vumdnfABa/QQASRVH8IcmSFcsH25Gd0iFVrric+C/wwadEVSn74EvKh1xySZV0kS4pH3zNxbEqdlUurrIT+2LJEiWKFCnxJwCS+LkL7I+ZnZnufjk0sFruLGBQXACzy/4eUBTFXex2f+a9169fv8YpXAQrqy8rZofAygJkZQGysgBZWYCsrCxAVhYgKwuQlQXIysoCZGUBsrIAWVmArKwsQFYWICsLkJUFyMrKAmRlAbKyAFlZgKwsQFZWFiArC5CVBcjKAmRlZQGysgBZWYCsLEBWVhYgKwuQlQXIygJkZWUBsrIAWVmArCxAVhYgKysLkJUFyMoCZGUBsrI6vIQdAgBAwM7/JCACSv6b5D+zQ/fEAoS4B4EGTWSIIQQGAAKFQAce4gMVSUkSAAg0ACIgIjJghioCgCeSpycLoL3JJk1Kgzas5FjOY5m8yLvoFngBAFzmeczrNDAIGOow0iEANFQjoqgpm6FutXQrphgAGDCGbZieIJLwCbnuCQEJSJEi0AKdHM+NibGSM5LjuQzLCHSMh9KgAZBAEyVcGCICAyAGzPg4SXFLt3zl1+Kdqqz6ypcUIzCO3Pw6C9CQoKNBS5IOOiVRKjsT4245y3LGSWnQmnTXZGP7x0PqZgoBGTIGDAAlxYH2t6JKJd6syVpMsUBhULMADbC3UqQ0qAzLTXvTU+50URQZsE5osAcoj6b2+xiYNOi6rK9Ha2vhWkv7DDhHPsR+bTgBQkBFSoMuitIpb37CnciyrAJluHl8aA6AyZDEgQc62Iw274UrdVljwDjyoWRo2AAyDkuRKoriQmZxyp0W6CiSGvRhuDnMHB/yfRgwjkJSvB6tLbeW6rLOkQ+fUxsegMy8xhR7zHs6e3rOO8WRS5IHm5z2dJogmiFr/5n24iDzh3ZyyJixzhcebJAECkXqfnjvTnA71KGDzjB5tCEByPgsAJjxZk/nnsmy7MHomPnrXHsrUjHFgQo0KEmyIRuI2BE/U0EUBAoGPMuzDjrtyEaTNhmBA36XwSjQwW3/1mr4AACGxqMNA0AIGFOc5/mz+XOTzqTc32G1uTHTH+nI182arDVlo6GaoW7FFGvSAKBB415m0PyBAQMAhsxBx2OZAs/nRaEkSjmWd5m7F7DvS5JxagLFRrzxefN6UzUddIaAoWEAKKZ4xps9lzvvMjem+AB0TBQS6nBH7mxGG9uyGurQmC7jv5L7Fcn3MVan/YYe80bF2IQ7OSJGPOaZCOwAjBx0Ih1d96+thg+MO7MAnWS8DABncs8uZBaNK0lOm5lpgQIA6rJ+P1zZirdaqkVAZuHdfsnh7UHnS0xSAAEzPDPujM9580VRBACz79Hz8xjXudxauunfMBZxcE3RoAKEgJKkw5wXiy+VRTmi6GB0KvHWcrC0LbclSWOH+hjJml9tbI9AMSpGF7KLZWf8YIxcdCuycrn+UaxjgWJAGRpIgEzQMyJGni+8kOU5SbLnDJktha14azlYqsRbxuMc6SZDe8MEAMrO+EJ2cdwZN3/T8xMKFIHyrzQ+2ZE7AxoS8TyODCg9L5W+6rFMT3oAwEHXV83P/M9u+jcCHQgUZol+HGOKnCFrquZauOprv8ALGZYz3jbpgj3mTXpT23HV174J7S1Ax0SPya8ka3TMImultXSl8UlN7jjoMDyBIMNgVJM7a+EqRzbqjLaX9F0MCRRT3vSAMjRIAB2GHoFOROGV+uXl1hJD5EcQWyAiR8aQISIiIDLzkyFjiTUcR06gN6KNuqyV3bLLPA1qmBgaGIBM1HwwPQ46W/Hmx/WPa6rW9xUyIprsX0RRQEFALUVKkYpJSpIRxT4FEUVExJFz5J2QcOQN1ViPNvIiX+RFdSBDgQ4GiKGBCaJNUPy10qv7Rc0CxUpr+Xrzmlmc99HwMGREFFIYQVRghdnszMWRc2WvvJCfLzlFpRVnvBbXl5srlbBydef6g2C1oRsuuB56iGgyk4YSTfpc/vx8ZsGsznrG1O/X3usZdFuAHhegl0uvjIrRnvRw5Neb11ZaywJFH9dZpm61qZsM2Nnimdemv/VX4y/PZWfzIseQKVJEuxtlxj5p0k3p3w8e/Hnr0v+u/eHz+k0NOs/ypmTWfDBJcj6zcC5/3izWkgxty+1LtQ8sQP10XhFF5/Lnn8o83TPfw5Ffa3660lp20e2j4eHIQx3GIF8tv/IPi9/7yugLOZGLdBTpqGdZSLuWw2Wuy1xf+h9vf/JfS//9XuUDB4THvHaGOqJoPrNwPn+hJ0Muundbd643r/X36zyhMZAJnGe82edy53puUxwdPXXdGPfK/3z+H3909oencrN7W616t5x+N4j+QuZvTPKwpVqI+FR+4fXZv5nPzV2tXavK7QzLtHObVVmNKJpypxLFkKhAlZ2yr/2arKU/GEo1QGaPPcdzLxZf6unUHHSM5+o3PayuG18vf+1fX/qXl8ZeaMhGrONdRA7hWdplIZGOYh1fHDn311PfWG6u3PbvZPZq9Q1DMcVT7nQypiagsju+GW1EOjq29NVwAkRAzxdfSK5cDD0rreVbwc2+256q3vne3Hd/9uJPBXN85XPknaUdj7RwQ8RAtfIi/7dzr2+FlUu1yzmWazO0Lasuc8ecseS3c9HN8dxauGoBeiznNevNPZ093eW82iv2K41P+rsDwJFV9c7fz/3dTy684atAkXp8J2LCbUnqtalvboc7l2of51i2vZm/Ea2POCOFh58Q48iKvBToYEdup9mRpRcgAnKZ+3zxhaTXYMAiij6uX+pvgbOJe743992fXHzDV4HZru9XDsmsv16b/ka1tf1J7aqJhxAQECpxZcqbNpu+Xda35JTWo7Uu+2QBOmza8Nnc2XFnImneOfIr9cs1VevjJjZHXtf1r5e/9rOv/NSXQd9r73fX8Fq+Nv3Na9uf3fbvZFhGgzYPg6+as5m5rnIUAvKYx5BtRBupNUIp9a8KVJEX57xTXVkfAnLQXWktb8QbfXReCBhSOOVO/vjiG5GKTH3PUTwVmnSkoh9ffGPKnQwpNFQ56GzEGyutZefhYM48RXPeKRMCWoAebaAXsotdhcPG9jRV45Z/s7+hDyLGJH909oczmanwKBc+DFmoo5nM1I/O/jAmaWJzw9At/2ZTNXp+5YXs4hExPZwAmfhxyp1OJp0R8HZwa7+61S89qU3dfHXsq6/PfrsW14/aWXDktbj++uy3Xx37alM32+dAYopvB7eS31eSnHKni7yUTiPEUmh+FKn57HxXfGPS/JV4y5QS9zdFy4D94Knv0zFmfYngB099n+2NvzFCq+GDSrzV84vPZ+fTuUGWOoA06CzLjTsTPcdrKVjq7yAyYIFuPVs48+LY84EKjifpwpAFKnhx7PlnC2cC3WpjhIBLwVLPJ2rcmcj2qkqzAPVYfE1701mW7RystvlJPqCPH/1EEH1n5lt5kUvuTB2hmyaVF7nvzHwrgqgdCe33HTXoLMtOe9P7lV9agDoXWc60O72f+TmKiSyywivll0N1rJsGDFmoolfKLxdZoQvc/YzQtDudwrpplirzo0gVRakguletHHhd1rdltb8HOhExomg2MzOXm410dJwPNwJGOprLzc5mZiL6wghx5NuyWpd1DrxrYVEQxaIopS0SSpcF0qAn3ImusTMZ4XvhSt/HjgGLIb4weu6Y/VenF7swei6GuDMMUqTuhSvJOm4OfMKdSFsYlCKAjP8qO+UuUEx7uUpUOYrz5Bpowhs/qQ1LhmzCG9eJxE8lqoQ67BoERarslNPmxdICkKn4zLJc11rDhJY1udPSPuv3pyUgAWIhf0rpE0jTIaDSeiF/SsBDITMD1tJ+Te70CqV3xyc9XixFFkiRGnPHej5hG9EGHdksFp3iST3TBFR0ir3OHMJGtNHTQo+5Y8fvbQcmiB4RI8kKvYiivofPXeCe7GOTBMWE0sn6XQIaESM2iN7Hm6DI8YfsswmffdUMVciO7KOe7EZ3z9/OgIUq9FWzM5Q2Xj7Hc6k6SJ8WgDRoj2U8ljWHYDqXHjVZkyCPDtx6XD+pZxoB63G9Jw0SZE3WuhakmrTHsh7LpGctlgqAEJCIMizjJJ4tAmrIxhFNMAJKkMvNe5ydwNlnAuKMLTfvSeiRX0bAhmwkR8NBkWEZIkqJI0uRBcqLfHIvWpFqqubR+S8GuBludZm94/vWpDfDLdYLBQasqZrJ1BcC5kXeWqAecpmbHKyY4lC3TEnoUVDrgPPp9vWmPIET6Rx5U/qfbl93wOkCgoAQ0bTcS46J6ahnAep+4Aq80JUBQsSWDvpb/fPQPBG56D5ord73H7jsWE/xmYrv+/6DB61VF90eNysAxhS3dND18GjQBV5gKZq4FGu3X/hRFuOZQvoPKpc87h6nI9OkPe5+ULlU142exs+UZab/kHwqADKZDxe9ZCl7sglB/40QuL9b/cMxezHjv363+gcXepif/b6+qaF20UtPl+C0AOSg4zGvaygZsIZqHGnAqEFnWeZG4+bl6pUszx6PEdKkszx7uXrlRuNmdv81uQbdUI0ub0VEHvPSsyOWokRizxE5HgOuQf/y7rt4jL4CEX55992/+Gzs1yvYJhJTJE06z/LvVT/87YPfl5ziUe9sKFIlp/jbB79/r/phnuVPKoNgAepzJOSg+Pnnv1htrXvsCKNpTdpj7mpr/eef/8JBQTTwneotQLtOwUNvPdp46+rbLnePqCmn2dpzufvW1bfXow0PvSG46iBF9UAHXFFwDFKkiqz4p8r7b159OyeyfW8nbRaYOZF98+rbf6q8X2SH8pX7xYW2Hqh7RGKKQx12dVE55qSZKbB/9/5v3rr6To5nTSamX54LAXM8+9bVd969/5tkIf0+c9OdXAUARAx1eHTJ1UEFSJGK9s6Kd/6vrp4VR8+QHmOjv7r/6zc/fTvHsw5zHj+mVqQc5uR49s1P3/7V/V+PsVF1aC67vr4xYxGF6Ukwpvrab5NgPOY24YrUGBv5zf3/2Wht/vjCP81kp2txHQC+RN20MWAjTmk1WHvr03f+VHl/jI0ckkgTMKX/WrFUtHcxZRVFUSyLcruZi/nJkK2Fq8fcIIeAMixz27/7f+t/HHVHz5XOusyRJBUp01v8L75ck2bIciLrMve3q7/7t0/+/bPGzSIrHt72mOTqYvbpLg8uUKzHa1vxZkoavqQFIAWqKIrjznhXxThHvhFthDo85oMThqGmbP5+44/Xdq6X3NJMZtrUL5vtOROamJze7iVi5rY5RI95eZGXWn5Y/eid6//xn0u/jFWcY49wcsiEXzmen8/Md1kghmw9Wk9P27K0uDAGrCmbyfopgSLP8ztyu6s273h8mYOOi+57lT//ufJhZ5/oolM4oE/0nebdZJ/oR42lNOg8z3PkyfZ+TdlMz258KgDaq9xoxSRZovylIAoUntipCSIyBNyo37pav1a49Qid6jOYaXeq/xK/uiAKvQqkZOvICqQG2wKFuhXqIM8LnSOuQJVESZzo5zSfx2NeFrKK1N3m0o3mTQ0kQLC9y501kATJAB1wXHRH2IgGTURfOtcsQJREd08ghixQjbCjoYcF6KFUkK9800mpHUebUMDjXtdJzROwRkRmOj3mZSEDuxmHvTvBd5N7pIG+hMNK+i+Pezme76yFMjdZ+cqXJO1ufG+jvSN3kiehXHRHxVh6Mh9EpEjvhtJE7Z+KlCL9+NtbJk4fFWPJ/tcIuCN37NHmfRaEyKtRtWeOddKdHIyrR/pmj2HSnexppKtRNVUdW1NUD8SABdoPHj4Db1pOlcRIJpX9uY4k5AKdYbmSGOlqJ9U5PrYeaN8wqBJXkp1KPeaV3fIA3aL1mP6r7JY95iXbtVbiSnp2wVIHkHnINqPNrqWHCaVPefPpz+v3xRJz5Ke8+eRRAgVqM9pkqZuylI1dXdYavfpzFUUxVaH00ZmfUTFW7NWjrSHrdVlL21OUuiabMcVr0VrPYVrMLsIToOTXNI/WWrSWNv8FKWyyKVCshWuBDpKhdNkZLzvjKexU2q+HZ7/vyIAFOlgL11LVlyONALXXGma3uacRGuIwiID2Mz9b8WZwBD3ahhAgM14rwUrXU9h+QGe82RRa8r747hlvNml+zBdfCVbSuYZIY1E9B15XtfWoh8UmoNPZZ1LYLvnxHxsHndPZZ3rWI6xHa3VVO/56hEEFyBTjLQdLyXatilSeF57JnRkmI2TMzzO5M3le6PmVl4OlYy7LHGyA9oxQ/X54r8sIIWBM0XxmYdKZHA6GDD2TzuR8ZiF+uCmiMT/3w3t1VU+n+UkvQCYSuhPc7lqOwV5e8Xzhornxb6AZMm0PMyxzvnAxmTk0i687we00Z1DTe7CQAQt1eNu/lYyEzKBfKFwc9HPBAKBJX9h7GJLRz23/VqhDluJpSvW13yYxXXJKPS81LvCiy9z1aC3Nlxr/Red1Pn8hua5sX0t907+RwtzPYFigtj5rXo8oSjqymOL5zMJ8ZiHZT3kg6IkoMp8/GcyZm3g/a15P/xdJtQUCAIaspVst3ZrxZrsO95gAYtKdiiiqyuoxH0HsCz3n8xeSu3vGeV1tXqnG1ZSbnwEAyDiyHbnjMGfcGU8eECOgqYFiqIue5OrBRXepdfducCdZkWgB+vIMVeLKiDPa1cq+k6GY4m1ZZchS687MB5MkFzKL+9EjUFRl9dPGlUEJ7AYDIKONaH3KnfKYtw9D0y5zN6INQGCpvExYg9akz+cvPJM7sx89gfIv1T9I9oq0APVhVS9J1uTOpDclUCQZUqDGnLGSM1KNqxGFqXqCTcjvscwLxRd77uWZvJckebn+caCCAVpXDpIF4sh97W/H1SlvOslQe20/7U35ym+oBkPEkzZF5qyPJDnhTHyl9FJRjMj96fmo9uGO3Bmsnb5BAugwDGlQAsVsZs5l7na8HVPMkZ+IOzBtoGKKOYqz+eeey59jwHouAgaXnsEDqIshB50kQ2ZWxpzypDshSdZlTYM+TowMOpKkBj3jzT5feH7CnVIkIdF11cQ9g0vPQALUydCYM9YzpjYhkcu8KXe65IzEOm6qpgZ91Gs08+aKlAZddsafK5x/Kvu0YE7PKsp21Hy5/vGA0gMAOIUDWWhsHnGHOS8WXyqLcs9ktJkPkxyqxFvLwdK23JYkOXKzTOvXhJlfrUErUgLFqBhdyC6WnXHYazXf87O56FZk5XL9o1jH6U8YDhtA7YUxAJzJPbuQWTQ9ew7GqC7r98OVrXirpVqm6ogB6zx8/kjEmJeYxTkCZnhm3Bmf8+aLongwOgwYQ7bcWrrp3zALzMGtjxtggNoyxaDncudd5u5XJGRmyNieUIc7cmcz2tiW1VCHJiWDgMbBHezjdntJkW6/oce8UTE24U6OiBHjT9tv2PPlDjqRjq7711bDBw46gz74wwCQWezkef5s/tykM2mi1wMwYsBMoiXSka+bNVlrykZDNc39XKZERIM2TTdgr/uG8XoMmYOOxzIFns+LQkmUcixvLvAyoc8B6DBgAsVGvPF583pTNYejMHcYAIK90k8AmPFmT+eeybKsJHlAPrdNUjusVqRiigMVaFCSZEM2OnsOE1FBFAQKBjzLsw46BkFjjQ7gBvZaqwoUgQ5u+7dWwwfGdA1HWfeQANSev5hij3lPZ0/PeadMfuXgbYHOO5GNF2v/2XT+gS9aAO1ecWL8V+cLD3hzg44idT+8dye4HerQuK2hORQwPAB1RtaKVFEUFzKLU+60QEft79T24+kwEfTB78OAcRSS4vVobbm1VJd1E4EN2XmSYQOo06Np0EVROuXNT7gTWZZVoIzxOLpUkHlzhowDD3SwGW3eC1fqsmairqE8EjmcAD2c01MZlpv2pqfc6aIoMmBm4W2m8/Fhar+PSQpo0HVZX4/W1sK1lvYZ8Ha0NJzjPKwAdTk101ewJEplZ2LcLWdZTqADe1mcRCe5vR8Po0KJdzbQAKCkOND+VlSpxJs1WYspFiiGz2E9iQC1J5uAFCkCLdDJ8dyYGCs5Izmey7CMQMcEzho0ABL0aHWIu3v7ZLAgIElxS7d85dfinaqs+sqXFCMws+829Og8WQB1+rXOtbdAkWEZj2XyIu+iW+AFAHCZ19UgDAFDHUY6BICGakQUNWUz1K2WbpmMc2dG4AlB50kE6CGDshfB7DZ0BgIgUz8kUHAU8BAHqEgaVgi0aeqLiO2dEAKAJ4mbtgQ8ofrCRTFgXfeUEVBMUdJ6JS9fetLsjQXosOmfk70+cYBk70y1sgBZWYCsLEBWFiArKwuQlQXIygJkZQGysrIAWVmArCxAVhYgKysLkJUFyMoCZGUBsrKyAFlZgKwsQFYWICsLkJWVBcjKAmRlAbKyAFlZWYCsLEBWFiArC5CVlQXIygJkZQGysgBZWVmArCxAVhYgKwuQlQXIysoCZGUBsrIAWVmArKweQf8Pl2GqaieFj+QAAAAASUVORK5CYII="
ICON_512 = "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"



def cmd_serve(c, port=8765):
    import json
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlparse, parse_qs
    vid = Video(c.ip)
    # quiet when no controller page (or other app) has asked anything for a few seconds: the open page
    # asks every second, so a forgotten script never fights the FPV Car app or Nessari for the car
    seen = [time.time()]
    c.quiet = vid.quiet = lambda: time.time() - seen[0] > 5
    vid.start()

    import os, re
    def media_dirs():
        h = os.path.expanduser
        pics = h("~/storage/pictures") if os.path.isdir(h("~/storage/pictures")) else h("~")
        movs = h("~/storage/movies") if os.path.isdir(h("~/storage/movies")) else h("~")
        return pics, movs
    SAFE = re.compile(r"^car_[0-9_]+\.(jpg|mp4)$")      # only the car's own files, nothing else

    def media_path(name):
        if not SAFE.match(name or ""): return None
        pics, movs = media_dirs()
        path = os.path.join(pics if name.endswith(".jpg") else movs, name)
        return path if os.path.isfile(path) else None

    class H(BaseHTTPRequestHandler):
        def send_file(self, path, ctype):
            size = os.path.getsize(path); start, end = 0, size - 1
            rng = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
            if rng and (rng.group(1) or rng.group(2)):
                if rng.group(1): start = int(rng.group(1)); end = int(rng.group(2) or end)
                else: start = size - int(rng.group(2))
                end = min(end, size - 1)
                self.send_response(206); self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            else:
                self.send_response(200)
            self.send_header("Content-Type", ctype); self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1)); self.end_headers()
            try:
                with open(path, "rb") as f:
                    f.seek(start); left = end - start + 1
                    while left > 0:
                        chunk = f.read(min(65536, left))
                        if not chunk: break
                        self.wfile.write(chunk); left -= len(chunk)
            except OSError:
                pass

        def reply(self, body, ctype="text/plain"):
            self.send_response(200); self.send_header("Content-Type", ctype)
            self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers()
            self.wfile.write(body.encode() if isinstance(body, str) else body)

        def do_GET(self):
            seen[0] = time.time()
            u = urlparse(self.path); q = {k: v[0] for k, v in parse_qs(u.query).items()}
            if u.path in ("/", "/pad"):
                return self.reply(JOYSTICK_PAGE, "text/html")
            if u.path == "/manifest.webmanifest":
                return self.reply(MANIFEST, "application/manifest+json")
            if u.path == "/sw.js":
                return self.reply(SERVICE_WORKER, "text/javascript")
            if u.path in ("/font-400.ttf", "/font-700.ttf"):
                import base64
                fp = os.path.expanduser("~/.fpv_car" + u.path)
                if not os.path.exists(fp):
                    self.send_response(404); self.end_headers(); return
                return self.reply(open(fp, "rb").read(), "font/ttf")
            if u.path in ("/icon-192.png", "/icon-512.png"):
                import base64
                return self.reply(base64.b64decode(ICON_192 if "192" in u.path else ICON_512), "image/png")
            if u.path == "/drive":
                ms = float(q.get("ms", 1000))
                c.set(float(q.get("t", 0)), float(q.get("s", 0)), min(ms, 10000) / 1000, q.get("oc") == "1")
                return self.reply("ok")
            if u.path == "/stop":
                c.stop(); c.clear_extra(); return self.reply("stopped")
            if u.path == "/boost":
                c.set_boost(int(float(q.get("v", 0)))); return self.reply("ok")
            if u.path == "/trim":
                c.set_trim(int(float(q.get("v", 0)))); return self.reply("ok")
            if u.path == "/extra":
                if "slot" in q: c.set_extra(int(q["slot"]), int(q.get("v", 0)))
                else: c.clear_extra()
                return self.reply("ok")
            if u.path == "/status":
                return self.reply(json.dumps({"video": bool(vid and vid.live), "busy": vid.sock is None,
                                              "recording": bool(vid and vid.rec_file)}), "application/json")
            if u.path == "/media/list":
                items = []
                for d in set(media_dirs()):
                    for n in os.listdir(d):
                        if SAFE.match(n):
                            st = os.stat(os.path.join(d, n))
                            items.append({"name": n, "type": "photo" if n.endswith(".jpg") else "video",
                                          "size": st.st_size, "time": st.st_mtime})
                items.sort(key=lambda m: m["time"], reverse=True)
                return self.reply(json.dumps(items), "application/json")
            if u.path.startswith("/media/file/"):
                from urllib.parse import unquote
                path = media_path(unquote(u.path[len("/media/file/"):]))
                if not path: self.send_response(404); self.end_headers(); return
                return self.send_file(path, "image/jpeg" if path.endswith(".jpg") else "video/mp4")
            if u.path == "/media/delete":
                path = media_path(q.get("name"))
                if path: os.remove(path)
                return self.reply("ok")
            if u.path == "/snapshot" and vid:
                path = vid.snapshot(q.get("flip") == "1", q.get("stamp") == "1", int(float(q.get("tz", 0))))
                if not path:
                    self.send_response(503); self.end_headers(); return
                return self.reply(json.dumps({"file": path}), "application/json")
            if u.path == "/record" and vid:
                path = vid.record(q.get("on", "1") == "1", q.get("stamp") == "1", int(float(q.get("tz", 0))))
                return self.reply(json.dumps({"recording": bool(vid.rec_file), "file": path}), "application/json")
            if u.path == "/video.mjpg" and vid:
                return self.mjpeg()
            if u.path == "/video" and vid:
                # stream of [u32 length][1 byte: 1 key, 0 delta, 2 restart][H.264 frame]
                import struct
                self.send_response(200); self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Cache-Control", "no-store"); self.end_headers()
                qq = vid.subscribe()
                try:
                    while True:
                        buf, key = qq.get()
                        flag = 2 if key == "skip" else (1 if key else 0)
                        self.wfile.write(struct.pack(">IB", len(buf), flag) + buf); self.wfile.flush()
                except OSError:
                    pass
                finally:
                    vid.unsubscribe(qq)
                return
            self.send_response(404); self.end_headers()

        def mjpeg(self):
            # backup path for browsers that can't decode H.264: ffmpeg turns it into JPEG frames
            import shutil, subprocess
            if not shutil.which("ffmpeg"):
                self.send_response(404); self.end_headers(); return
            proc = subprocess.Popen(
                ["ffmpeg", "-loglevel", "error", "-flags", "low_delay", "-probesize", "32768",
                 "-analyzeduration", "0", "-framerate", "25", "-f", "h264", "-i", "pipe:0",
                 "-vf", "scale=854:-2", "-q:v", "6", "-flush_packets", "1", "-f", "mpjpeg", "pipe:1"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            qq = vid.subscribe(); alive = [True]

            def feed():
                try:
                    while alive[0]:
                        buf, key = qq.get()
                        if buf: proc.stdin.write(buf); proc.stdin.flush()
                except OSError:
                    pass
            threading.Thread(target=feed, daemon=True).start()
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace;boundary=ffmpeg")
            self.send_header("Cache-Control", "no-store"); self.end_headers()
            try:
                while True:
                    chunk = proc.stdout.read1(65536)
                    if not chunk: break
                    self.wfile.write(chunk); self.wfile.flush()
            except OSError:
                pass
            finally:
                alive[0] = False; vid.unsubscribe(qq); proc.kill()

        def log_message(self, *a): pass

    try:
        srv = ThreadingHTTPServer(("127.0.0.1", port), H); srv.daemon_threads = True
    except OSError:
        print(f"port {port} is busy: the FPV Car app (or another copy of this script) is open.\n"
              "Close the app (swipe it away from recent apps), then run this again.")
        return
    print(f"controller: http://127.0.0.1:{port}")
    try:
        srv.serve_forever()
    finally:
        if vid and vid.rec_file: print("saved", vid.record(False))


def cmd_probe(seconds=6):
    """Find the video. Sends the app's hello from port 23459 (like the app does),
    listens on UDP 1234 and 23459, tries RTSP, and saves everything to Downloads."""
    import os, select, struct
    out_dir = os.path.expanduser("~/storage/downloads")
    if not os.path.isdir(out_dir): out_dir = os.path.expanduser("~")
    dump_path = os.path.join(out_dir, "car_video_dump.bin")
    rep_path = os.path.join(out_dir, "car_probe_report.txt")
    rep = []
    log = lambda *a: (print(*a), rep.append(" ".join(str(x) for x in a)))

    socks = {}
    for port in (1234, 23459):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)
        try: s.bind(("0.0.0.0", port)); socks[s] = port
        except OSError as e: log(f"couldn't listen on {port}: {e}")
    hello_sock = next((s for s, p in socks.items() if p == 23459), None) or \
        socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    log(f"sending hello, listening {seconds}s ... (keep the car app CLOSED)")
    stats, firsts = {}, {}
    dump = open(dump_path, "wb")
    end = time.time() + seconds; last_hello = 0
    while time.time() < end:
        if time.time() - last_hello > 1.0:             # app repeats its hello now and then
            for p in HELLO: hello_sock.sendto(p, (CAR_IP, HELLO_PORT))
            last_hello = time.time()
        r, _, _ = select.select(list(socks), [], [], 0.2)
        for s in r:
            data, addr = s.recvfrom(65535)
            key = (socks[s], addr[1]); stats.setdefault(key, [0, 0])
            stats[key][0] += 1; stats[key][1] += len(data)
            firsts.setdefault(key, []).append(data[:24].hex()) if len(firsts.get(key, [])) < 6 else None
            dump.write(struct.pack("<dHHI", time.time(), socks[s], addr[1], len(data)) + data)
    dump.close()

    if not stats: log("nothing came back on 1234 / 23459")
    for (lp, rp), (n, b) in stats.items():
        log(f"to my port {lp} from car port {rp}: {n} packets, {b} bytes")
        for h in firsts[(lp, rp)]: log("   ", h)
    raw = open(dump_path, "rb").read()
    log("JPEG start markers:", raw.count(b"\xff\xd8\xff"), " H264 start codes:", raw.count(b"\x00\x00\x00\x01"))

    # RTSP check (the forum poster got video this way)
    for port in (554, 8554):
        try:
            t = socket.create_connection((CAR_IP, port), timeout=1.5)
        except OSError:
            log(f"rtsp port {port}: closed"); continue
        for path in ("", "/live", "/stream", "/11", "/av0_0", "/live/ch00_0", "/h264", "/video", "/webcam"):
            url = f"rtsp://{CAR_IP}:{port}{path}"
            try:
                t.sendall(f"DESCRIBE {url} RTSP/1.0\r\nCSeq: 2\r\nAccept: application/sdp\r\n\r\n".encode())
                t.settimeout(1.5); resp = t.recv(2048).decode(errors="replace")
                log(f"{url} -> {resp.splitlines()[0] if resp else 'no reply'}")
                if " 200 " in resp.splitlines()[0]: log(resp)
            except OSError as e:
                log(f"{url} -> {e}")
                try: t.close(); t = socket.create_connection((CAR_IP, port), timeout=1.5)
                except OSError: break
        t.close()
    for port in (80, 8080, 7060, 7070, 8888, 1234):
        try: socket.create_connection((CAR_IP, port), timeout=0.8).close(); log(f"tcp {port}: open")
        except OSError: pass

    open(rep_path, "w").write("\n".join(rep) + "\n")
    print(f"\nsaved: {rep_path}\n       {dump_path}  ({os.path.getsize(dump_path)//1024} KB)")
    print("send me both files")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "probe":
        cmd_probe(); sys.exit()
    mode = sys.argv[1] if len(sys.argv) > 1 else "test"
    car = Car()
    print("car answered" if car.start() else "no answer from car - on its Wi-Fi? car switched on?")
    try:
        {"test": cmd_test, "keys": cmd_keys, "serve": cmd_serve}[mode](car)
    except KeyboardInterrupt:
        pass
    finally:
        car.close()
