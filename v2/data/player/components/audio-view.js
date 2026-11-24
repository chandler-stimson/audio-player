/* global decoder */

const htime = delta => {
  const days = Math.floor(delta / 86400);
  delta -= days * 86400;
  const hours = Math.floor(delta / 3600) % 24;
  delta -= hours * 3600;
  const minutes = Math.floor(delta / 60) % 60;
  delta -= minutes * 60;
  const seconds = (delta % 60).toFixed(0);

  if (days) {
    return days + ':' + hours + ':' + minutes + ':' + ('0' + seconds).substr(-2);
  }
  else if (hours) {
    return hours + ':' + minutes + ':' + ('0' + seconds).substr(-2);
  }
  else {
    return minutes + ':' + ('0' + seconds).substr(-2);
  }
};

/* how many decoded seconds the stream mode keeps ahead of the playhead and
   behind it; the window bounds the memory of a decoded track so that the
   playback of an arbitrarily large input stays flat */
const WINDOW_AHEAD = 30;
const WINDOW_BEHIND = 10;
/* the safety gap between the scheduling time and now; a source that starts
   exactly at the current context time can click */
const SCHEDULE_EPSILON = 0.05;

class AudioView extends HTMLElement {
  constructor() {
    super();
    const shadow = this.attachShadow({
      mode: 'open'
    });
    shadow.innerHTML = `
      <style>
        #parent {
          display: flex;
          gap: 5px;
          align-items: center;
          background-color: var(--bg-color, #f1f3f4);
          border-radius: 30px;
          padding: 12px 10px;
          font-size: 13px;
          user-select: none;
          outline: none;
          --height: 5px;
          --progress-bg-color: #000;
        }
        ::slotted(*),
        #volume,
        #parent > svg {
          cursor: pointer;
          border-radius: 20px;
          padding: 5px;
        }
        ::slotted(*),
        #volume > svg,
        #parent > svg {
          height: 20px;
          width: 20px;
        }
        ::slotted(*:hover),
        #volume:hover,
        #parent > svg:hover {
          background-color: rgba(0, 0, 0, 0.05);
        }
        #progress {
          flex: 1;
        }
        #parent[mode=play] #play path:nth-child(2) {
          display: none;
        }
        #parent:not([mode=play]) #play path:nth-child(1) {
          display: none;
        }
        #parent[mode=nosrc] > svg {
          opacity: 0.2;
          pointer-events: none;
        }
        #volume {
          display: flex;
          align-items: center;
        }
        #sound {
          width: 0;
          padding-left: 0;
          --percent: 50%;
          transition: width .5s, padding-left .5s;
          position: relative;
        }
        #volume:hover > #sound {
          width: 48px;
          padding-left: 5px;
        }
        #volume:hover > #sound:after {
          content: '';
          position: absolute;
          left: 50%;
          top: 0;
          width: 1px;
          height: 5px;
          background-color: #ccc;
          z-index: 1;
          pointer-events: none;
        }
      </style>
      <div id="parent" mode="nosrc" data-ready=false tabindex="-1">
        <slot name="before-play"></slot>
        <svg id="play" viewBox="0 0 48 48">
          <path d="M16 10v28l22-14z"/>
          <path d="M12 38h8V10h-8v28zm16-28v28h8V10h-8z"/><path d="M0 0h48v48H0z" fill="none"/>
          <title>Use Space to toggle play and pause</title>
        </svg>
        <slot name="before-stat"></slot>
        <span id="current">0:00</span>
        <progress-view id="progress" title="Use Arrow Left/Right to seek 10 seconds backward/forward
Use Meta + Arrow Left/Right to seek 30 seconds backward/forward"></progress-view>
        <span id="duration">0:00</span>
        <slot name="before-sound"></slot>
        <div id="volume" title="Use Arrow Up/Down to increase/decrease 10%
Use Meta + Arrow Up/Down to seek 30%">
          <progress-view id="sound"></progress-view>
          <svg viewBox="0 0 48 48">
            <path d="M14 18v12h8l10 10V8L22 18h-8z"/><path d="M0 0h48v48H0z" fill="none"/>
          </svg>
        </div>
        <slot name="after-sound"></slot>
      </div>
    `;
    this.stat = {
      start: 0,
      stop: 0
    };
  }
  connectedCallback() {
    // prevent open dialog to open on dblclick
    this.shadowRoot.addEventListener('dblclick', e => {
      if (e.target.closest('svg')) {
        e.stopPropagation();
      }
    });
    // progress
    const progress = this.shadowRoot.getElementById('progress');
    progress.addEventListener('seek', e => {
      if (this.audioBuffer) {
        const offset = this.audioBuffer.duration * e.detail / 100;
        this.currentTime = offset;
        progress.seek(e.detail);
      }
      else if (this.stream && this.duration) {
        const offset = this.duration * e.detail / 100;
        this.currentTime = offset;
        progress.seek(e.detail);
      }
    });
    const play = this.shadowRoot.getElementById('play');
    play.addEventListener('click', () => this.toggle());
    let id;
    const parent = this.shadowRoot.getElementById('parent');
    this.addEventListener('pause', () => {
      clearInterval(id);
      parent.setAttribute('mode', 'play');
    });
    const current = this.shadowRoot.getElementById('current');
    this.addEventListener('play', () => {
      parent.setAttribute('mode', 'pause');
      clearInterval(id);
      id = setInterval(() => {
        const d = this.duration || 0;
        const p = d ? Math.min(100, Math.max(0, this.currentTime / d * 100)) : 0;
        progress.seek(p);

        current.textContent = htime(this.currentTime);

        // the decoded window of a streaming track follows the playhead
        this.#maintain();

        this.dispatchEvent(new Event('progress'));
      }, 200);
    });
    this.addEventListener('ended', () => progress.seek(100));

    this.addEventListener('keydown', e => {
      if (e.code === 'KeyB' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        this.currentTime = 0;
      }
      else if (e.code === 'Space') {
        this.toggle();
      }
      else if (e.code === 'ArrowRight') {
        const shift = (e.metaKey || e.ctrlKey) ? 30 : 10;
        if (this.currentTime + shift < (this.duration || Infinity)) {
          this.currentTime += shift;
        }
      }
      else if (e.code === 'ArrowLeft') {
        const shift = (e.metaKey || e.ctrlKey) ? 30 : 10;
        if (this.currentTime - shift > 0) {
          this.currentTime -= shift;
        }
      }
      else if (e.code === 'ArrowUp') {
        this.volume += (e.metaKey || e.ctrlKey) ? 0.3 : 0.1;
        this.volume = Math.round(this.volume * 10) / 10;
      }
      else if (e.code === 'ArrowDown') {
        this.volume -= (e.metaKey || e.ctrlKey) ? 0.3 : 0.1;
        this.volume = Math.round(this.volume * 10) / 10;
      }
    });

    const sound = this.shadowRoot.getElementById('sound');
    sound.addEventListener('seek', e => {
      this.volume = e.detail / 50;
    });
  }
  static get observedAttributes() {
    return ['src'];
  }
  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'src' && newValue) {
      const parent = this.shadowRoot.getElementById('parent');
      parent.setAttribute('mode', 'play');
    }
    if (name === 'src') {
      if (this.source || this.stream) {
        this.reset();
      }
    }
  }
  get duration() {
    if (this.audioBuffer) {
      return this.audioBuffer.duration;
    }
    if (this.stream) {
      return this.stream.duration;
    }
    return 0;
  }
  /* true when the element has something loaded that can be resumed */
  get ready() {
    return Boolean(this.audioBuffer || this.stream);
  }
  reset() {
    this.pause();
    // the streaming session of the previous track is released with its
    // worker-side decoder state
    if (this.stream) {
      const stream = this.stream;
      delete this.stream;
      stream.session.close().catch(() => {});
    }
    delete this.audioBuffer;
    delete this.context;
    delete this.meta;
    this.stat.start = 0;
    this.stat.stop = 0;
    this.shadowRoot.getElementById('progress').seek(0);
    this.shadowRoot.getElementById('current').textContent = '0:00';
    this.shadowRoot.getElementById('duration').textContent = '0:00';
  }
  async play(arrayBuffer) {
    const session = this.session = Math.random();
    if (arrayBuffer) {
      this.reset();
    }
    if (this.audioBuffer && this.context) {
      return this.start();
    }
    else if (this.stream) {
      // resume a streaming track at its paused position
      return this.#resume();
    }
    else {
      const parent = this.shadowRoot.getElementById('parent');
      if (!arrayBuffer) {
        if (this.getAttribute('src')) {
          arrayBuffer = await fetch(this.getAttribute('src')).then(r => r.arrayBuffer());
        }
      }
      if (!arrayBuffer) {
        throw Error('EMPTY_BUFFER');
      }

      try {
        parent.setAttribute('mode', 'nosrc');
        const decoded = await decoder.decode({
          name: 'input',
          arrayBuffer
        });
        if (session !== this.session) {
          return; // another playback session started while decoding
        }
        Object.assign(this, decoded);
      }
      catch (e) {
        if (session !== this.session || e.message === 'CANCELED') {
          return; // superseded or canceled; the new session owns the element
        }
        console.info('FFmpeg Decoder Failed', e);
        try {
          const context = decoder.context();
          const audioBuffer = await context.decodeAudioData(arrayBuffer);
          if (session !== this.session) {
            return;
          }
          Object.assign(this, {
            context,
            audioBuffer,
            meta: {}
          });
        }
        catch (ee) {
          console.info('Native Decoder Failed', ee);

          this.reset();
          return this.dispatchEvent(new CustomEvent('error', {
            detail: e.message
          }));
        }
      }
      this.dispatchEvent(new Event('loadedmetadata'));
      this.start();
    }
  }

  /* ------------------------------------------------------------ stream mode */

  /* play a track that is decoded incrementally; the input is never read as a
     whole: a large local file is sliced inside the worker and a network
     track is downloaded chunk by chunk */
  async playStream({file, href}) {
    const token = this.session = Math.random();
    this.reset();

    const parent = this.shadowRoot.getElementById('parent');
    parent.setAttribute('mode', 'nosrc');

    let session;
    try {
      session = await decoder.open({
        file,
        href,
        owner: 'user',
        onchunk: chunk => this.#onchunk(chunk, token),
        onstop: () => {
          // the session was preempted (another track plays) or crashed
          if (this.session === token) {
            this.#stopRun();
          }
        }
      });
    }
    catch (e) {
      if (this.session !== token || e.message === 'CANCELED') {
        return; // superseded or canceled; the new session owns the element
      }
      console.info('Streaming Decoder Failed', e);
      this.reset();
      return this.dispatchEvent(new CustomEvent('error', {
        detail: e.message
      }));
    }

    if (this.session !== token) {
      session.close().catch(() => {});
      return; // superseded while the input was being opened
    }

    const meta = session.meta || {};
    this.meta = meta;
    // the shared context of the element (the stream buffers are created and
    // scheduled on it)
    this.context = decoder.context();
    this.stream = {
      session,
      token,
      sampleRate: meta['Sample Rate'],
      channels: meta['Channels'],
      duration: meta['Duration'] !== undefined ? meta['Duration'] : null,
      chunks: [],
      covered: 0,
      done: false,
      pulling: null,
      seeking: null,
      wantPlay: true,
      run: null
    };

    // the duration of a stream that cannot tell yet (an ogg without a
    // header index) stays blank until the whole input was decoded
    this.shadowRoot.getElementById('duration').textContent =
      this.stream.duration ? htime(this.stream.duration) : '-';

    this.dispatchEvent(new Event('loadedmetadata'));

    // decode the first window and start the run when its opening chunk lands
    this.#maintain();
  }

  /* a decoded chunk of the streaming track; the buffers arrive transferred
     from the worker */
  #onchunk(chunk, token) {
    if (!this.stream || this.stream.token !== token) {
      return; // a different playback session owns the element
    }
    const s = this.stream;

    // wrap the channels into an AudioBuffer; the context resamples it at
    // playback when the track rate differs from the context rate
    const context = this.context || decoder.context();
    const buffer = context.createBuffer(chunk.channels.length, chunk.samples, chunk.sampleRate);
    chunk.channels.forEach((ch, c) => buffer.copyToChannel(ch, c));

    const entry = {
      pos: chunk.pos,
      seconds: chunk.samples / chunk.sampleRate,
      buffer
    };
    // the decoded coverage follows the chunks (the pull result only
    // confirms it later)
    s.covered = Math.max(s.covered, entry.pos + entry.seconds);

    // the window stays sorted; a duplicate (a re-delivered position) is
    // replaced instead of stacked
    const at = s.chunks.findIndex(c => c.pos >= entry.pos);
    if (at !== -1 && s.chunks[at].pos === entry.pos) {
      s.chunks[at] = entry;
    }
    else {
      s.chunks.splice(at === -1 ? s.chunks.length : at, 0, entry);
    }

    // schedule what is playable now: the extension of the running chain or
    // the start of a waiting one
    this.#scheduleRun();
    this.#maintain();
  }

  /* the chunk that contains a content position and the offset inside it */
  #chunkAt(pos) {
    const s = this.stream;
    if (!s) {
      return null;
    }
    for (const c of s.chunks) {
      if (pos >= c.pos && pos < c.pos + c.seconds) {
        return {chunk: c, offset: pos - c.pos};
      }
    }
    return null;
  }

  /* start or extend the source chain of the stream; a run only schedules
     contiguous chunks so that the playback stays sample-accurate */
  #scheduleRun() {
    const s = this.stream;
    if (!s || !s.wantPlay) {
      return;
    }
    const context = this.context || decoder.context();

    if (s.run) {
      // extend the chain as long as the decoded window is contiguous; new
      // chunks may have arrived since the last pass
      this.#advanceNextChunk(s.run);
      while (s.run.nextChunk && s.run.nextPos >= s.run.nextChunk.pos - 0.001 &&
             s.run.nextPos <= s.run.nextChunk.pos + 0.001) {
        this.#scheduleChunk(s.run, s.run.nextChunk, s.run.endTime, 0);
        this.#advanceNextChunk(s.run);
      }
      // the end signal follows the (possibly new) last source, also when no
      // chunk extended the chain but the stream just finished
      this.#refreshEnd();
      return;
    }

    // a waiting run starts when the chunk of its position arrives. A chunk
    // that starts slightly ahead is snapped to: a primed codec reports its
    // first samples a fraction late and no chunk can contain a position
    // before the first sample of the stream
    let hit = this.#chunkAt(this.stat.stop);
    if (!hit) {
      const ahead = s.chunks.find(c => c.pos > this.stat.stop && c.pos - this.stat.stop < 0.25);
      if (ahead) {
        this.stat.stop = ahead.pos;
        hit = this.#chunkAt(this.stat.stop);
      }
    }
    if (!hit) {
      return;
    }
    // the run needs a lead so that it does not starve right away, unless
    // the chunk already carries the end of the stream
    if (!s.done && s.covered < this.stat.stop + 0.25) {
      return;
    }

    const when = context.currentTime + SCHEDULE_EPSILON;
    this.stat.start = when - this.stat.stop;

    const run = s.run = {
      sources: [],
      nextPos: 0,
      endTime: when,
      sound: null,
      nextChunk: null
    };
    this.#scheduleChunk(run, hit.chunk, when, hit.offset);
    this.#advanceNextChunk(run);
    // the chain follows as far as the window reaches
    while (run.nextChunk && run.nextChunk.pos <= run.nextPos + 0.001) {
      this.#scheduleChunk(run, run.nextChunk, run.endTime, 0);
      this.#advanceNextChunk(run);
    }
    this.#refreshEnd();

    context.resume();
    this.dispatchEvent(new Event('play'));
  }

  #scheduleChunk(run, chunk, when, offset) {
    const context = this.context || decoder.context();
    const source = context.createBufferSource();
    source.buffer = chunk.buffer;

    if (!run.sound) {
      const sound = run.sound = context.createGain();
      sound.gain.value = this.volume;
      sound.connect(context.destination);
      this.sound = sound;
    }
    source.connect(run.sound);
    source.start(when, offset);

    if (run.sources.length === 0) {
      this.source = source;
    }
    run.sources.push(source);
    run.endTime = when + chunk.seconds - offset;
    run.nextPos = chunk.pos + chunk.seconds;
  }

  #advanceNextChunk(run) {
    const s = this.stream;
    run.nextChunk = null;
    for (const c of s.chunks) {
      if (c.pos > run.nextPos - 0.001) {
        run.nextChunk = c;
        return;
      }
    }
  }

  /* the natural end of the chain: only the very last source of a finished
     stream carries the ended signal, exactly like the single source of the
     buffer mode */
  #refreshEnd() {
    const s = this.stream;
    if (!s || !s.run) {
      return;
    }
    const last = s.run.sources[s.run.sources.length - 1];
    if (!last) {
      return;
    }
    if (s.done) {
      last.onended = () => {
        if (this.stream === s && s.run) {
          const endPos = s.run.nextPos;
          this.#stopRun();
          this.stat.stop = Math.min(s.duration || Infinity, endPos);
          this.dispatchEvent(new Event('pause'));
          this.dispatchEvent(new Event('ended'));
        }
      };
    }
    else {
      last.onended = null;
    }
  }

  /* stop the source chain of the stream without touching its position */
  #stopRun() {
    const s = this.stream;
    if (!s) {
      return;
    }
    const run = s.run;
    s.run = null;
    delete this.source;
    if (run) {
      for (const source of run.sources) {
        source.onended = null;
        source.disconnect();
        source.stop();
      }
      if (run.sound) {
        run.sound.disconnect();
      }
    }
  }

  /* keep the decoded window around the playhead: pull ahead, evict behind
     and recover a starved run */
  #maintain() {
    const s = this.stream;
    if (!s) {
      return;
    }
    const context = this.context || decoder.context();

    // the run starved: the scheduled chain ran dry before more decoded
    // audio arrived; the position waits where the audio ran out
    if (s.run && s.run.endTime < context.currentTime - 0.25) {
      this.stat.stop = s.run.nextPos;
      this.#stopRun();
    }

    // resume a waiting run when its window is decoded
    this.#scheduleRun();

    // evict what is far behind the playhead
    const keepFrom = Math.max(0, this.currentTime - WINDOW_BEHIND);
    if (s.chunks.length) {
      s.chunks = s.chunks.filter(c => c.pos + c.seconds > keepFrom);
    }

    // decode ahead
    const horizon = Math.min(
      (s.duration !== null ? s.duration : Infinity),
      this.currentTime + WINDOW_AHEAD
    );
    if (!s.done && !s.pulling && s.covered < horizon) {
      s.pulling = s.session.pullUntil(horizon).then(r => {
        if (this.stream !== s) {
          return; // superseded
        }
        s.pulling = null;
        s.covered = r.covered;
        s.done = r.done;
        if (s.done && s.duration === null) {
          // the exact length of a stream that could not tell in advance
          s.duration = r.covered;
          this.shadowRoot.getElementById('duration').textContent = htime(s.duration);
        }
        this.#scheduleRun();
        this.#maintain();
      }).catch(e => {
        if (this.stream !== s) {
          return;
        }
        s.pulling = null;
        if (e.message !== 'CANCELED') {
          console.info('Streaming Pull Failed', e);
          this.#stopRun();
          this.dispatchEvent(new CustomEvent('error', {
            detail: e.message
          }));
        }
      });
    }
  }

  /* resume the stream at its paused position */
  #resume() {
    const s = this.stream;
    if (!s) {
      return;
    }
    /* a stream that played to its end has no chunk left at its playhead
       (the decoded window is half-open) and nothing left to decode; it
       restarts from the beginning like the buffer mode does */
    if (s.done && this.#chunkAt(this.stat.stop) === null) {
      this.#seekStream(0);
      return;
    }
    s.wantPlay = true;
    this.#scheduleRun();
    this.#maintain();
  }
  #pauseStream() {
    const s = this.stream;
    if (!s) {
      return;
    }
    s.wantPlay = false;
    const context = this.context || decoder.context();
    if (s.run) {
      if (context.state === 'running') {
        this.stat.stop = Math.max(0, Math.min(s.duration || Infinity, context.currentTime - this.stat.start));
      }
      this.#stopRun();
    }
    this.dispatchEvent(new Event('pause'));
  }
  /* seek the stream to a content position; an in-window position resumes
     from the decoded chunks, anything else re-cues the decoder */
  #seekStream(v) {
    const s = this.stream;
    if (!s) {
      return;
    }
    const wasPlaying = s.wantPlay;
    const from = this.stat.stop;
    const target = Math.max(0, Math.min(s.duration !== null ? s.duration : v, v));

    this.#stopRun();
    this.stat.stop = target;
    s.wantPlay = true;

    const hit = this.#chunkAt(target);
    if (hit) {
      // the window covers the position; no decoder round trip is needed
      // (the run start waits for its decoding lead on its own)
      this.#scheduleRun();
      this.#maintain();
      return;
    }

    // an out-of-window position re-cues the decoder; a seek that arrives
    // while another one is re-cuing simply chains behind it (the wrapper
    // matches the responses in order and the stale chunks are dropped by
    // their epoch), which keeps the newest target from being lost
    s.seeking = s.session.seek(target).then(() => {
      if (this.stream !== s) {
        return;
      }
      s.seeking = null;
      // the chunks of the old position are invalid; the new epoch delivers
      // fresh ones from the target on
      s.chunks = [];
      s.covered = target;
      s.done = false;
      this.#scheduleRun();
      this.#maintain();
    }).catch(e => {
      if (this.stream !== s) {
        return;
      }
      s.seeking = null;
      if (e.message === 'SEEK_FAILED') {
        // the input cannot jump there (a download that has not reached
        // the position); fall back to where the track was, playing or paused
        this.stat.stop = from;
        s.wantPlay = wasPlaying;
        if (wasPlaying) {
          this.#scheduleRun();
        }
        this.#maintain();
        return;
      }
      if (e.message !== 'CANCELED') {
        console.info('Streaming Seek Failed', e);
        this.#stopRun();
        this.dispatchEvent(new CustomEvent('error', {
          detail: e.message
        }));
      }
    });
  }

  // play an already decoded result (produced by the decoder wrapper or cached
  // by the playlist) without decoding it again
  async playDecoded(decoded) {
    if (!decoded || !decoded.audioBuffer) {
      throw Error('EMPTY_BUFFER');
    }
    this.session = Math.random();
    this.reset();
    Object.assign(this, decoded);
    this.dispatchEvent(new Event('loadedmetadata'));
    this.start();
  }
  start() {
    const {context, audioBuffer} = this;
    const source = this.source = context.createBufferSource();

    // when the source ends naturally keep the decoded buffer so that the
    // track can be replayed instantly (repeat-one, seek to zero, ...)
    source.onended = () => {
      if (this.source === source) {
        delete this.source;
        this.stat.stop = audioBuffer.duration;
        this.dispatchEvent(new Event('pause'));
        this.dispatchEvent(new Event('ended'));
      }
    };

    source.buffer = audioBuffer;
    this.shadowRoot.getElementById('duration').textContent = htime(audioBuffer.duration);

    const sound = this.sound = context.createGain();
    sound.gain.value = this.volume;

    sound.connect(context.destination);
    source.connect(sound);

    // the resume position; a fully consumed buffer restarts from the beginning.
    // NOTE: `this.currentTime` cannot be used here; with the shared context
    // running, its live branch would read a stale `stat.start`
    const resume = Math.min(this.stat.stop, audioBuffer.duration);
    const offset = resume >= audioBuffer.duration ? 0 : resume;
    context.resume();
    source.start(0, offset);
    this.stat.start = context.currentTime - offset;

    this.dispatchEvent(new Event('play'));
  }
  pause() {
    if (this.stream) {
      this.#pauseStream();
    }
    else if (this.source) {
      const {source, context} = this;
      delete this.source;
      source.onended = null; // ignore the synthetic end event of source.stop
      this.stat.stop = context.currentTime - this.stat.start;
      if (this.audioBuffer) {
        this.stat.stop = Math.min(this.stat.stop, this.audioBuffer.duration);
      }
      source.disconnect();
      source.stop();
      this.dispatchEvent(new Event('pause'));
    }
  }
  toggle() {
    if (this.source) {
      this.pause();
    }
    else if (this.audioBuffer) {
      this.play();
    }
    else if (this.stream) {
      this.#resume();
    }
    else {
      // nothing is loaded; the host decides (it can start the selected track)
      this.dispatchEvent(new Event('empty'));
    }
  }
  get currentTime() {
    if (this.stream) {
      if (this.stream.run && this.context && this.context.state === 'running') {
        return Math.max(0, this.context.currentTime - this.stat.start);
      }
      return this.stat.stop;
    }
    if (this.source && this.context.state === 'running') {
      return this.context.currentTime - this.stat.start;
    }
    else {
      return this.stat.stop;
    }
  }
  set currentTime(v) {
    if (this.stream) {
      this.#seekStream(v);
      return;
    }
    if (this.source) {
      this.pause();
    }
    if (this.audioBuffer) {
      this.stat.stop = Math.max(0, Math.min(this.audioBuffer.duration, v));
      this.play();
    }
  }
  get volume() {
    return this.shadowRoot.getElementById('sound').percent / 50;
  }
  set volume(v) {
    v = Math.max(0, Math.min(2, v));
    this.shadowRoot.getElementById('sound').seek(v * 50);
    if (this.sound) {
      this.sound.gain.value = v;
    }
    this.dispatchEvent(new Event('volumechange'));
  }
}
window.customElements.define('audio-view', AudioView);
