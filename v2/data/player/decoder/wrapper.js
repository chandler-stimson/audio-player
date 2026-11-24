/* global AudioContext, fetch */

{
  // A single AudioContext is shared by every decode and playback. Browsers
  // only allow a limited number of live contexts (about 6) and the previous
  // per-decode contexts were never closed.
  let context;
  const sharedContext = () => context || (context = new AudioContext());

  // one worker for user-critical decodes, one for background prefetches and
  // one for the on-demand metadata fetches so that none of them delays the
  // track the user waits for
  const workers = {};
  const queues = {
    user: [],
    prefetch: [],
    meta: []
  };
  const busy = {
    user: false,
    prefetch: false,
    meta: false
  };
  // the job that currently occupies a worker (set when dequeued)
  const running = {};

  // pending jobs by id; a job that is not in the cache anymore is abandoned
  // and its result is discarded when the worker reports back
  const cache = {};

  /* reject everything that a job is still waiting for */
  const failJob = (job, error) => {
    if (job.kind === 'session') {
      if (job.rejectOpen) {
        const reject = job.rejectOpen;
        delete job.resolveOpen;
        delete job.rejectOpen;
        reject(error);
      }
      for (const p of job.pendingPulls.splice(0)) {
        p.reject(error);
      }
      for (const p of job.pendingSeeks.splice(0)) {
        p.reject(error);
      }
      if (job.closedResolve) {
        const resolve = job.closedResolve;
        delete job.closedResolve;
        resolve();
      }
    }
    else {
      job.reject(error);
    }
  };

  /* a session message from the worker of `owner` */
  const sessionMessage = (owner, d) => {
    const job = cache[d.id];

    if (d.type === 'meta') {
      if (job && job.resolveOpen) {
        const resolve = job.resolveOpen;
        delete job.resolveOpen;
        delete job.rejectOpen;
        job.session.meta = d.meta;
        resolve(job.session);
      }
      return;
    }
    if (d.type === 'chunk') {
      // the chunks of a superseded epoch (the position before a seek) are
      // dropped on the floor
      if (job && d.epoch === job.epoch && job.session.onchunk) {
        job.session.onchunk(d);
      }
      return;
    }
    if (d.type === 'pulled') {
      const p = job && job.pendingPulls.shift();
      if (p) {
        p.resolve({covered: d.covered, done: d.done, stalled: d.stalled});
      }
      return;
    }
    if (d.type === 'seeked') {
      if (job) {
        job.epoch = d.epoch;
      }
      const p = job && job.pendingSeeks.shift();
      if (p) {
        p.resolve(d);
      }
      return;
    }
    if (d.type === 'seekfailed') {
      const p = job && job.pendingSeeks.shift();
      if (p) {
        p.reject(Error('SEEK_FAILED'));
      }
      return;
    }
    if (d.type === 'closed') {
      if (job) {
        delete cache[job.id];
        if (running[owner] === job) {
          delete running[owner];
          busy[owner] = false;
        }
        if (job.closedResolve) {
          const resolve = job.closedResolve;
          delete job.closedResolve;
          resolve();
        }
      }
      run(owner);
      return;
    }
    if (d.type === 'error') {
      if (job) {
        delete cache[job.id];
        if (running[owner] === job) {
          delete running[owner];
          busy[owner] = false;
        }
        failJob(job, Error(d.error));
        if (job.session.onstop) {
          job.session.onstop(Error(d.error));
        }
      }
      run(owner);
    }
  };

  const spawn = owner => {
    const worker = new Worker('decoder/worker.js');
    worker.onmessage = e => {
      const {meta, channels, error, stdout, stderr, id} = e.data;

      // a streaming session message is routed by its type
      if (e.data.type) {
        return sessionMessage(owner, e.data);
      }

      const job = cache[id];
      delete cache[id];

      if (running[owner] && running[owner].id === id) {
        delete running[owner];
      }
      busy[owner] = false;
      run(owner);

      if (!job) {
        return; // the job was canceled while decoding
      }
      if (error) {
        console.info('stderr', stderr, 'stdout', stdout);
        return job.reject(Error(error));
      }

      const context = sharedContext();
      // channel buffers arrive transferred (zero-copy) from the worker
      const audioBuffer = context.createBuffer(meta['Channels'], channels[0].length, meta['Sample Rate']);
      channels.forEach((ch, c) => audioBuffer.copyToChannel(ch, c));

      job.resolve({
        context,
        audioBuffer,
        meta: Object.assign({}, meta),
        stdout,
        stderr
      });
    };
    worker.onerror = e => {
      // the worker is dead; reject everything that belongs to it and let the
      // next job spawn a fresh one
      const error = Error(e.message || 'DECODER_WORKER_CRASH');
      queues[owner] = [];
      delete running[owner];
      busy[owner] = false;
      delete workers[owner];

      for (const id of Object.keys(cache)) {
        const job = cache[id];
        if (job.owner === owner) {
          delete cache[id];
          failJob(job, error);
          if (job.kind === 'session' && job.session.onstop) {
            job.session.onstop(error);
          }
        }
      }
    };
    return worker;
  };

  const run = owner => {
    if (busy[owner]) {
      return;
    }
    const job = queues[owner].shift();
    if (!job) {
      return;
    }
    busy[owner] = true;
    running[owner] = job;

    Promise.resolve(job.arrayBuffer || (job.kind !== 'session' && job.href ?
      fetch(job.href).then(r => r.arrayBuffer()) : null)).then(ab => {
      if (cache[job.id] !== job) {
        // canceled while the input was being fetched; only the job that
        // still owns the slot may release it
        if (running[owner] === job) {
          delete running[owner];
          busy[owner] = false;
          run(owner);
        }
        return;
      }

      if (!workers[owner]) {
        workers[owner] = spawn(owner);
      }

      job.posted = true;

      if (job.kind === 'session') {
        // the streaming session reads its input itself: a local file is
        // sliced inside the worker (the handle is cloned, not the bytes) and
        // a network track is downloaded there chunk by chunk
        workers[owner].postMessage({
          cmd: 'open',
          id: job.id,
          file: job.file,
          href: job.href,
          arrayBuffer: job.arrayBuffer
        });
        return;
      }

      // NOTE: the input is cloned (not transferred) on purpose so that the
      // main thread keeps its copy for the native `decodeAudioData` fallback
      // in case FFmpeg cannot handle the file
      workers[owner].postMessage({
        name: job.name,
        binary: new Uint8Array(ab),
        id: job.id
      });
    }).catch(e => {
      if (cache[job.id] === job) {
        delete cache[job.id];
      }
      // the slot is only released by the job that owns it
      if (running[owner] === job) {
        delete running[owner];
        busy[owner] = false;
        run(owner);
      }
      failJob(job, e);
    });
  };

  // abandon the job that currently occupies the worker of `owner`; when it
  // was already posted, restarting the worker is faster than letting a decode
  // that nobody waits for run to completion. A streaming session always needs
  // this: its worker holds decoder state that outlives every single command.
  const preempt = owner => {
    const job = running[owner];
    if (!job) {
      return false;
    }
    delete running[owner];
    delete cache[job.id];

    if (job.posted) {
      workers[owner].terminate();
      delete workers[owner];
    }
    // release the slot immediately; the input fetch of an abandoned job keeps
    // running in the background and can no longer touch the slot state
    busy[owner] = false;

    failJob(job, Error('CANCELED'));
    // a preempted session must tell its host that it is gone (the host
    // usually initiated the superseding open itself, but its stream state
    // of the old session still has to stop)
    if (job.kind === 'session' && job.session.onstop) {
      job.session.onstop(Error('CANCELED'));
    }
    return true;
  };

  window.decoder = {
    versions: {
      core: '0.2.0',
      ffmpeg: 'n4.0.2'
    },
    context: sharedContext,

    /* the whole-file decode of a small input (the decoded result is cached
       by the playlist); unchanged behavior of the original wrapper */
    decode({name, href, arrayBuffer, owner = 'user'}) {
      return new Promise((resolve, reject) => {
        const id = Math.random();
        const job = {
          kind: 'batch',
          name,
          href,
          arrayBuffer,
          owner,
          resolve,
          reject,
          id
        };
        cache[id] = job;
        queues[owner].push(job);

        if (owner === 'user' && busy.user) {
          // a newly requested track supersedes the one that is decoding
          preempt('user');
        }
        run(owner);
      });
    },

    /* open a streaming decode session; large inputs are never read as a
       whole: the worker slices a local file on demand or downloads a network
       track chunk by chunk and posts the decoded audio in ~1s pieces */
    open({file, href, arrayBuffer, owner = 'user', onchunk, onstop}) {
      return new Promise((resolve, reject) => {
        const id = Math.random();
        const job = {
          kind: 'session',
          id,
          owner,
          // the input descriptor that run() posts with the open command
          file,
          href,
          arrayBuffer,
          epoch: 0,
          pendingPulls: [],
          pendingSeeks: [],
          resolveOpen: null,
          rejectOpen: null,
          closedResolve: null
        };
        cache[id] = job;

        const post = msg => {
          // a command only reaches the worker while the session owns it
          if (cache[job.id] !== job || running[owner] !== job) {
            return false;
          }
          workers[owner].postMessage(Object.assign({id: job.id}, msg));
          return true;
        };

        const session = {
          id,
          meta: null,
          onchunk,
          onstop,
          /* decode until the coverage reaches `seconds` (a content
             position); the chunks arrive through onchunk meanwhile */
          pullUntil(seconds) {
            return new Promise((res, rej) => {
              if (!post({cmd: 'pull', until: seconds})) {
                return rej(Error('CANCELED'));
              }
              job.pendingPulls.push({resolve: res, reject: rej});
            });
          },
          /* jump to a content position; the epoch changes and the chunks of
             the old position are dropped */
          seek(seconds) {
            return new Promise((res, rej) => {
              if (!post({cmd: 'seek', to: seconds})) {
                return rej(Error('CANCELED'));
              }
              job.pendingSeeks.push({resolve: res, reject: rej});
            });
          },
          /* release the decoder state of the session; the worker itself
             stays alive for the next one */
          close() {
            return new Promise(res => {
              if (cache[job.id] !== job) {
                return res(); // already closed or preempted
              }
              job.closedResolve = res;
              if (!post({cmd: 'close'})) {
                // the worker is gone; there is nothing to wait for
                delete cache[job.id];
                delete job.closedResolve;
                res();
              }
            });
          }
        };
        job.session = session;

        job.resolveOpen = resolve;
        job.rejectOpen = reject;

        queues[owner].push(job);
        // a session occupies its worker until it closes, so nothing may
        // queue behind it: it supersedes the running session of its owner.
        // A user job also supersedes a running batch decode like it always
        // did; a background batch decode is short and may finish first.
        if (busy[owner]) {
          const r = running[owner];
          if (owner === 'user' || r.kind === 'session') {
            preempt(owner);
          }
        }
        run(owner);
      });
    },

    cancel(owner) {
      // drop everything that is queued ...
      queues[owner] = queues[owner].filter(j => {
        delete cache[j.id];
        failJob(j, Error('CANCELED'));
        if (j.kind === 'session' && j.session.onstop) {
          j.session.onstop(Error('CANCELED'));
        }
        return false;
      });
      // ... and abandon the in-flight decode
      preempt(owner);
      run(owner);
    }
  };
}
