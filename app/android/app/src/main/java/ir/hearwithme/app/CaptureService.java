package ir.hearwithme.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;

/**
 * The phone as a host: capturing what other apps play and feeding the room's
 * screen-off relay with it, exactly as a desktop browser host does.
 *
 *   AudioPlaybackCapture → PCM 48kHz stereo → MediaCodec AAC-LC → ADTS frames
 *   → POST /api/rooms/{room}/relay?gen=…&seq=… a quarter second at a time
 *
 * ADTS because every phone plays an ADTS stream and a listener can start at any
 * frame (see public/shared/relay-framing.js on the web side).
 */
public class CaptureService extends Service {

    public interface Listener {
        void onLevel(float level);
        void onState(String state, String detail);
    }

    static volatile Listener listener;
    static volatile boolean running = false;
    // Paused while nobody listens through the relay: the host's data is not free.
    static volatile boolean uploading = true;

    static final String ACTION_STOP = "ir.hearwithme.app.STOP_CAPTURE";
    static final String EXTRA_RESULT_CODE = "resultCode";
    static final String EXTRA_RESULT_DATA = "resultData";
    static final String EXTRA_ORIGIN = "origin";
    static final String EXTRA_ROOM = "roomId";
    static final String EXTRA_CLIENT = "clientId";
    static final String EXTRA_SECRET = "secret";
    static final String EXTRA_BITRATE = "bitrate";

    private static final String CHANNEL = "capture";
    private static final int NOTIFICATION_ID = 7001;
    private static final int SAMPLE_RATE = 48000;
    private static final int CHANNELS = 2;
    private static final int FRAMES_PER_UPLOAD = 12;      // 12 × 21.3ms ≈ a quarter second
    private static final float SILENCE = 0.01f;           // about -40 dBFS
    private static final long SILENT_AFTER_MS = 6000;
    private static final long LEVEL_EVERY_MS = 100;
    private static final int MAX_QUEUED_UPLOADS = 40;     // ~10 s; past that, drop rather than lag

    private MediaProjection projection;
    private AudioRecord record;
    private MediaCodec codec;
    private Thread worker;
    private volatile boolean stopping = false;
    private ThreadPoolExecutor uploader;
    private PowerManager.WakeLock wakeLock;

    private String origin;
    private String roomId;
    private String clientId;
    private String secret;
    private int bitrate;
    private long generation;
    private int seq;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            shutDown("stopped-by-user");
            return START_NOT_STICKY;
        }
        if (running) return START_NOT_STICKY;

        origin = intent.getStringExtra(EXTRA_ORIGIN);
        roomId = intent.getStringExtra(EXTRA_ROOM);
        clientId = intent.getStringExtra(EXTRA_CLIENT);
        secret = intent.getStringExtra(EXTRA_SECRET);
        bitrate = intent.getIntExtra(EXTRA_BITRATE, 128000);

        // The foreground service has to exist, with the projection type, before
        // the projection may be taken (Android 14+).
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= 30) {
            startForeground(NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        try {
            MediaProjectionManager manager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            Intent data = intent.getParcelableExtra(EXTRA_RESULT_DATA);
            projection = manager.getMediaProjection(intent.getIntExtra(EXTRA_RESULT_CODE, 0), data);
            // Required before capturing on Android 14+, and how we learn that the
            // system (or the person, from the status bar) ended the share.
            projection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() { shutDown("projection-ended"); }
            }, new Handler(Looper.getMainLooper()));
            startCapture();
            running = true;
            emitState("capturing", "");
        } catch (Exception e) {
            emitState("error", e.getClass().getSimpleName() + ": " + e.getMessage());
            shutDown("error");
        }
        return START_NOT_STICKY;
    }

    private void startCapture() throws Exception {
        AudioPlaybackCaptureConfiguration config = new AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .build();
        AudioFormat format = new AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
            .build();
        int minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT);
        record = new AudioRecord.Builder()
            .setAudioFormat(format)
            .setBufferSizeInBytes(Math.max(minBuffer * 2, 16384))
            .setAudioPlaybackCaptureConfig(config)
            .build();

        MediaFormat aac = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, CHANNELS);
        aac.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        aac.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
        aac.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
        codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        codec.configure(aac, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        codec.start();

        uploader = new ThreadPoolExecutor(1, 1, 0L, java.util.concurrent.TimeUnit.MILLISECONDS,
            new java.util.concurrent.LinkedBlockingQueue<>());
        generation = System.currentTimeMillis();
        seq = 0;

        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hearwithme:capture");
        wakeLock.acquire(6 * 60 * 60 * 1000L);

        record.startRecording();
        stopping = false;
        worker = new Thread(this::loop, "hwm-capture");
        worker.start();
    }

    private void loop() {
        byte[] pcm = new byte[4096];
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        ByteArrayOutputStream batch = new ByteArrayOutputStream();
        int framesInBatch = 0;
        long presentationUs = 0;
        long lastLevelAt = 0;
        float windowPeak = 0;
        long loudAt = System.currentTimeMillis();
        boolean reportedSilent = false;

        while (!stopping) {
            int read = record.read(pcm, 0, pcm.length);
            if (read <= 0) continue;

            // The level, read from the real samples: the page draws its meter
            // from this and decides "no sound" from it.
            float peak = 0;
            for (int i = 0; i + 1 < read; i += 2) {
                short sample = (short) ((pcm[i] & 0xff) | (pcm[i + 1] << 8));
                float v = Math.abs(sample) / 32768f;
                if (v > peak) peak = v;
            }
            windowPeak = Math.max(windowPeak, peak);
            long now = System.currentTimeMillis();
            if (now - lastLevelAt >= LEVEL_EVERY_MS) {
                Listener l = listener;
                if (l != null) l.onLevel(windowPeak);
                windowPeak = 0;
                lastLevelAt = now;
            }
            if (peak > SILENCE) {
                loudAt = now;
                if (reportedSilent) { reportedSilent = false; emitState("capturing", ""); }
            } else if (!reportedSilent && now - loudAt > SILENT_AFTER_MS) {
                // Usually an app that does not allow its sound to be shared.
                reportedSilent = true;
                emitState("silent", "");
            }

            int offset = 0;
            while (offset < read && !stopping) {
                int index = codec.dequeueInputBuffer(10000);
                if (index < 0) break;
                ByteBuffer in = codec.getInputBuffer(index);
                if (in == null) break;
                in.clear();
                int length = Math.min(in.remaining(), read - offset);
                in.put(pcm, offset, length);
                codec.queueInputBuffer(index, 0, length, presentationUs, 0);
                presentationUs += length * 1_000_000L / (SAMPLE_RATE * CHANNELS * 2);
                offset += length;
            }

            int out;
            while ((out = codec.dequeueOutputBuffer(info, 0)) >= 0) {
                if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0) {
                    ByteBuffer encoded = codec.getOutputBuffer(out);
                    if (encoded != null) {
                        byte[] frame = new byte[info.size + 7];
                        writeAdtsHeader(frame, frame.length);
                        encoded.position(info.offset);
                        encoded.get(frame, 7, info.size);
                        batch.write(frame, 0, frame.length);
                        framesInBatch++;
                        if (framesInBatch >= FRAMES_PER_UPLOAD) {
                            upload(batch.toByteArray());
                            batch.reset();
                            framesInBatch = 0;
                        }
                    }
                }
                codec.releaseOutputBuffer(out, false);
            }
        }
    }

    // ADTS: MPEG-4 AAC-LC, 48kHz (index 3), two channels, no CRC.
    private static void writeAdtsHeader(byte[] packet, int length) {
        int profile = 2;     // AAC LC
        int frequency = 3;   // 48000
        int channels = 2;
        packet[0] = (byte) 0xFF;
        packet[1] = (byte) 0xF1;
        packet[2] = (byte) (((profile - 1) << 6) + (frequency << 2) + (channels >> 2));
        packet[3] = (byte) (((channels & 3) << 6) + (length >> 11));
        packet[4] = (byte) ((length & 0x7FF) >> 3);
        packet[5] = (byte) (((length & 7) << 5) + 0x1F);
        packet[6] = (byte) 0xFC;
    }

    private void upload(byte[] bytes) {
        if (!uploading) return;
        final long gen = generation;
        final int s = seq++;
        // Uploads overtaking each other are reordered by the server; a backlog
        // this long means the network cannot keep up, and late audio is worth
        // less than a gap.
        if (uploader.getQueue().size() > MAX_QUEUED_UPLOADS) return;
        uploader.execute(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(origin + "/api/rooms/" + roomId + "/relay?gen=" + gen + "&seq=" + s);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(8000);
                connection.setFixedLengthStreamingMode(bytes.length);
                connection.setRequestProperty("Content-Type", "application/octet-stream");
                connection.setRequestProperty("X-HWM-Client", clientId);
                connection.setRequestProperty("X-HWM-Secret", secret);
                try (OutputStream body = connection.getOutputStream()) { body.write(bytes); }
                int status = connection.getResponseCode();
                InputStream answer = status < 400 ? connection.getInputStream() : connection.getErrorStream();
                if (answer != null) { while (answer.read() != -1) { /* drain */ } answer.close(); }
                if (status == 403 || status == 404) emitState("error", "relay-refused-" + status);
            } catch (Exception e) {
                // A dropped upload is a short gap for the listeners, nothing more.
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void emitState(String state, String detail) {
        Listener l = listener;
        if (l != null) l.onState(state, detail);
    }

    private synchronized void shutDown(String reason) {
        if (stopping && !running) { stopSelf(); return; }
        stopping = true;
        if (worker != null) {
            try { worker.join(1500); } catch (InterruptedException ignored) { }
            worker = null;
        }
        try { if (record != null) { record.stop(); record.release(); } } catch (Exception ignored) { }
        record = null;
        try { if (codec != null) { codec.stop(); codec.release(); } } catch (Exception ignored) { }
        codec = null;
        try { if (projection != null) projection.stop(); } catch (Exception ignored) { }
        projection = null;
        if (uploader != null) uploader.shutdown();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        boolean wasRunning = running;
        running = false;
        if (wasRunning) emitState("stopped", reason);
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE); else stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        shutDown("destroyed");
        super.onDestroy();
    }

    private Notification buildNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "پخش برای اتاق", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("وقتی صدای گوشی رو برای یه اتاق پخش می‌کنی");
            manager.createNotificationChannel(channel);
        }
        int immutable = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent open = PendingIntent.getActivity(this, 0,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), immutable);
        PendingIntent stop = PendingIntent.getService(this, 1,
            new Intent(this, CaptureService.class).setAction(ACTION_STOP), immutable);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_wave)
            .setContentTitle("داری پخش می‌کنی")
            .setContentText("هرچی رو گوشیت پخش بشه، مهمان‌های اتاق می‌شنون.")
            .setContentIntent(open)
            .addAction(0, "توقف پخش", stop)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
    }
}
