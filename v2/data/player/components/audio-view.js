/* global decoder */

const htime = delta => {
  let days = Math.floor(delta / 86400);
  delta -= days * 86400;
  let hours = Math.floor(delta / 3600);
  delta -= hours * 3600;
  let minutes = Math.floor(delta / 60);
  delta -= minutes * 60;
  let seconds = Math.round(delta);

  // a rounded second carries into the greater units: the last half
  // second of a minute must not render as a ":60" tail
  if (seconds === 60) {
    seconds = 0;
    minutes += 1;
  }
  if (minutes === 60) {
    minutes = 0;
    hours += 1;
  }
  if (hours === 24) {
    hours = 0;
    days += 1;
  }

  const two = n => ('0' + n).slice(-2);
  if (days) {
    return days + ':' + two(hours) + ':' + two(minutes) + ':' + two(seconds);
  }
  else if (hours) {
    return hours + ':' + two(minutes) + ':' + two(seconds);
  }
  else {
    return minutes + ':' + two(seconds);
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
/* how far past its end a finished source stays in the run before it is
   dropped; the margin keeps the drop safely behind the audio clock */
const SOURCE_PRUNE_MARGIN = 1;

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
          --height: 5px;
          --progress-bg-color: #000;
        }
        ::slotted(*),
        #parent > button {
          cursor: pointer;
          border-radius: 20px;
          padding: 5px;
        }
        ::slotted(*:hover),
        #parent > button:hover {
          background-color: rgba(0, 0, 0, 0.05);
        }
        /* the native button chrome is stripped; the buttons size around
           their icons so that the padding truly wraps them */
        ::slotted(button),
        #parent > button {
          border: none;
          background-color: transparent;
          font: inherit;
          color: inherit;
          display: grid;
          place-content: center;
        }
        #parent > button > svg {
          height: 20px;
          width: 20px;
        }
        #progress {
          flex: 1;
          --hit-padding: 12.5px;
        }
        #parent[mode=play] #play path:nth-child(2) {
          display: none;
        }
        #parent:not([mode=play]) #play path:nth-child(1) {
          display: none;
        }
        #parent[mode=nosrc] > button,
        #parent[mode=nosrc] ::slotted([slot=before-progress]),
        #parent[mode=nosrc] ::slotted([slot=after-progress]) {
          opacity: 0.2;
          pointer-events: none;
        }
      </style>
      <div id="parent" mode="nosrc" data-ready=false>
        <slot name="before-play"></slot>
        <button type="button" id="play" aria-label="Play" title="Use Space to toggle play and pause">
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <path d="M16 10v28l22-14z"/>
            <path d="M12 38h8V10h-8v28zm16-28v28h8V10h-8z"/><path d="M0 0h48v48H0z" fill="none"/>
          </svg>
        </button>
        <slot name="before-stat"></slot>
        <span id="current">0:00</span>
        <slot name="before-progress"></slot>
        <progress-view id="progress" aria-label="Seek position" title="Use Arrow Left/Right to seek 10 seconds backward/forward
Use Meta + Arrow Left/Right to seek 30 seconds backward/forward"></progress-view>
        <slot name="after-progress"></slot>
        <span id="duration">0:00</span>
        <slot name="before-sound"></slot>
        <volume-view id="volume" title="Click to toggle mute (M)
Use Arrow Up/Down to increase/decrease 10%
Use Meta + Arrow Up/Down to seek 30%"></volume-view>
        <slot name="after-sound"></slot>
      </div>
    `;
    this.stat = {
      start: 0,
      stop: 0
    };
    /* the size of a skip; the host reflects the stored user preference into
       it: a number of seconds or a fraction ("1/60") of the track length */
    this.skipPeriod = 10;
  }
  connectedCallback() {
    // prevent open dialog to open on dblclick; the volume view retargets
    // the clicks of its inner svg to its host, so the guard must catch it
    this.shadowRoot.addEventListener('dblclick', e => {
      if (e.target.closest('button, #volume')) {
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
    /* the play button says what it does; the mode is also written from the
       outside (the page resets the player), so the observer is the single
       place that keeps the label in sync */
    new MutationObserver(() => {
      const playing = parent.getAttribute('mode') === 'pause';
      play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }).observe(parent, {
      attributes: true,
      attributeFilter: ['mode']
    });
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
      // the keys act on the host itself; a key on a focused child control
      // stays that control's own activation
      if (e.composedPath()[0] !== this) {
        return;
      }
      if (e.code === 'KeyB' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        this.currentTime = 0;
      }
      else if (e.code === 'Space') {
        this.toggle();
      }
      else if (e.code === 'ArrowRight') {
        const shift = this.skipSeconds * ((e.metaKey || e.ctrlKey) ? 3 : 1);
        if (this.currentTime + shift < (this.duration || Infinity)) {
          this.currentTime += shift;
        }
      }
      else if (e.code === 'ArrowLeft') {
        const shift = this.skipSeconds * ((e.metaKey || e.ctrlKey) ? 3 : 1);
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
      else if (e.code === 'KeyM') {
        this.shadowRoot.getElementById('volume').toggleMute();
      }
    });

    const volume = this.shadowRoot.getElementById('volume');
    // a change that started inside the volume view re-enters the funnel so
    // that the gain node and the host reporting stay centralized; the
    // reflect of the view is silent, so this cannot loop
    volume.addEventListener('volumechange', e => {
      this.volume = e.detail;
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
  /* the resolved seconds of one skip; a fraction scales with the loaded
     track and an unknown length falls back to the plain default */
  get skipSeconds() {
    const p = this.skipPeriod;
    if (typeof p === 'number') {
      return p;
    }
    return this.duration ? this.duration / Number(p.split('/')[1]) : 10;
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
        onstop: e => {
          // the session was preempted (another track plays) or it failed
          if (this.session !== token) {
            return; // a different playback session owns the element
          }
          /* a preemption merely stops the run: the superseding session
             resets the element on its own; a failure before the stream
             was built is reported by the open call itself */
          if (!e || e.message === 'CANCELED' || !this.stream) {
            this.#stopRun();
            return;
          }
          // a real failure killed the worker-side decoder state
          this.#failStream(e);
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
      /* the state revision of the stream; it is bumped when the element
         takes the state over without the decoder (a seek to the finished
         end), so that a pull or a seek still in flight cannot write its
         stale result back */
      gen: 0,
      /* the error that killed the session before the input was fully
         decoded; a failed stream can no longer decode, seek, resume or
         end, and every use reports the failure again */
      failed: null,
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
    // a failed stream must not restart: a run would replay its buffered
    // window and starve right after (the dead session delivers nothing)
    if (!s || s.failed || !s.wantPlay) {
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
    // the scheduled end of this source; #maintain drops a finished source
    // from the head of the run once the audio clock is safely past it, so
    // that neither the node nor its AudioBuffer is pinned for the whole
    // track while the playback continues
    source.endAt = when + chunk.seconds - offset;
    run.sources.push(source);
    run.endTime = source.endAt;
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

  /* the decoder session of the stream died without a pull or a seek in
     flight that would report it (a crashed worker, a decode error between
     two commands): freeze the playhead where the audio actually is — a
     mere #stopRun would leave the stale cue of `stat.stop` behind and the
     next maintenance pass would restart the run there, replaying the
     buffered window — then quiesce the stream, because every later command
     to the dead session only answers CANCELED, and report the failure like
     the open/pull/seek paths do */
  #failStream(e) {
    const s = this.stream;
    if (!s || s.failed) {
      return;
    }
    const context = this.context || decoder.context();
    if (s.run && context.state === 'running') {
      this.stat.stop = Math.max(0, Math.min(s.duration || Infinity, context.currentTime - this.stat.start));
    }
    s.failed = e;
    s.wantPlay = false;
    this.#stopRun();
    this.dispatchEvent(new CustomEvent('error', {
      detail: e.message
    }));
  }

  /* keep the decoded window around the playhead: pull ahead, evict behind
     and recover a starved run */
  #maintain() {
    const s = this.stream;
    // a failed stream has nothing to maintain: its session is gone and the
    // window would only be churned without ever being filled again
    if (!s || s.failed) {
      return;
    }
    const context = this.context || decoder.context();

    // the run starved: the scheduled chain ran dry before more decoded
    // audio arrived; the position waits where the audio ran out
    if (s.run && s.run.endTime < context.currentTime - 0.25) {
      this.stat.stop = s.run.nextPos;
      this.#stopRun();
    }

    // drop the sources that finished playing from the head of the run: they
    // are already silent, but as long as the run references them they keep
    // their AudioBuffer alive, which would grow the memory with the whole
    // played track instead of the decoded window. The last source is never
    // dropped (only it carries the ended signal of a finished stream) and
    // `this.source` stays truthful for the pause/toggle branches
    const run = s.run;
    while (run && run.sources.length > 1 &&
           run.sources[0].endAt < context.currentTime - SOURCE_PRUNE_MARGIN) {
      const done = run.sources.shift();
      done.onended = null;
      done.disconnect();
      if (this.source === done) {
        this.source = run.sources[0];
      }
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
      // the stream revision at post time; the element can take the state
      // over without the decoder while the pull runs (a seek to the
      // finished end) and a result from before that must not land
      const gen = s.gen;
      s.pulling = s.session.pullUntil(horizon).then(r => {
        if (this.stream !== s) {
          return; // superseded
        }
        s.pulling = null;
        if (s.gen !== gen) {
          return; // the element moved the state on; its state stands
        }
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
        // the wrapper fails a pending pull before it calls onstop, so the
        // failure is reported already by the time this rejection runs
        if (s.failed) {
          return;
        }
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
    if (s.failed) {
      // the decoder state behind the stream is gone; only a fresh selection
      // of the track can play it again
      this.dispatchEvent(new CustomEvent('error', {
        detail: s.failed.message
      }));
      return;
    }
    /* a stream that played to its end has no chunk left at its playhead
       (the decoded window is half-open) and nothing left to decode; it
       restarts from the beginning like the buffer mode does. The end of a
       known duration counts as finished even without the done flag: no
       chunk can ever contain the end position */
    if ((s.done || (s.duration !== null && this.stat.stop >= s.duration)) &&
        this.#chunkAt(this.stat.stop) === null) {
      // the flag must be up before the restart seek takes it over
      s.wantPlay = true;
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
     from the decoded chunks (unless a seek is re-cuing the decoder),
     anything else re-cues the decoder */
  #seekStream(v) {
    const s = this.stream;
    if (!s) {
      return;
    }
    if (s.failed) {
      // the decoder state behind the stream is gone; the seek cannot run
      this.dispatchEvent(new CustomEvent('error', {
        detail: s.failed.message
      }));
      return;
    }
    const wasPlaying = s.wantPlay;
    const from = this.stat.stop;
    const target = Math.max(0, Math.min(s.duration !== null ? s.duration : v, v));

    this.#stopRun();
    this.stat.stop = target;
    // the seek moves the playhead only; whether the track plays stays as it
    // was (#resume raises the flag before its restart seek to the beginning)
    s.wantPlay = wasPlaying;

    /* a seek that lands at the end of a known track has nothing left to
       decode or play: no chunk can contain the end position (the decoded
       window is half-open) and no pull can run (the horizon is clamped to
       the duration that the coverage is set to), so a decoder re-cue would
       stall the stream at its destination forever. The finished state is
       entered directly instead, exactly like the natural end of the last
       source does: the ended signal fires and Play restarts from the
       beginning */
    if (s.duration !== null && target >= s.duration) {
      // the chunks of the old position do not reach the end; a later seek
      // back re-cues the decoder instead of resuming a stale window, and
      // the revision bump voids a pull or a seek still in flight
      s.gen += 1;
      s.chunks = [];
      s.covered = s.duration;
      s.done = true;
      this.dispatchEvent(new Event('pause'));
      this.dispatchEvent(new Event('ended'));
      return;
    }

    const hit = this.#chunkAt(target);
    if (hit && !s.seeking) {
      // the window covers the position; no decoder round trip is needed
      // (the run start waits for its decoding lead on its own). A seek
      // still in flight re-cues the decoder elsewhere: resuming the
      // cached window now would let the older seek's result land on the
      // newer state and corrupt its coverage, so the target chains
      // behind that seek below instead
      this.#scheduleRun();
      this.#maintain();
      return;
    }

    // an out-of-window position re-cues the decoder (and so does an
    // in-window one while another seek is re-cuing: that older command
    // has already moved the decoder elsewhere); a seek that arrives
    // while another one is re-cuing simply chains behind it (the
    // wrapper matches the responses in order and the stale chunks are
    // dropped by their epoch), which keeps the newest target from being
    // lost. Only the newest seek of a chain may write the stream state:
    // the older ones resolve first and their results must never land on
    // the newer target's state
    const gen = s.gen;
    const pending = s.session.seek(target).then(() => {
      if (this.stream !== s) {
        return;
      }
      if (s.seeking !== pending) {
        return; // a newer seek owns the stream; its result stands
      }
      s.seeking = null;
      if (s.gen !== gen) {
        return; // the element moved the state on (a seek to the end)
      }
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
      if (s.seeking !== pending) {
        return; // a newer seek owns the stream; its result stands
      }
      s.seeking = null;
      // the wrapper fails a pending seek before it calls onstop, so the
      // failure is reported already by the time this rejection runs
      if (s.failed) {
        return;
      }
      if (s.gen !== gen) {
        return; // the element moved the state on; the newer seek stands
      }
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
    s.seeking = pending;
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
    }
    else {
      // the seek moves the playhead only; whether the track plays stays
      // as it was
      const wasPlaying = !!this.source;
      if (this.source) {
        this.pause();
      }
      if (this.audioBuffer) {
        this.stat.stop = Math.max(0, Math.min(this.audioBuffer.duration, v));
        if (wasPlaying) {
          this.play();
        }
      }
    }
    // the play loop writes the label only while playing; a seek shows where
    // the playhead went right away (a paused scrub updates it too)
    if (this.stream || this.audioBuffer) {
      this.shadowRoot.getElementById('current').textContent = htime(this.currentTime);
    }
  }
  get volume() {
    return this.shadowRoot.getElementById('volume').volume;
  }
  set volume(v) {
    v = Math.max(0, Math.min(2, v));
    this.shadowRoot.getElementById('volume').volume = v;
    if (this.sound) {
      this.sound.gain.value = v;
    }
    this.dispatchEvent(new Event('volumechange'));
  }
}
window.customElements.define('audio-view', AudioView);
