document.addEventListener('keydown', e => {
  const metaKey = (e.metaKey || e.ctrlKey) && e.shiftKey;

  const click = name => {
    e.preventDefault();
    e.stopPropagation();

    const d = document.getElementById(name);
    if (!d.disabled) {
      d.dispatchEvent(new Event('click'));
    }
  };
  if (e.code === 'KeyS' && metaKey) {
    click('shuffle');
  }
  else if (e.code === 'KeyR' && metaKey) {
    click('repeat');
  }
  else if (e.code === 'KeyP' && metaKey) {
    click('previous');
  }
  else if (e.code === 'KeyN' && metaKey) {
    click('next');
  }
  else if (e.code === 'KeyJ') {
    click('skip-back');
  }
  else if (e.code === 'KeyL') {
    click('skip-forward');
  }
});
