package com.darkly.fpvcar

import android.content.Context
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder

/**
 * The app's own little web server, on 127.0.0.1:8765 only (nothing outside the phone can reach it).
 * It serves the controller screen and answers the same commands as the Termux version, so
 * other apps on the phone can drive with /drive and /stop.
 */
class LocalServer(
    private val ctx: Context,
    private val car: CarLink,
    private val video: VideoLink,
    private val media: Media,
) {
    companion object { const val PORT = 8765 }

    private var server: ServerSocket? = null
    @Volatile private var running = false

    fun start() {
        if (running) return
        server = ServerSocket(PORT, 50, InetAddress.getByName("127.0.0.1")).apply { reuseAddress = true }
        running = true
        Thread({
            while (running) {
                try {
                    val s = server!!.accept()
                    Thread({ handle(s) }, "http").apply { isDaemon = true; start() }
                } catch (e: Exception) { if (!running) break }
            }
        }, "http-accept").apply { isDaemon = true; start() }
    }

    fun shutdown() { running = false; try { server?.close() } catch (_: Exception) {} }

    private fun handle(sock: Socket) {
        sock.use { s ->
            try {
                s.soTimeout = 15000
                val inp = BufferedInputStream(s.getInputStream())
                val head = readHead(inp) ?: return
                val lines = head.split("\r\n")
                val parts = lines[0].split(" ")
                if (parts.size < 2) return
                val target = parts[1]
                val headers = HashMap<String, String>()
                for (l in lines.drop(1)) { val i = l.indexOf(':'); if (i > 0) headers[l.substring(0, i).trim().lowercase()] = l.substring(i + 1).trim() }
                val path = target.substringBefore('?')
                val q = HashMap<String, String>()
                target.substringAfter('?', "").split('&').filter { it.contains('=') }.forEach {
                    q[URLDecoder.decode(it.substringBefore('='), "UTF-8")] = URLDecoder.decode(it.substringAfter('='), "UTF-8")
                }
                route(path, q, headers, s.getOutputStream())
            } catch (_: Exception) {}
        }
    }

    private fun readHead(inp: BufferedInputStream): String? {
        val sb = StringBuilder()
        var last4 = 0
        while (sb.length < 16384) {
            val b = inp.read(); if (b < 0) return null
            sb.append(b.toChar())
            last4 = (last4 shl 8) or b
            if (last4 == 0x0d0a0d0a) return sb.toString()
        }
        return null
    }

    private fun d(q: Map<String, String>, k: String, def: Double = 0.0) = q[k]?.toDoubleOrNull() ?: def

    private fun route(path: String, q: Map<String, String>, h: Map<String, String>, out: OutputStream) {
        when (path) {
            "/", "/pad" -> asset(out, "page.html", "text/html; charset=utf-8")
            "/font-400.ttf", "/font-700.ttf" -> asset(out, path.removePrefix("/"), "font/ttf")
            "/icon-192.png" -> asset(out, "icon-192.png", "image/png")
            "/app.js" -> asset(out, "app.js", "text/javascript; charset=utf-8")
            "/drive" -> {
                val ms = d(q, "ms", 1000.0).coerceAtMost(10000.0)
                car.set(d(q, "t"), d(q, "s"), ms / 1000.0, q["oc"] == "1"); text(out, "ok")
            }
            "/stop" -> { car.stop(); car.clearExtra(); text(out, "stopped") }
            "/trim" -> { car.applyTrim(d(q, "v").toInt()); text(out, "ok") }
            "/boost" -> { car.applyBoost(d(q, "v").toInt()); text(out, "ok") }
            "/extra" -> {
                if (q.containsKey("slot")) car.setExtra(d(q, "slot").toInt(), d(q, "v").toInt()) else car.clearExtra()
                text(out, "ok")
            }
            "/status" -> json(out, JSONObject().put("video", video.live).put("busy", video.busy).put("recording", video.recording).put("app", true).toString())
            "/record" -> {
                val name = video.record(q["on"] != "0")
                json(out, JSONObject().put("recording", video.recording).put("file", name ?: JSONObject.NULL).toString())
            }
            "/media/list" -> json(out, media.listJson())
            "/media/delete" -> { media.delete(q["name"] ?: ""); text(out, "ok") }
            else -> {
                if (path.startsWith("/media/file/")) mediaFile(out, URLDecoder.decode(path.removePrefix("/media/file/"), "UTF-8"), h["range"])
                else status(out, 404, "text/plain", "not found".toByteArray())
            }
        }
    }

    private fun asset(out: OutputStream, name: String, type: String) {
        var bytes = try { ctx.assets.open(name).use { it.readBytes() } } catch (e: Exception) { null }
        // the app's own additions (app.js) go after the shared screen, so the Termux / Chrome page stays the same
        if (bytes != null && name == "page.html")
            bytes = String(bytes, Charsets.UTF_8).replace("</body>", "<script src=/app.js></script></body>").toByteArray()
        if (bytes == null) status(out, 404, "text/plain", "not found".toByteArray())
        else status(out, 200, type, bytes, cache = name != "page.html" && name != "app.js")
    }

    private fun text(out: OutputStream, s: String) = status(out, 200, "text/plain", s.toByteArray())
    private fun json(out: OutputStream, s: String) = status(out, 200, "application/json", s.toByteArray())

    private fun status(out: OutputStream, code: Int, type: String, body: ByteArray, cache: Boolean = false) {
        val reason = if (code == 200) "OK" else "Not Found"
        out.write(("HTTP/1.1 $code $reason\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\n" +
            "Cache-Control: ${if (cache) "max-age=3600" else "no-store"}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n").toByteArray())
        out.write(body); out.flush()
    }

    /** Streams a gallery file, with byte ranges so videos can seek. */
    private fun mediaFile(out: OutputStream, name: String, range: String?) {
        val m = media.find(name) ?: return status(out, 404, "text/plain", "not found".toByteArray())
        val size = m.size
        var start = 0L; var end = size - 1; var partial = false
        val r = range?.let { Regex("bytes=(\\d*)-(\\d*)").find(it) }
        if (r != null && (r.groupValues[1].isNotEmpty() || r.groupValues[2].isNotEmpty()) && size > 0) {
            if (r.groupValues[1].isNotEmpty()) { start = r.groupValues[1].toLong(); if (r.groupValues[2].isNotEmpty()) end = r.groupValues[2].toLong() }
            else start = size - r.groupValues[2].toLong()
            end = end.coerceAtMost(size - 1); start = start.coerceIn(0, size - 1); partial = true
        }
        val len = end - start + 1
        val type = if (m.photo) "image/jpeg" else "video/mp4"
        val head = StringBuilder(if (partial) "HTTP/1.1 206 Partial Content\r\n" else "HTTP/1.1 200 OK\r\n")
        head.append("Content-Type: $type\r\nAccept-Ranges: bytes\r\nContent-Length: $len\r\nConnection: close\r\n")
        if (partial) head.append("Content-Range: bytes $start-$end/$size\r\n")
        out.write((head.toString() + "\r\n").toByteArray())
        ctx.contentResolver.openInputStream(m.uri)?.use { ins ->
            var skip = start
            while (skip > 0) { val k = ins.skip(skip); if (k <= 0) break; skip -= k }
            val buf = ByteArray(65536); var left = len
            while (left > 0) {
                val n = ins.read(buf, 0, minOf(buf.size.toLong(), left).toInt()); if (n < 0) break
                out.write(buf, 0, n); left -= n
            }
        }
        out.flush()
    }
}
