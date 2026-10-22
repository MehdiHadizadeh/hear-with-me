// Tests for listening by link (public/shared/links.js): which links are
// accepted, what they become, and where a track is "now".
import { cleanTrackState, newTrack, parseTrackLink, spotifyUri, trackPositionNow, youtubeId, youtubeList } from './public/shared/links.js';

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${label}`); return; }
  failed++;
  console.log(`  FAIL ${label}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ''}`);
}

console.log('\nlinks people actually paste');
const cases = [
  ['https://soundcloud.com/artist/track-name', 'soundcloud', 'https://soundcloud.com/artist/track-name'],
  ['https://m.soundcloud.com/artist/track-name?si=abc&utm_source=x', 'soundcloud', 'https://soundcloud.com/artist/track-name'],
  ['https://on.soundcloud.com/AbC123', 'soundcloud', 'https://on.soundcloud.com/AbC123'],
  ['https://soundcloud.com/artist/sets/my-set', 'soundcloud', 'https://soundcloud.com/artist/sets/my-set'],
  ['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=1234', 'spotify', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'],
  ['https://open.spotify.com/intl-fa/track/4uLU6hMCjMI75M1A2tKUQC', 'spotify', 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'],
  ['Listen to this on Spotify: https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3 nice', 'spotify', 'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3'],
  ['https://youtu.be/dQw4w9WgXcQ?t=42', 'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x', 'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
  ['soundcloud.com/artist/track-name', 'soundcloud', 'https://soundcloud.com/artist/track-name'],
  ['https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', 'youtube', 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'],
  ['https://youtube.com/watch?v=dQw4w9WgXcQ&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', 'youtube', 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'],
  ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'spotify', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'],
];
for (const [text, provider, url] of cases) {
  const got = parseTrackLink(text);
  check(`${text.slice(0, 50)} → ${provider}`, got && got.provider === provider && got.url === url, got);
}

console.log('\nlinks that are refused');
for (const text of [
  'https://evil.example/soundcloud.com/x',
  'https://soundcloud.com.evil.example/artist/track',
  'javascript:alert(1)',
  'https://open.spotify.com/user/someone',
  'https://www.youtube.com/watch?v=short',
  `https://soundcloud.com/${'a'.repeat(500)}`,
  '',
  null,
]) {
  check(`refuses ${String(text).slice(0, 40)}`, parseTrackLink(text) === null);
}

console.log('\nwhat the players need');
check('spotify uri', spotifyUri('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC') === 'spotify:track:4uLU6hMCjMI75M1A2tKUQC');
check('youtube id', youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('youtube playlist id', youtubeList('https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI') === 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI');

console.log('\nwhere the track is now');
const playing = { playing: true, positionMs: 10000, updatedAt: 1000 };
check('playing: moves on by server and local time', trackPositionNow(playing, 3000, 500, 1500) === 13000);
check('paused: stays put', trackPositionNow({ ...playing, playing: false }, 3000, 500, 1500) === 10000);
check('state is cleaned', JSON.stringify(cleanTrackState({ playing: 'yes', positionMs: -5, index: -2, via: 'nope' })) === JSON.stringify({ playing: false, positionMs: 0, index: 0 }));
check('playlist item and path survive cleaning', JSON.stringify(cleanTrackState({ playing: true, positionMs: 5, index: 3, via: 'relay' })) === JSON.stringify({ playing: true, positionMs: 5, index: 3, via: 'relay' }));
check('a new track reaches guests the way asked, else by embed', newTrack({ provider: 'soundcloud', url: 'u' }, 'relay').via === 'relay' && newTrack({ provider: 'soundcloud', url: 'u' }, 'x').via === 'embed');

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
