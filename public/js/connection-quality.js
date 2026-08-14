// The one indicator that can tell "connected" apart from "connected but
// shredded". Every other signal on the page looks identical in both.
//
// The numbers come from the connection itself (getStats), sampled as deltas —
// the counters are cumulative, so a single reading says nothing about now.

const POLL_MS = 2000;

// Loss and jitter thresholds where the sound audibly changes, not where the
// spec says something is wrong.
const POOR = { loss: 0.07, jitter: 0.09 };
const FAIR = { loss: 0.02, jitter: 0.04 };

function collect(report) {
  const totals = { bytes: 0, packets: 0, lost: 0, jitter: 0, at: 0 };
  report.forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'audio') {
      totals.bytes += r.bytesReceived || 0;
      totals.packets += r.packetsReceived || 0;
      totals.lost += r.packetsLost || 0;
      totals.jitter = Math.max(totals.jitter, r.jitter || 0);
      totals.at = Math.max(totals.at, r.timestamp || 0);
    } else if (r.type === 'outbound-rtp' && r.kind === 'audio') {
      totals.bytes += r.bytesSent || 0;
      totals.packets += r.packetsSent || 0;
      totals.at = Math.max(totals.at, r.timestamp || 0);
    } else if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') {
      // What the far end reports back — the only loss figure a sender has.
      totals.lost += r.packetsLost || 0;
      totals.jitter = Math.max(totals.jitter, r.jitter || 0);
    }
  });
  return totals;
}

function grade(loss, jitter) {
  if (loss > POOR.loss || jitter > POOR.jitter) return { label: 'ضعیف', tone: 'bad' };
  if (loss > FAIR.loss || jitter > FAIR.jitter) return { label: 'متوسط', tone: 'warn' };
  return { label: 'عالی', tone: 'live' };
}

// `connections()` returns whichever peer connections this side currently has:
// one for a guest, one per guest for a host.
export function createConnectionQuality({ pill, text, faDigits, connections }) {
  let timer = null;
  let previous = null;

  function hide() { pill.style.display = 'none'; }

  async function poll() {
    const pcs = connections();
    if (pcs.length === 0) { hide(); return; }

    const totals = { bytes: 0, packets: 0, lost: 0, jitter: 0, at: 0 };
    for (const pc of pcs) {
      let report;
      try { report = await pc.getStats(); } catch (e) { continue; }
      const one = collect(report);
      totals.bytes += one.bytes;
      totals.packets += one.packets;
      totals.lost += one.lost;
      totals.jitter = Math.max(totals.jitter, one.jitter);
      totals.at = Math.max(totals.at, one.at);
    }

    // The counters' own timestamp, not the clock: `getStats()` can take a
    // moment to resolve, and on the first reading after a connection comes up
    // it can take nearly a second. Measuring the gap with performance.now()
    // then credits that byte count to a shorter interval than it covers, and
    // the pill claims a bitrate several times the real one.
    const sample = { ...totals, at: totals.at || performance.now() };
    if (!previous) { previous = sample; return; } // deltas need two readings

    const seconds = (sample.at - previous.at) / 1000;
    const kbps = seconds > 0 ? ((totals.bytes - previous.bytes) * 8) / 1000 / seconds : 0;
    const packets = Math.max(0, totals.packets - previous.packets);
    const lost = Math.max(0, totals.lost - previous.lost);
    const loss = packets + lost > 0 ? lost / (packets + lost) : 0;
    previous = sample;

    const { label, tone } = grade(loss, totals.jitter);
    pill.style.display = '';
    pill.classList.remove('live', 'warn', 'bad');
    pill.classList.add(tone);
    text.textContent = `${label} · ${faDigits(Math.round(kbps))} کیلوبیت`;
  }

  return {
    start() {
      if (timer) return;
      previous = null;
      timer = setInterval(poll, POLL_MS);
      poll();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      previous = null;
      hide();
    },
  };
}
