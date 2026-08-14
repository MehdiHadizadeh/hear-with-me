// Who is in the room: the list itself, what to call each of them, and the two
// controls the host can point at a person.

import { faDigits, joinedAgo, listenerLabel } from './format.js';

const KICK_CONFIRM_MS = 3000;

export function createRoster({ ui, api, notices }) {
  let members = [];
  let announced = false; // the first roster is not news
  let isHost = false;

  const guests = () => members.filter((m) => !m.isHost);

  // "مهمان ۱" is a position in a list, not a person — nobody can point a
  // remove button at it with any confidence. A guest who typed a name is
  // called by it everywhere: the roster, the reactions, all of it.
  function labelFor(id) {
    if (id === api.clientId) return 'تو';
    const member = members.find((m) => m.id === id);
    if (member && member.name) return member.name;
    const index = guests().findIndex((m) => m.id === id);
    return index === -1 ? 'یک مهمان' : `مهمان ${faDigits(index + 1)}`;
  }

  // Arrivals and departures are the room's own news, and the host is often
  // looking at a tab they haven't scrolled in a while. Only real changes
  // count: a member whose phone briefly dropped its event stream keeps their
  // place in the list and must not read as "left".
  function announce(next) {
    if (!announced) { announced = true; return; }
    const before = new Set(members.map((m) => m.id));
    const after = new Set(next.map((m) => m.id));

    for (const m of next) {
      if (m.id !== api.clientId && !before.has(m.id)) {
        notices.showToast('اومد تو اتاق', { who: m.name || 'یک مهمان', emoji: '👋' });
      }
    }
    for (const m of members) {
      if (m.id !== api.clientId && !after.has(m.id) && !m.isHost) {
        notices.showToast('از اتاق رفت', { who: m.name || 'یک مهمان', emoji: '👋' });
      }
    }
  }

  function buildRow(member, index) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'member-name';
    const who = document.createElement('span');
    who.className = 'member-who';
    who.textContent = member.name || `مهمان ${faDigits(index + 1)}`; // guest text: never as markup
    const when = document.createElement('span');
    when.className = 'member-when';
    when.textContent = joinedAgo(member.joinedMsAgo || 0);
    name.append(who, when);
    if (!member.connected) {
      const tag = document.createElement('span');
      tag.className = 'member-tag';
      tag.textContent = 'قطع';
      name.appendChild(tag);
    }

    const promote = document.createElement('button');
    promote.type = 'button';
    promote.className = 'link-btn';
    promote.textContent = 'میزبان کن';
    promote.addEventListener('click', () => api.makeHost(member.id));

    // Two taps rather than a confirm dialog: the second tap is the decision,
    // and it goes back to being harmless on its own after a few seconds.
    const kick = document.createElement('button');
    kick.type = 'button';
    kick.className = 'link-btn danger';
    kick.textContent = 'حذف';
    let armed = null;
    kick.addEventListener('click', () => {
      if (!armed) {
        kick.textContent = 'مطمئنی؟';
        armed = setTimeout(() => { armed = null; kick.textContent = 'حذف'; }, KICK_CONFIRM_MS);
        return;
      }
      clearTimeout(armed);
      armed = null;
      api.kick(member.id);
    });

    li.append(name, promote, kick);
    return li;
  }

  function render() {
    if (!isHost) { ui.membersBox.style.display = 'none'; return; }
    const list = guests();
    ui.membersBox.style.display = list.length ? 'block' : 'none';
    ui.memberList.textContent = '';
    list.forEach((member, index) => ui.memberList.appendChild(buildRow(member, index)));
  }

  return {
    labelFor,

    setHostView(value) { isHost = value; render(); },

    update(next) {
      announce(next || []);
      members = next || [];
      render();
    },

    // Seeded from `welcome`, which is not news either.
    seed(next) {
      announced = true;
      members = next || [];
      render();
    },

    renderCount(count) {
      const { guests: n, text } = listenerLabel(count);
      ui.listenerText.textContent = text;
      ui.listenerPill.classList.toggle('live', n > 0);
    },
  };
}
