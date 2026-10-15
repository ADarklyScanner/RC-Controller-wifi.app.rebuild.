package com.darkly.fpvcar

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.net.Uri
import android.provider.MediaStore
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Photos and videos live in the phone's own Gallery: Pictures/FPV Car and Movies/FPV Car. */
class Media(private val ctx: Context) {

    data class Item(val name: String, val uri: Uri, val photo: Boolean, val size: Long, val time: Long)

    private val stampFont: Typeface? by lazy {
        try { Typeface.createFromAsset(ctx.assets, "font-700.ttf") } catch (e: Exception) { null }
    }

    /** Saves a frame as a JPEG. Returns the file name, or null. */
    fun savePhoto(frame: Bitmap, flip: Boolean, stamp: Boolean): String? {
        var bmp = frame
        if (flip) bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(180f) }, true)
        if (stamp) {
            if (!bmp.isMutable) bmp = bmp.copy(Bitmap.Config.ARGB_8888, true)
            drawStamp(bmp, SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date()))
        }
        var name = SimpleDateFormat("'car_'yyyyMMdd_HHmmss", Locale.US).format(Date())
        if (find(name + ".jpg") != null) {                       // two photos in the same second
            var k = 2; while (find("${name}_$k.jpg") != null) k++; name = "${name}_$k"
        }
        name += ".jpg"
        val v = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/${VideoLink.ALBUM}")
            put(MediaStore.Images.Media.DATE_TAKEN, System.currentTimeMillis())
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = ctx.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v) ?: return null
        return try {
            ctx.contentResolver.openOutputStream(uri)!!.use { bmp.compress(Bitmap.CompressFormat.JPEG, 92, it) }
            ctx.contentResolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
            name
        } catch (e: Exception) {
            ctx.contentResolver.delete(uri, null, null); null
        }
    }

    /** Date and time in the bottom-right corner, in the custom font if the build has one, on a dark box. */
    private fun drawStamp(bmp: Bitmap, text: String) {
        val c = Canvas(bmp)
        val p = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE; textSize = bmp.height * 0.042f; typeface = stampFont ?: Typeface.DEFAULT_BOLD
        }
        val w = p.measureText(text)
        val pad = bmp.height * 0.012f
        val x = bmp.width - w - bmp.width * 0.019f
        val y = bmp.height - bmp.height * 0.03f
        val box = Paint().apply { color = Color.argb(140, 22, 1, 30) }
        c.drawRoundRect(RectF(x - pad, y + p.ascent() - pad, x + w + pad, y + p.descent() + pad), pad, pad, box)
        c.drawText(text, x, y, p)
    }

    fun list(): List<Item> {
        val out = ArrayList<Item>()
        query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "Pictures/${VideoLink.ALBUM}%", true, out)
        query(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, "Movies/${VideoLink.ALBUM}%", false, out)
        out.sortByDescending { it.time }
        return out
    }

    private fun query(base: Uri, path: String, photo: Boolean, out: MutableList<Item>) {
        val cols = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_ADDED)
        try {
            ctx.contentResolver.query(base, cols,
                "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ? AND ${MediaStore.MediaColumns.IS_PENDING} = 0",
                arrayOf(path), null)?.use { c ->
                while (c.moveToNext()) {
                    val name = c.getString(1) ?: continue
                    out.add(Item(name, ContentUris.withAppendedId(base, c.getLong(0)), photo, c.getLong(2), c.getLong(3)))
                }
            }
        } catch (_: Exception) {}
    }

    fun find(name: String): Item? = list().firstOrNull { it.name == name }

    fun listJson(): String {
        val a = JSONArray()
        for (m in list()) a.put(JSONObject().put("name", m.name).put("type", if (m.photo) "photo" else "video")
            .put("size", m.size).put("time", m.time))
        return a.toString()
    }

    fun delete(name: String): Boolean {
        val m = find(name) ?: return false
        return try { ctx.contentResolver.delete(m.uri, null, null) > 0 } catch (e: Exception) { false }
    }

    fun share(name: String) {
        val m = find(name) ?: return
        val send = Intent(Intent.ACTION_SEND).apply {
            type = if (m.photo) "image/jpeg" else "video/mp4"
            putExtra(Intent.EXTRA_STREAM, m.uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        ctx.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
