const drag = {
  cs: [],
  onDrag(c) {
    drag.cs.push(c);
  }
};
window.drag = drag;

const drop = async es => {
  const files = [];
  const entries = es.map(f => f.webkitGetAsEntry ? f.webkitGetAsEntry() : ({
    isFile: true,
    file(c) {
      c(f);
    }
  })).filter(a => a);

  const checkEntry = async entry => {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    if (file.type) {
      if (file.type.startsWith('audio/') || file.type.startsWith('video/')) {
        files.push(file);
      }
    }
    else {
      if (file.name.startsWith('.') === false) {
        files.push(file);
      }
    }
  };

  const readEntries = entry => new Promise((resolve, reject) => {
    const directoryReader = entry.createReader();
    directoryReader.readEntries(async entries => {
      for (const entry of entries) {
        if (entry.isFile) {
          await checkEntry(entry);
        }
        else {
          await readEntries(entry);
        }
      }
      resolve();
    }, reject);
  });

  for (const entry of entries) {
    if (entry.isFile) {
      await checkEntry(entry).catch(e => console.warn('cannot add this file', e));
    }
    else {
      await readEntries(entry).catch(e => console.warn('cannot browse this directory', e));
    }
  }

  if (files.length) {
    for (const c of drag.cs) {
      c(files);
    }
  }
};

document.addEventListener('dblclick', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'video/*, audio/*';
  input.onchange = () => {
    if (input.files.length) {
      drop([...input.files]);
    }
  };
  input.click();
});

document.addEventListener('dragover', e => {
  e.preventDefault();
});
document.addEventListener('drop', e => {
  e.preventDefault();
  document.querySelector('iframe').style['pointer-events'] = 'unset';
  drop([...e.dataTransfer.items]);
});
document.addEventListener('dragleave', () => {
  document.querySelector('iframe').style['pointer-events'] = 'unset';
  console.log('done');
});
window.addEventListener('message', e => {
  if (e.data.method === 'drag-over') {
    document.querySelector('iframe').style['pointer-events'] = 'none';
  }
});
