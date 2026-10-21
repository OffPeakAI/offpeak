/* Small, local illustration controller. No service requests or simulated account actions. */
(() => {
  'use strict';

  const mounted = new WeakSet();
  const animatedMeters = new Set();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const waveHeights = [16, 22, 29, 21, 36, 48, 28, 43, 59, 35, 24, 44, 65, 53, 30, 48, 69, 46, 31, 42, 63, 51, 33, 56, 71, 49, 35, 23, 45, 61, 39, 28, 44, 32, 21, 30, 18, 24];
  let visibilityObserver;
  let meterInterval;

  function buildWave(scene) {
    const wave = scene.querySelector('[data-wave-bars]');
    if (!wave || wave.dataset.ready) return;

    wave.dataset.ready = 'true';
    const fragment = document.createDocumentFragment();
    waveHeights.forEach((height, index) => {
      const bar = document.createElement('span');
      bar.className = 'wave-bar';
      bar.style.setProperty('--bar-height', `${height}px`);
      bar.style.setProperty('--bar-delay', `${(index % 7) * -0.31}s`);
      fragment.appendChild(bar);
    });
    wave.appendChild(fragment);
    animatedMeters.add(scene);
  }

  function updateMeters() {
    for (const scene of animatedMeters) {
      if (!scene.isConnected) {
        animatedMeters.delete(scene);
        continue;
      }
      if (!scene.classList.contains('is-inview')) continue;
      const counter = scene.querySelector('[data-token-count]');
      if (!counter) continue;
      if (reducedMotion.matches) {
        counter.textContent = '200';
        continue;
      }
      const elapsed = (performance.now() - Number(scene.dataset.meterStart || 0)) % 9000;
      const progress = Math.max(0, Math.min(1, (elapsed - 630) / 5130));
      counter.textContent = String(Math.round(200 * progress));
    }
  }

  function setupScene(scene, index) {
    if (mounted.has(scene)) return;
    mounted.add(scene);
    const cycleOffset = (index % 4) * -1.25;
    scene.style.setProperty('--scene-delay', `${cycleOffset}s`);
    scene.dataset.meterStart = String(performance.now() + cycleOffset * 1000);
    buildWave(scene);

    // The card wrapper is the hit target; the illustrations themselves remain descriptive.
    const hoverTarget = scene.parentElement || scene;
    hoverTarget.addEventListener('pointerenter', event => {
      if (event.pointerType === 'touch' || reducedMotion.matches) return;
      scene.classList.add('is-hover');
    });
    hoverTarget.addEventListener('pointermove', event => {
      if (event.pointerType === 'touch' || reducedMotion.matches) return;
      const rect = hoverTarget.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = ((event.clientX - rect.left) / rect.width - .5) * 7;
      const y = ((event.clientY - rect.top) / rect.height - .5) * 6;
      scene.style.setProperty('--pointer-x', `${x.toFixed(2)}px`);
      scene.style.setProperty('--pointer-y', `${y.toFixed(2)}px`);
    });
    hoverTarget.addEventListener('pointerleave', () => {
      scene.classList.remove('is-hover');
      scene.style.setProperty('--pointer-x', '0px');
      scene.style.setProperty('--pointer-y', '0px');
    });

    if (visibilityObserver) visibilityObserver.observe(scene);
    else scene.classList.add('is-inview');
  }

  function mount(root = document) {
    if (!visibilityObserver && 'IntersectionObserver' in window) {
      visibilityObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          entry.target.classList.toggle('is-inview', entry.isIntersecting);
        }
      }, { rootMargin: '90px 0px', threshold: 0.01 });
    }

    const scenes = [];
    if (root.matches && root.matches('.offpeak-scene')) scenes.push(root);
    scenes.push(...root.querySelectorAll('.offpeak-scene'));
    scenes.forEach(setupScene);

    if (!meterInterval && animatedMeters.size) {
      meterInterval = window.setInterval(updateMeters, 120);
    }
    updateMeters();
    return scenes;
  }

  window.OffpeakScenes = { mount };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mount(), { once: true });
  } else {
    mount();
  }
})();
