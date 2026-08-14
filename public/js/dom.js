// Every element the room page reaches for, looked up once.
//
// Scattered getElementById calls are how a renamed id turns into a null
// dereference three files away; here a missing element is one obvious hole in
// one object.

const byId = (id) => document.getElementById(id);

export const ui = Object.freeze({
  // header and status
  roomCode: byId('roomCode'),
  connectionPill: byId('connectionPill'),
  connectionText: byId('connectionText'),
  listenerPill: byId('listenerPill'),
  listenerText: byId('listenerText'),
  qualityPill: byId('qualityPill'),
  qualityText: byId('qualityText'),

  // messages
  notice: byId('notice'),
  noticeText: byId('noticeText'),
  noticeClose: byId('noticeClose'),
  toasts: byId('toasts'),

  // invite
  shareRow: document.querySelector('.share-row'),
  shareBtn: byId('shareBtn'),
  copyLinkBtn: byId('copyLinkBtn'),
  qrBtn: byId('qrBtn'),
  qrPanel: byId('qrPanel'),
  qrCode: byId('qrCode'),

  // the dead end
  notFoundCard: byId('notFoundCard'),
  notFoundTitle: byId('notFoundTitle'),
  notFoundSub: byId('notFoundSub'),

  // host
  hostCard: byId('hostCard'),
  hostStage: byId('hostStage'),
  hostBurst: byId('hostBurst'),
  hostTitle: byId('hostTitle'),
  hostStatus: byId('hostStatus'),
  hostMeter: byId('hostMeter'),
  hostElapsed: byId('hostElapsed'),
  hostLiveBox: byId('hostLiveBox'),
  startShareBtn: byId('startShareBtn'),
  switchSourceBtn: byId('switchSourceBtn'),
  stopShareBtn: byId('stopShareBtn'),
  nowPlayingInput: byId('nowPlayingInput'),
  nowPlayingBtn: byId('nowPlayingBtn'),
  qualitySelect: byId('qualitySelect'),
  lockToggle: byId('lockToggle'),
  closeOnLeaveToggle: byId('closeOnLeaveToggle'),
  membersBox: byId('membersBox'),
  memberList: byId('memberList'),

  // guest
  guestCard: byId('guestCard'),
  guestStage: byId('guestStage'),
  guestBurst: byId('guestBurst'),
  guestStatusTitle: byId('guestStatusTitle'),
  guestStatusSub: byId('guestStatusSub'),
  guestMeter: byId('guestMeter'),
  guestElapsed: byId('guestElapsed'),
  guestLiveBox: byId('guestLiveBox'),
  guestNowPlaying: byId('guestNowPlaying'),
  reactionRow: byId('reactionRow'),
  nameInput: byId('nameInput'),
  receiveQuality: byId('receiveQuality'),
  wakeLockRow: byId('wakeLockRow'),
  wakeLockToggle: byId('wakeLockToggle'),
  volumeBar: byId('volumeBar'),
  muteBtn: byId('muteBtn'),
  volumeHint: byId('volumeHint'),
  backgroundHint: byId('backgroundHint'),
  remoteAudio: byId('remoteAudio'),
  enableAudioOverlay: byId('enableAudioOverlay'),
  enableAudioBtn: byId('enableAudioBtn'),
});

// Every connection state gets its own colour, glyph and motion, not just a
// different sentence: "waiting for the host" and "reconnecting" used to look
// identical at a glance, which is exactly when people reload and lose the room.
export const setStage = (el, state) => { if (el) el.dataset.state = state; };

export const show = (el, visible, display = 'block') => {
  if (el) el.style.display = visible ? display : 'none';
};

// Guests are overwhelmingly on a phone, and a few warnings only earn their
// space there.
export const isTouchDevice = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
