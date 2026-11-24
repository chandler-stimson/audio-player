/* global AudioContext, fetch */

{
  // A single AudioContext is shared by every decode and playback. Browsers
  // only allow a limited number of live contexts (about 6) and the previous
  // per-decode contexts were never closed.
  let context;
  const sharedContext = () => context || (context = new AudioContext());

  // one worker for user-critical decodes and one for background prefetches so
  // that decoding the next track never delays the track the user waits for
  const workers = {};
  const queues = {
    user: [],
    prefetch: []
  };
  const busy = {
    user: false,
    prefetch: false
  };
  // the job that currently occupies a worker (set when dequeued)
  const running = {};

  // pending jobs by id; a job that is not in the cache anymore is abandoned
  // and its result is discarded when the worker reports back
  const cache = {};

  const spawn = owner => {
    const worker = new Worker('decoder/worker.js');
    worker.onmessage = e => {
      const {meta, channels, error, stdout, stderr, id} = e.data;
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
          job.reject(error);
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

    Promise.resolve(job.arrayBuffer || fetch(job.href).then(r => r.arrayBuffer())).then(ab => {
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
      job.reject(e);
    });
  };

  // abandon the job that currently occupies the worker of `owner`; when it
  // was already posted, restarting the worker is faster than letting a decode
  // that nobody waits for run to completion
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

    job.reject(Error('CANCELED'));
    return true;
  };

  window.decoder = {
    versions: {
      core: '0.1.2',
      ffmpeg: 'f5a61a1728cba3fdd19370e8a020063676604efa'
    },
    context: sharedContext,
    decode({name, href, arrayBuffer, owner = 'user'}) {
      return new Promise((resolve, reject) => {
        const id = Math.random();
        const job = {
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
    cancel(owner) {
      // drop everything that is queued ...
      queues[owner] = queues[owner].filter(j => {
        delete cache[j.id];
        j.reject(Error('CANCELED'));
        return false;
      });
      // ... and abandon the in-flight decode
      preempt(owner);
      run(owner);
    }
  };
}
