/* global audio */

const d = document.getElementById('dummy');

/* the position state of the real playback; the media session itself rides
   on the looping silence element, whose own 10-second length is
   meaningless, so the controls of the OS show the length of that
   placeholder instead of the length of the track unless the real timeline
   is reported here. The play event reports too: the browser extrapolates
   the position onwards from the last report, so a resume that keeps the
   report of its pause would offset the playhead by the whole pause */
const positionState = () => {
  const duration = audio.duration;
  // a track whose length is unknown yet has no position state to report
  if (!duration) {
    return;
  }
  navigator.mediaSession.setPositionState({
    duration,
    // the reported position must stay inside the duration
    position: Math.max(0, Math.min(duration, audio.currentTime)),
    playbackRate: 1
  });
};

audio.addEventListener('loadedmetadata', positionState);
audio.addEventListener('play', positionState);
// the play loop of the view reports the playhead every 200ms
audio.addEventListener('progress', positionState);
// a seek reports the new playhead right away, also while the track is
// paused (the play loop only reports while it runs)
audio.addEventListener('timeupdate', positionState);
// the paused player freezes its position at the exact value
audio.addEventListener('pause', positionState);

audio.addEventListener('play', () => {
  d.play();
  navigator.mediaSession.metadata = new MediaMetadata({
    title: audio.file.name
  });
  const previous = document.getElementById('previous');
  navigator.mediaSession.setActionHandler('previoustrack', previous.disabled ? null : () => {
    previous.dispatchEvent(new Event('click'));
  });
  const next = document.getElementById('next');
  navigator.mediaSession.setActionHandler('nexttrack', next.disabled ? null : () => {
    next.dispatchEvent(new Event('click'));
  });
});
audio.addEventListener('pause', () => {
  d.pause();
});

/* nothing is loaded when the handler runs (an unloaded restored selection or
   an empty playlist); the host-aware toggle() path starts the selected track
   instead of failing on the missing source */
navigator.mediaSession.setActionHandler('play', () => audio.toggle());
navigator.mediaSession.setActionHandler('pause', () => audio.pause());
navigator.mediaSession.setActionHandler('seekbackward', () => {
  audio.dispatchEvent(new KeyboardEvent('keydown', {'code': 'ArrowLeft'}));
});
navigator.mediaSession.setActionHandler('seekforward', () => {
  audio.dispatchEvent(new KeyboardEvent('keydown', {'code': 'ArrowRight'}));
});

/* the absolute seek of the media panel; the playhead of the real player
   moves (never the placeholder) and the position state follows it right
   away, so the scrubber does not spring back to the stale position while
   the seek of a stream is still re-cuing its decoder */
navigator.mediaSession.setActionHandler('seekto', details => {
  // an unloaded selection (a restored track or an empty playlist) and a
  // seek without a time cannot move a playhead
  if (!details || details.seekTime === undefined || !audio.ready) {
    return;
  }
  audio.currentTime = details.seekTime;
  positionState();
});

