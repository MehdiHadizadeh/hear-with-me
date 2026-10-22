// What a room link says about itself when it is pasted into Telegram or
// WhatsApp. Shared by both servers, which fill it into the room page's Open
// Graph tags.
//
// The preview is the first thing a guest ever sees of this product, and the
// one thing that makes them tap: who is inviting them, and that it is live.
// Nothing sentimental — a name, a state, and what to do.

export function roomPreview(info) {
  const name = info && info.hostName;
  const who = name || 'یکی';
  if (!info) {
    return {
      title: 'Hear With Me — هرچی می‌شنوی، اونم بشنوه',
      description: 'لینک رو باز کن تا همون لحظه همون صدا رو بشنوی. بدون نصب، بدون حساب.',
    };
  }
  if (info.isSharing) {
    return {
      title: `${who} داره زنده پخش می‌کنه`,
      description: info.nowPlaying
        ? `در حال پخش: ${info.nowPlaying} · بزن و همون لحظه بشنو`
        : 'بزن و همون لحظه همون صدا رو بشنو. بدون نصب، بدون حساب.',
    };
  }
  return {
    title: `${who} می‌خواد یه چیزی برات پخش کنه`,
    description: 'لینک رو باز کن؛ وقتی پخش شروع بشه، همون‌جا می‌شنوی. بدون نصب، بدون حساب.',
  };
}
