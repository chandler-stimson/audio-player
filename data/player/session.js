/* global audio */

const d = document.getElementById('dummy');

audio.addEventListener('play', () => {
  d.play();
  navigator.mediaSession.metadata = new MediaMetadata({
    title: audio.file.name
  });
  const previous = document.getElementById('previous');
  navigator.mediaSession.setActionHandler('previoustrack', previous.getAttribute('disabled') === 'true' ? null : () => {
    previous.dispatchEvent(new Event('click'));
  });
  const next = document.getElementById('next');
  navigator.mediaSession.setActionHandler('nexttrack', next.getAttribute('disabled') === 'true' ? null : () => {
    next.dispatchEvent(new Event('click'));
  });
});
audio.addEventListener('pause', () => {
  d.pause();
});

navigator.mediaSession.setActionHandler('play', () => audio.play());
navigator.mediaSession.setActionHandler('pause', () => audio.pause());
navigator.mediaSession.setActionHandler('seekbackward', () => {
  audio.dispatchEvent(new KeyboardEvent('keydown', {'code': 'ArrowLeft'}));
});
navigator.mediaSession.setActionHandler('seekforward', () => {
  audio.dispatchEvent(new KeyboardEvent('keydown', {'code': 'ArrowRight'}));
});

