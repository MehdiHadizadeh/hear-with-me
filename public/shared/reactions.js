// The guest's back channel, defined once for both sides.
//
// The server validates against REACTION_KINDS; the browser renders the rest of
// each entry. Splitting them across two files is how the two drift apart, and
// a reaction the server rejects but the UI offers is a button that does
// nothing.
//
// Deliberately NOT "louder"/"quieter": the guest has a volume slider and their
// phone's own buttons, so asking the host to change the volume asks for
// something they already have. What they cannot fix themselves is a source
// that is quiet at full volume, a stream breaking up, silence, or not knowing
// what this track is.
//
// `cheer: true` means it needs no reply — the UI floats it over the stage and
// forgets it. Everything else is a report the host must act on, so it carries
// the `todo` that says what to do about it.
export const REACTIONS = {
  love: {
    emoji: '❤',
    text: 'دوستش داره',
    cheer: true,
  },
  fire: {
    emoji: '🔥',
    text: 'عالیه',
    cheer: true,
  },
  whatsthis: {
    emoji: '❓',
    text: 'می‌پرسه این آهنگ چیه',
    todo: 'پایین همین صفحه، تو کادر «داری چی گوش می‌دی؟» بنویسش.',
  },
  quiet: {
    emoji: '🔈',
    text: 'می‌گه صدا خیلی کمه',
    todo: 'صدای خودِ منبع (تب یا اپ) رو ببر بالاتر — صدای گوشیش دست خودشه.',
  },
  broken: {
    emoji: '📶',
    text: 'می‌گه صدا بریده‌بریده می‌رسه',
    todo: 'کیفیت رو بذار روی «معمولی» یا «کم‌مصرف».',
  },
  nosound: {
    emoji: '🔇',
    text: 'می‌گه هیچ صدایی نمی‌رسه',
    alert: true,
    todo: 'میله‌های خودت تکون می‌خورن؟ اگه نه، تیک «Share tab audio» زده نشده.',
  },
};

export const REACTION_KINDS = Object.keys(REACTIONS);
