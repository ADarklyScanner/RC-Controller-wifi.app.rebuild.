package com.darkly.fpvcar

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.SurfaceTexture
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Bundle
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class MainActivity : Activity() {

    private lateinit var car: CarLink
    private lateinit var video: VideoLink
    private lateinit var media: Media
    private lateinit var server: LocalServer
    private lateinit var tex: TextureView
    private lateinit var web: WebView
    private var wifiCallback: ConnectivityManager.NetworkCallback? = null

    // what the page last asked for: fit, zoom, flip, brightness
    @Volatile private var fit = "contain"
    @Volatile private var zoom = 1.0
    @Volatile private var flip = false
    @Volatile private var bright = 1.0

    // ---- PlayStation / any gamepad, in the browser's "standard" button order ----
    private val buttons = DoubleArray(17)
    private val axes = DoubleArray(4)
    @Volatile private var padSeen = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        car = CarLink(); video = VideoLink(this); media = Media(this)
        server = LocalServer(this, car, video, media)
        bindToCarWifi()
        car.start(); video.start()
        // network work is not allowed on the main thread; start it on its own and wait for it
        Thread { try { server.start() } catch (e: Exception) { /* another copy (Termux) holds the port */ } }
            .apply { start(); join(3000) }

        tex = TextureView(this)
        tex.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
                st.setDefaultBufferSize(1280, 720); video.attach(Surface(st)); applyView()
            }
            override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) = applyView()
            override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean { video.detach(); return true }
            override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
        }

        web = WebView(this)
        web.setBackgroundColor(0)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.isFocusable = true
        web.webViewClient = object : WebViewClient() {}
        web.addJavascriptInterface(Bridge(), "CarApp")

        val root = FrameLayout(this)
        root.setBackgroundColor(0xff16011e.toInt())
        root.addView(tex, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        hideBars()

        web.loadUrl("http://127.0.0.1:${LocalServer.PORT}/")
    }

    /** The car's Wi-Fi has no internet, so Android would rather use mobile data. Send our traffic over Wi-Fi. */
    private fun bindToCarWifi() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        val req = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { cm.bindProcessToNetwork(network) }
            override fun onLost(network: Network) { cm.bindProcessToNetwork(null) }
        }
        try { cm.requestNetwork(req, cb); wifiCallback = cb } catch (_: Exception) {}
    }

    private fun hideBars() {
        window.insetsController?.let {
            it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) { super.onWindowFocusChanged(hasFocus); if (hasFocus) hideBars() }

    override fun onPause() { super.onPause(); car.stop() }

    override fun onDestroy() {
        car.stop(); car.shutdown(); video.shutdown(); server.shutdown()
        wifiCallback?.let { try { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(it) } catch (_: Exception) {} }
        web.destroy()
        super.onDestroy()
    }

    /** Fit / fill, digital zoom, flip and brightness, applied to the video surface. */
    private fun applyView() {
        runOnUiThread {
            val vw = tex.width.toFloat(); val vh = tex.height.toFloat()
            if (vw <= 0 || vh <= 0) return@runOnUiThread
            val s = if (fit == "fill") maxOf(vw / 1280f, vh / 720f) else minOf(vw / 1280f, vh / 720f)
            val m = Matrix()
            m.setScale(1280f * s / vw * zoom.toFloat(), 720f * s / vh * zoom.toFloat(), vw / 2, vh / 2)
            if (flip) m.postRotate(180f, vw / 2, vh / 2)
            tex.setTransform(m)
            val b = bright.toFloat(); val c = 1f + (b - 1f) * .25f
            val cm = ColorMatrix(floatArrayOf(
                b * c, 0f, 0f, 0f, 128f * (1 - c),
                0f, b * c, 0f, 0f, 128f * (1 - c),
                0f, 0f, b * c, 0f, 128f * (1 - c),
                0f, 0f, 0f, 1f, 0f))
            tex.setLayerType(View.LAYER_TYPE_HARDWARE, Paint().apply { colorFilter = ColorMatrixColorFilter(cm) })
        }
    }

    /** The newest frame at full 1280x720, untouched by zoom / fit. */
    private fun grabFrame(): Bitmap? {
        val latch = CountDownLatch(1)
        var bmp: Bitmap? = null
        runOnUiThread {
            try {
                val keep = tex.getTransform(null)
                tex.setTransform(Matrix())
                bmp = tex.getBitmap(1280, 720)
                tex.setTransform(keep)
            } catch (_: Exception) {}
            latch.countDown()
        }
        latch.await(2, TimeUnit.SECONDS)
        return bmp
    }

    // ---------------------------------------------------------------- gamepad
    private fun isPad(source: Int) =
        (source and InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD ||
        (source and InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK

    private fun buttonIndex(code: Int) = when (code) {
        KeyEvent.KEYCODE_BUTTON_A -> 0        // Cross
        KeyEvent.KEYCODE_BUTTON_B -> 1        // Circle
        KeyEvent.KEYCODE_BUTTON_X -> 2        // Square
        KeyEvent.KEYCODE_BUTTON_Y -> 3        // Triangle
        KeyEvent.KEYCODE_BUTTON_L1 -> 4
        KeyEvent.KEYCODE_BUTTON_R1 -> 5
        KeyEvent.KEYCODE_BUTTON_L2 -> 6
        KeyEvent.KEYCODE_BUTTON_R2 -> 7
        KeyEvent.KEYCODE_BUTTON_SELECT -> 8
        KeyEvent.KEYCODE_BUTTON_START -> 9
        KeyEvent.KEYCODE_BUTTON_THUMBL -> 10
        KeyEvent.KEYCODE_BUTTON_THUMBR -> 11
        KeyEvent.KEYCODE_DPAD_UP -> 12
        KeyEvent.KEYCODE_DPAD_DOWN -> 13
        KeyEvent.KEYCODE_DPAD_LEFT -> 14
        KeyEvent.KEYCODE_DPAD_RIGHT -> 15
        KeyEvent.KEYCODE_BUTTON_MODE -> 16
        else -> -1
    }

    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        if (isPad(e.source)) {
            val i = buttonIndex(e.keyCode)
            if (i >= 0) {
                padSeen = true
                if (e.action == KeyEvent.ACTION_DOWN) buttons[i] = 1.0 else if (e.action == KeyEvent.ACTION_UP) buttons[i] = 0.0
                return true                                  // keep Circle from acting as Back
            }
        }
        return super.dispatchKeyEvent(e)
    }

    override fun dispatchGenericMotionEvent(e: MotionEvent): Boolean {
        if (isPad(e.source) && e.action == MotionEvent.ACTION_MOVE) {
            padSeen = true
            axes[0] = e.getAxisValue(MotionEvent.AXIS_X).toDouble()
            axes[1] = e.getAxisValue(MotionEvent.AXIS_Y).toDouble()
            axes[2] = e.getAxisValue(MotionEvent.AXIS_Z).toDouble()
            axes[3] = e.getAxisValue(MotionEvent.AXIS_RZ).toDouble()
            val l2 = maxOf(e.getAxisValue(MotionEvent.AXIS_LTRIGGER), e.getAxisValue(MotionEvent.AXIS_BRAKE))
            val r2 = maxOf(e.getAxisValue(MotionEvent.AXIS_RTRIGGER), e.getAxisValue(MotionEvent.AXIS_GAS))
            buttons[6] = l2.toDouble(); buttons[7] = r2.toDouble()
            val hx = e.getAxisValue(MotionEvent.AXIS_HAT_X); val hy = e.getAxisValue(MotionEvent.AXIS_HAT_Y)
            if (hx != 0f || hy != 0f || buttons[12] + buttons[13] + buttons[14] + buttons[15] > 0) {
                buttons[14] = if (hx < -0.5f) 1.0 else 0.0; buttons[15] = if (hx > 0.5f) 1.0 else 0.0
                buttons[12] = if (hy < -0.5f) 1.0 else 0.0; buttons[13] = if (hy > 0.5f) 1.0 else 0.0
            }
            return true
        }
        return super.dispatchGenericMotionEvent(e)
    }

    private fun padConnected(): Boolean {
        for (id in InputDevice.getDeviceIds()) {
            val d = InputDevice.getDevice(id) ?: continue
            if (!d.isVirtual && isPad(d.sources)) return true
        }
        return false
    }

    // ---------------------------------------------------------------- what the page can call
    inner class Bridge {
        @JavascriptInterface
        fun view(f: String, z: Double, fl: Int, b: Double) { fit = f; zoom = z; flip = fl == 1; bright = b; applyView() }

        @JavascriptInterface
        fun photo(fl: Int, stamp: Int): String {
            if (!video.live) return ""
            val bmp = grabFrame() ?: return ""
            return media.savePhoto(bmp, fl == 1, stamp == 1) ?: ""
        }

        @JavascriptInterface
        fun share(name: String) { runOnUiThread { try { media.share(name) } catch (_: Exception) {} } }

        /** Same shape as the browser's Gamepad object, or "null" with no controller. */
        @JavascriptInterface
        fun pad(): String {
            if (!padSeen && !padConnected()) return "null"
            val b = JSONArray()
            for (v in buttons) b.put(JSONObject().put("value", v).put("pressed", v > 0.5))
            val a = JSONArray(); for (v in axes) a.put(v)
            return JSONObject().put("buttons", b).put("axes", a).toString()
        }
    }
}
