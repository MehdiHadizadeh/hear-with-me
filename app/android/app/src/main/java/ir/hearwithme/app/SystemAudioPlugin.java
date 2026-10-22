package ir.hearwithme.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * What only the app can do, exposed to the web page as `Capacitor.Plugins.SystemAudio`.
 *
 * A phone browser cannot hand a page another app's sound. Android 10+ can, to an app
 * the person allows: this plugin asks, then runs {@link CaptureService}, which encodes
 * what is playing as AAC and posts it to the room's screen-off relay — the same
 * endpoint a desktop browser host feeds. No guest and no server can tell the difference.
 *
 * It also keeps a listening guest alive in the background ({@link ListenService}).
 */
@CapacitorPlugin(
    name = "SystemAudio",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class SystemAudioPlugin extends Plugin {

    @Override
    public void load() {
        CaptureService.listener = new CaptureService.Listener() {
            @Override
            public void onLevel(float level) {
                JSObject data = new JSObject();
                data.put("level", level);
                notifyListeners("level", data);
            }

            @Override
            public void onState(String state, String detail) {
                JSObject data = new JSObject();
                data.put("state", state);
                data.put("detail", detail);
                notifyListeners("captureState", data);
            }
        };
    }

    /** Whether this device can share other apps' sound at all (Android 10+). */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q);
        result.put("capturing", CaptureService.running);
        result.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(result);
    }

    /**
     * Start sharing. Needs { origin, roomId, clientId, secret }; resolves once capture
     * is running, rejects with "denied" if the person said no at any step.
     */
    @PluginMethod
    public void startCapture(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Android 10 or later is needed to share other apps' sound", "unsupported");
            return;
        }
        if (call.getString("roomId") == null || call.getString("clientId") == null || call.getString("secret") == null) {
            call.reject("roomId, clientId and secret are required", "bad-arguments");
            return;
        }
        // Playback capture is granted through the microphone permission, even
        // though no microphone is used.
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicrophone");
            return;
        }
        askForNotificationsThenProjection(call);
    }

    @PermissionCallback
    private void afterMicrophone(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Permission to record audio was refused", "denied");
            return;
        }
        askForNotificationsThenProjection(call);
    }

    // The capture runs as a foreground service, whose notification is how the
    // person sees (and stops) it. Asked for, but not required to go on.
    private void askForNotificationsThenProjection(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterNotifications");
            return;
        }
        askForProjection(call);
    }

    @PermissionCallback
    private void afterNotifications(PluginCall call) {
        askForProjection(call);
    }

    private void askForProjection(PluginCall call) {
        MediaProjectionManager manager =
            (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        startActivityForResult(call, manager.createScreenCaptureIntent(), "afterProjection");
    }

    @ActivityCallback
    private void afterProjection(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Sharing was not allowed", "denied");
            return;
        }
        Intent service = new Intent(getContext(), CaptureService.class);
        service.putExtra(CaptureService.EXTRA_RESULT_CODE, result.getResultCode());
        service.putExtra(CaptureService.EXTRA_RESULT_DATA, result.getData());
        service.putExtra(CaptureService.EXTRA_ORIGIN, call.getString("origin", "https://hearwithme.ir"));
        service.putExtra(CaptureService.EXTRA_ROOM, call.getString("roomId"));
        service.putExtra(CaptureService.EXTRA_CLIENT, call.getString("clientId"));
        service.putExtra(CaptureService.EXTRA_SECRET, call.getString("secret"));
        service.putExtra(CaptureService.EXTRA_BITRATE, call.getInt("bitrate", 128000));
        ContextCompat.startForegroundService(getContext(), service);
        JSObject ok = new JSObject();
        ok.put("started", true);
        call.resolve(ok);
    }

    @PluginMethod
    public void stopCapture(PluginCall call) {
        if (CaptureService.running) {
            Intent stop = new Intent(getContext(), CaptureService.class);
            stop.setAction(CaptureService.ACTION_STOP);
            getContext().startService(stop);
        }
        call.resolve();
    }

    /** Uploading costs the host's data, so it pauses while nobody listens. */
    @PluginMethod
    public void setUploading(PluginCall call) {
        CaptureService.uploading = call.getBoolean("on", true);
        call.resolve();
    }

    /** A listening guest: a media notification keeps the process alive when locked. */
    @PluginMethod
    public void keepListening(PluginCall call) {
        boolean on = call.getBoolean("on", false);
        Intent intent = new Intent(getContext(), ListenService.class);
        if (on) {
            intent.putExtra(ListenService.EXTRA_TITLE, call.getString("title", "Hear With Me"));
            ContextCompat.startForegroundService(getContext(), intent);
        } else {
            getContext().stopService(intent);
        }
        call.resolve();
    }
}
