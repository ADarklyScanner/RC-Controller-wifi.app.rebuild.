package com.darkly.fpvcar

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Drives the WL Tech FPV car (HD720 camera module). Same protocol as termux/fpv_car.py.
 *
 * Control: UDP to 172.16.11.1:23458, 16 bytes, every 50 ms:
 *   ca 47 d5 00 00 00 00 00 66 [steer] [throttle] [A] [B] [C] [xor] 99
 *   128 = centre. steer < 128 left. throttle > 128 forward.
 *   A = the car's own steering trim (128 + trim). B, C: unused by the stock app.
 *   xor = steer ^ throttle ^ A ^ B ^ C
 */
class CarLink(private val ip: String = CAR_IP) {

    companion object {
        const val CAR_IP = "172.16.11.1"
        const val CTRL_PORT = 23458
        const val LIMIT = 76          // speed 3 (twice the stock app's default +/-38)
        const val OC_LIMIT = 127      // MAX: full range (the stock app's top speed setting)
        const val STEER_LIMIT = 127   // full steering, as the stock app at 100%

        fun packet(steer: Int, thr: Int, a: Int, b: Int, c: Int): ByteArray {
            val x = steer xor thr xor a xor b xor c
            return byteArrayOf(
                0xca.toByte(), 0x47, 0xd5.toByte(), 0, 0, 0, 0, 0, 0x66,
                steer.toByte(), thr.toByte(), a.toByte(), b.toByte(), c.toByte(), x.toByte(), 0x99.toByte()
            )
        }

        fun toByte(v: Double, limit: Int): Int =
            0x80 + (max(-1.0, min(1.0, v)) * limit).roundToInt()
    }

    @Volatile var steer = 0.0
    @Volatile var thr = 0.0
    @Volatile var oc = false
    @Volatile private var until = 0L
    @Volatile var trim = 0
    @Volatile var boost = 0
    @Volatile private var extra: IntArray? = null
    @Volatile private var extraUntil = 0L
    @Volatile private var running = false
    private var thread: Thread? = null

    /** throttle/steer -1..1; seconds <= 0 holds until changed. */
    fun set(throttle: Double, steering: Double, seconds: Double, overclock: Boolean) {
        synchronized(this) {
            thr = throttle; steer = steering; oc = overclock
            until = if (seconds > 0) System.currentTimeMillis() + (seconds * 1000).toLong() else 0L
        }
    }

    fun stop() = set(0.0, 0.0, 0.0, false)

    fun applyTrim(v: Int) { trim = v.coerceIn(-60, 60) }
    fun applyBoost(v: Int) { boost = v.coerceIn(0, 48) }

    /** Test one byte (slot 0-2 = A, B, C); goes back by itself after 3 s unless set again. */
    fun setExtra(slot: Int, value: Int) {
        val e = intArrayOf((0x80 + trim).coerceIn(0, 255), 0, 0)
        e[slot.coerceIn(0, 2)] = value.coerceIn(0, 255)
        extra = e; extraUntil = System.currentTimeMillis() + 3000
    }

    fun clearExtra() { extra = null; extraUntil = 0L }

    fun start() {
        if (running) return
        running = true
        thread = Thread({ loop() }, "car-control").apply { isDaemon = true; start() }
    }

    fun shutdown() { running = false }

    private fun loop() {
        val addr = InetAddress.getByName(ip)
        var sock: DatagramSocket? = null
        while (running) {
            try {
                if (sock == null) sock = DatagramSocket()
                val now = System.currentTimeMillis()
                val s: Double; val t: Double; val o: Boolean
                synchronized(this) {
                    if (until > 0 && now > until) { steer = 0.0; thr = 0.0; oc = false; until = 0L }
                    s = steer; t = thr; o = oc
                }
                val test = extra
                val slots = if (test != null && now < extraUntil) test else {
                    extra = null
                    // extra lock: at full turn, lean the car's trim the same way
                    val side = if (s >= 0.95) 1 else if (s <= -0.95) -1 else 0
                    intArrayOf((0x80 + trim + side * boost).coerceIn(0, 255), 0, 0)
                }
                val p = packet(toByte(s, STEER_LIMIT), toByte(t, if (o) OC_LIMIT else LIMIT), slots[0], slots[1], slots[2])
                sock.send(DatagramPacket(p, p.size, addr, CTRL_PORT))
            } catch (e: Exception) {
                try { sock?.close() } catch (_: Exception) {}
                sock = null
                try { Thread.sleep(500) } catch (_: InterruptedException) {}
            }
            try { Thread.sleep(50) } catch (_: InterruptedException) {}
        }
        try { sock?.close() } catch (_: Exception) {}
    }
}
