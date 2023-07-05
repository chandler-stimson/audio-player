{
  const worker = new Worker('decoder/worker.js');
  const cache = {};
  worker.onmessage = e => {
    const {meta, channels, error, stdout, stderr, id} = e.data;
    const c = cache[id];
    delete cache[id];

    if (error) {
      console.info('stderr', stderr, 'stdout', stdout);
      return c.reject(Error(error));
    }
    const context = new AudioContext();

    const audioBuffer = context.createBuffer(meta['Channels'], channels[0].length, meta['Sample Rate']);

    channels.forEach((ch, c) => audioBuffer.copyToChannel(ch, c));
    c.resolve({
      context,
      audioBuffer,
      meta: Object.assign({}, meta),
      stdout,
      stderr
    });
    job();
  };

  let busy = false;
  const jobs = [];
  const job = function() {
    if (busy) {
      return;
    }

    const job = jobs.shift();
    if (job) {
      busy = true;

      Promise.resolve(job.arrayBuffer || fetch(job.href).then(r => r.arrayBuffer())).then(ab => {
        const binary = new Uint8Array(ab);

        const id = Math.random();
        cache[id] = job;

        worker.postMessage({
          name: job.name,
          binary,
          id
        });
      }).catch(e => job.reject(e)).finally(() => {
        busy = false;
      });
    }
  };
  window.decoder = {
    versions: {
      core: '0.1.2',
      ffmpeg: 'f5a61a1728cba3fdd19370e8a020063676604efa'
    },
    decode({name, href, arrayBuffer}) {
      return new Promise((resolve, reject) => {
        jobs.push({name, href, arrayBuffer, resolve, reject});
        job();
      });
    }
  };
}
