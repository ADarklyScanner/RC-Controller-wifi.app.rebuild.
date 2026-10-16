package com.darkly.fpvcar

import android.content.ContentValues
import android.content.Context
import android.media.MediaCodec
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.view.Surface
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TreeMap

/**
 * The camera stream. After the hello the camera sends H.264 (1280x720, ~25 fps) to UDP
 * port 1234, cut into 1440-byte pieces, each with a 32-byte header:
 *   0 c6 6c a5 5a magic | 4 u32 frame size | 8 u32 frame number | 20 u16 piece count
 *   22 u16 piece index | 24 u32 offset in frame | 28 u32 piece length   (little-endian)
 * A finished frame is plain Annex-B H.264; it goes straight to the phone's hardware decoder.
 */
class VideoLink(private val ctx: Context, private val ip: String = CarLink.CAR_IP) {

    companion object {
        const val VIDEO_PORT = 1234
        const val HELLO_PORT = 23459
        val HELLO = listOf(hex("a88a210006000000010000000000"), hex("a88a200008000000010002000000d204"))
        fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        const val ALBUM = "FPV Car"
    }

    @Volatile var lastFrame = 0L
    @Volatile var busy = false                   // another controller (Termux, Nessari) holds port 1234
    @Volatile private var running = false
    @Volatile private var gen = 0                // a restart retires the old threads
    @Volatile private var videoSock: DatagramSocket? = null

    // ---- decoder ----
    private val decLock = Object()
    private var surface: Surface? = null
    private var codec: MediaCodec? = null
    @Volatile private var needKey = true
    private val t0 = System.nanoTime()

    // ---- recorder ----
    private val recLock = Object()
    private var muxer: MediaMuxer? = null
    private var muxFd: ParcelFileDescriptor? = null
    private var recUri: Uri? = null
    private var recName: String? = null
    private var recTrack = -1
    private var recFirstUs = -1L
    private var recLastUs = -1L
    @Volatile var recording = false

    val live get() = System.currentTimeMillis() - lastFrame < 2000

    fun start() {
        if (running) return
        running = true; needKey = true
        val my = ++gen
        Thread({ receive(my) }, "car-video").apply { isDaemon = true; start() }
        Thread({ keepalive(my) }, "car-hello").apply { isDaemon = true; start() }
    }

    /** Let go of the camera: stop the hello and free port 1234 at once, so another controller
     *  (the Termux version, Nessari) gets the picture while this app is in the background. */
    fun shutdown() {
        running = false; gen++
        record(false)
        try { videoSock?.close() } catch (_: Exception) {}
        videoSock = null; lastFrame = 0L; busy = false
    }

    // ---------------------------------------------------------------- network
    private fun keepalive(my: Int) {
        val addr = InetAddress.getByName(ip)
        var s: DatagramSocket? = null
        while (running && my == gen) {
            try {
                if (s == null) {
                    s = try { DatagramSocket(null).apply { reuseAddress = true; bind(InetSocketAddress(HELLO_PORT)) } }
                        catch (e: Exception) { DatagramSocket() }
                    s!!.soTimeout = 300
                }
                for (h in HELLO) {
                    s!!.send(DatagramPacket(h, h.size, addr, HELLO_PORT))
                    try { s.receive(DatagramPacket(ByteArray(64), 64)) } catch (_: Exception) {}
                }
            } catch (e: Exception) {
                try { s?.close() } catch (_: Exception) {}
                s = null
            }
            try { Thread.sleep(3000) } catch (_: InterruptedException) {}
        }
        try { s?.close() } catch (_: Exception) {}
    }

    private class Frame(val size: Int, val count: Int) { val parts = TreeMap<Int, ByteArray>() }

    private fun receive(my: Int) {
        var sock: DatagramSocket? = null
        val buf = ByteArray(2048)
        val frames = HashMap<Long, Frame>()
        var newest = -1L
        var lost = true
        while (running && my == gen) {
            try {
                if (sock == null) {
                    // no address sharing: if another controller holds the port, wait for it instead of
                    // splitting the picture with it (the car's stream only reaches one of them)
                    val fresh = DatagramSocket(null)
                    try {
                        fresh.receiveBufferSize = 4 shl 20; fresh.soTimeout = 1000
                        fresh.bind(InetSocketAddress(VIDEO_PORT))
                    } catch (e: Exception) { fresh.close(); throw e }
                    sock = fresh
                    videoSock = sock; busy = false
                    if (my != gen) { fresh.close(); break }
                }
                val pk = DatagramPacket(buf, buf.size)
                try { sock!!.receive(pk) } catch (_: java.net.SocketTimeoutException) { continue }
                val n = pk.length
                if (n < 32 || buf[0] != 0xc6.toByte() || buf[1] != 0x6c.toByte() || buf[2] != 0xa5.toByte() || buf[3] != 0x5a.toByte()) continue
                val bb = ByteBuffer.wrap(buf, 0, n).order(ByteOrder.LITTLE_ENDIAN)
                val size = bb.getInt(4)
                val fno = bb.getInt(8).toLong() and 0xffffffffL
                val count = bb.getShort(20).toInt() and 0xffff
                val off = bb.getInt(24)
                val len = bb.getInt(28)
                if (len <= 0 || 32 + len > n || size <= 0 || size > 2_000_000) continue
                if (newest >= 0 && fno + 100 < newest) { frames.clear(); newest = fno; lost = true }   // camera restarted
                val f = frames.getOrPut(fno) { Frame(size, count) }
                f.parts[off] = buf.copyOfRange(32, 32 + len)
                if (fno > newest) {
                    val old = frames.keys.filter { it < fno - 2 }
                    if (old.isNotEmpty()) { old.forEach { frames.remove(it) }; lost = true }
                    newest = fno
                }
                if (f.parts.size == f.count) {
                    frames.remove(fno)
                    val out = ByteArray(f.size)
                    var pos = 0; var ok = true
                    for ((o, p) in f.parts) { if (o != pos || pos + p.size > out.size) { ok = false; break }; System.arraycopy(p, 0, out, pos, p.size); pos += p.size }
                    if (!ok || pos != f.size) { lost = true; continue }
                    val key = isKey(out)
                    if (lost && !key) continue
                    lost = false
                    onFrame(out, key)
                }
            } catch (e: Exception) {
                if (sock == null && e is java.net.BindException) busy = true
                try { sock?.close() } catch (_: Exception) {}
                sock = null
                try { Thread.sleep(500) } catch (_: InterruptedException) {}
            }
        }
        try { sock?.close() } catch (_: Exception) {}
    }

    private fun nals(b: ByteArray): List<Pair<Int, Int>> {   // (start of NAL header, type)
        val r = ArrayList<Pair<Int, Int>>()
        var i = 0
        while (i + 4 < b.size) {
            if (b[i] == 0.toByte() && b[i + 1] == 0.toByte() && b[i + 2] == 0.toByte() && b[i + 3] == 1.toByte()) {
                r.add(Pair(i + 4, b[i + 4].toInt() and 31)); i += 4
            } else i++
        }
        return r
    }

    private fun isKey(b: ByteArray) = nals(b).any { it.second == 5 || it.second == 7 }

    /** SPS and PPS with their start codes, for the decoder's and the muxer's setup. */
    private fun paramSets(b: ByteArray): Pair<ByteArray, ByteArray>? {
        val ns = nals(b)
        var sps: ByteArray? = null; var pps: ByteArray? = null
        for ((k, nal) in ns.withIndex()) {
            val end = if (k + 1 < ns.size) ns[k + 1].first - 4 else b.size
            val start = nal.first - 4
            if (nal.second == 7) sps = b.copyOfRange(start, end)
            if (nal.second == 8) pps = b.copyOfRange(start, end)
        }
        return if (sps != null && pps != null) Pair(sps, pps) else null
    }

    private fun onFrame(frame: ByteArray, key: Boolean) {
        lastFrame = System.currentTimeMillis()
        val ptsUs = (System.nanoTime() - t0) / 1000
        decode(frame, key, ptsUs)
        writeRecording(frame, key, ptsUs)
    }

    // ---------------------------------------------------------------- decoding
    fun attach(s: Surface) { synchronized(decLock) { releaseCodec(); surface = s; needKey = true } }

    fun detach() { synchronized(decLock) { releaseCodec(); surface = null } }

    private fun releaseCodec() {
        try { codec?.stop() } catch (_: Exception) {}
        try { codec?.release() } catch (_: Exception) {}
        codec = null
    }

    private fun decode(frame: ByteArray, key: Boolean, ptsUs: Long) {
        synchronized(decLock) {
            val s = surface ?: return
            if (needKey && !key) return
            try {
                if (codec == null) {
                    val ps = paramSets(frame) ?: return
                    val fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, 1280, 720)
                    fmt.setByteBuffer("csd-0", ByteBuffer.wrap(ps.first))
                    fmt.setByteBuffer("csd-1", ByteBuffer.wrap(ps.second))
                    if (Build.VERSION.SDK_INT >= 30) fmt.setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                    fmt.setInteger(MediaFormat.KEY_PRIORITY, 0)
                    val c = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
                    c.configure(fmt, s, null, 0)
                    c.start()
                    codec = c
                }
                val c = codec!!
                val idx = c.dequeueInputBuffer(5_000)
                if (idx < 0) { needKey = true; drain(c); return }       // decoder behind: skip to the next keyframe
                val ib = c.getInputBuffer(idx)!!
                ib.clear()
                if (frame.size > ib.capacity()) { c.queueInputBuffer(idx, 0, 0, ptsUs, 0); needKey = true; return }
                ib.put(frame)
                c.queueInputBuffer(idx, 0, frame.size, ptsUs, if (key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                needKey = false
                drain(c)
            } catch (e: Exception) {
                releaseCodec(); needKey = true
            }
        }
    }

    private val info = MediaCodec.BufferInfo()
    private fun drain(c: MediaCodec) {
        while (true) {
            val o = c.dequeueOutputBuffer(info, 0)
            if (o >= 0) c.releaseOutputBuffer(o, true)       // render the newest straight away
            else if (o == MediaCodec.INFO_TRY_AGAIN_LATER) break
            // format / buffers changed: just loop again
        }
    }

    // ---------------------------------------------------------------- recording
    /** Start or stop. Returns the file's name. The clip goes into Movies/FPV Car (the phone's Gallery). */
    fun record(on: Boolean): String? {
        synchronized(recLock) {
            if (on && !recording) {
                val name = SimpleDateFormat("'car_'yyyyMMdd_HHmmss", Locale.US).format(Date()) + ".mp4"
                val v = ContentValues().apply {
                    put(MediaStore.Video.Media.DISPLAY_NAME, name)
                    put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                    put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/$ALBUM")
                    put(MediaStore.Video.Media.DATE_TAKEN, System.currentTimeMillis())
                    put(MediaStore.Video.Media.IS_PENDING, 1)
                }
                val uri = ctx.contentResolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, v) ?: return null
                recUri = uri; recName = name; recTrack = -1; recFirstUs = -1; recLastUs = -1; muxer = null
                recording = true
                return name
            }
            if (!on && recording) {
                recording = false
                val name = recName
                var ok = false
                try { muxer?.stop(); ok = recTrack >= 0 } catch (_: Exception) {}
                try { muxer?.release() } catch (_: Exception) {}
                try { muxFd?.close() } catch (_: Exception) {}
                muxer = null; muxFd = null
                val uri = recUri
                if (uri != null) {
                    if (ok) ctx.contentResolver.update(uri, ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }, null, null)
                    else ctx.contentResolver.delete(uri, null, null)
                }
                recUri = null
                return if (ok) name else null
            }
            return recName
        }
    }

    private fun writeRecording(frame: ByteArray, key: Boolean, ptsUs: Long) {
        if (!recording) return
        synchronized(recLock) {
            if (!recording) return
            try {
                if (muxer == null) {
                    if (!key) return                                   // a clip starts on a keyframe
                    val ps = paramSets(frame) ?: return
                    val fd = ctx.contentResolver.openFileDescriptor(recUri!!, "rw") ?: return
                    val m = MediaMuxer(fd.fileDescriptor, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                    val fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, 1280, 720)
                    fmt.setByteBuffer("csd-0", ByteBuffer.wrap(ps.first))
                    fmt.setByteBuffer("csd-1", ByteBuffer.wrap(ps.second))
                    recTrack = m.addTrack(fmt)
                    m.start()
                    muxer = m; muxFd = fd; recFirstUs = ptsUs
                }
                var t = ptsUs - recFirstUs
                if (t <= recLastUs) t = recLastUs + 1                  // timestamps must keep rising
                recLastUs = t
                val bi = MediaCodec.BufferInfo().apply {
                    offset = 0; size = frame.size; presentationTimeUs = t
                    flags = if (key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
                }
                muxer!!.writeSampleData(recTrack, ByteBuffer.wrap(frame), bi)
            } catch (e: Exception) {
                // keep going; a broken frame is skipped
            }
        }
    }
}
