// Every element the room page reaches for, looked up once.
//
// Scattered getElementById calls are how a renamed id turns into a null
// dereference three files away; here a missing element is one obvious hole in
// one object.

const byId = (id) => document.getElementById(id);

export const ui = Object.freeze({
  // header and status
  roomShell: byId('roomShell'),
  codePlate: document.querySelector('.code-plate'),
  markVoice: document.querySelector('.room-head .mark-voice'),
  statusRow: byId('statusRow'),
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
  alertLive: byId('alertLive'),
  footerNote: byId('footerNote'),

  // invite
  shareRow: document.querySelector('.share-row'),
  shareBtn: byId('shareBtn'),
  copyLinkBtn: byId('copyLinkBtn'),
  leaveBtn: byId('leaveBtn'),
  leaveDialog: byId('leaveDialog'),
  leaveDialogTitle: byId('leaveDialogTitle'),
  leaveDialogSub: byId('leaveDialogSub'),
  leaveConfirmBtn: byId('leaveConfirmBtn'),
  leaveStayBtn: byId('leaveStayBtn'),
  qrBtn: byId('qrBtn'),
  qrPanel: byId('qrPanel'),
  qrCode: byId('qrCode'),

  // the dead end
  notFoundCard: byId('notFoundCard'),
  notFoundTitle: byId('notFoundTitle'),
  notFoundSub: byId('notFoundSub'),
  notFoundActions: byId('notFoundActions'),
  notFoundCta: byId('notFoundCta'),

  // host
  hostCard: byId('hostCard'),
  hostStage: byId('hostStage'),
  hostBurst: byId('hostBurst'),
  hostTitle: byId('hostTitle'),
  hostStatus: byId('hostStatus'),
  hostMeter: byId('hostMeter'),
  hostElapsed: byId('hostElapsed'),
  hostLiveBox: byId('hostLiveBox'),
  hostRehearsal: byId('hostRehearsal'),
  hostPlatformNote: byId('hostPlatformNote'),
  hostNameInput: byId('hostNameInput'),
  startShareBtn: byId('startShareBtn'),
  fileShareLabel: byId('fileShareLabel'),
  fileShareText: byId('fileShareText'),
  fileInput: byId('fileInput'),
  fileControls: byId('fileControls'),
  filePlayBtn: byId('filePlayBtn'),
  fileName: byId('fileName'),
  micRow: byId('micRow'),
  micToggle: byId('micToggle'),
  micText: byId('micText'),
  nowPlayingField: byId('nowPlayingField'),
  switchSourceBtn: byId('switchSourceBtn'),
  stopShareBtn: byId('stopShareBtn'),
  nowPlayingInput: byId('nowPlayingInput'),
  nowPlayingBtn: byId('nowPlayingBtn'),
  qualitySelect: byId('qualitySelect'),
  lockToggle: byId('lockToggle'),
  handOverToggle: byId('handOverToggle'),
  directOnlyToggle: byId('directOnlyToggle'),
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
  guestWho: byId('guestWho'),
  pathChip: byId('pathChip'),
  listenGate: byId('listenGate'),
  listenBtn: byId('listenBtn'),
  modeRelay: byId('modeRelay'),
  modeDirect: byId('modeDirect'),
  reactionRow: byId('reactionRow'),
  moreReactionsBtn: byId('moreReactionsBtn'),
  moreReactions: byId('moreReactions'),
  guestDrawer: byId('guestDrawer'),
  guestShareBtn: byId('guestShareBtn'),
  carModeBtn: byId('carModeBtn'),
  endCard: byId('endCard'),
  endDuration: byId('endDuration'),
  endTitle: byId('endTitle'),
  endSub: byId('endSub'),
  hostFromPhoneLink: byId('hostFromPhoneLink'),
  sendToSelfBtn: byId('sendToSelfBtn'),
  storyBtn: byId('storyBtn'),
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

  // car mode
  carMode: byId('carMode'),
  carExitBtn: byId('carExitBtn'),
  carTitle: byId('carTitle'),
  carState: byId('carState'),
  carPlayBtn: byId('carPlayBtn'),
});

// Every connection state gets its own colour, glyph and motion, not just a
// different sentence: "waiting for the host" and "reconnecting" used to look
// identical at a glance, which is exactly when people reload and lose the room.
export const setStage = (el, state) => { if (el) el.dataset.state = state; };

export const show = (el, visible, display = 'block') => {
  if (el) el.style.display = visible ? display : 'none';
};

export { isTouchDevice } from './platform.js';
