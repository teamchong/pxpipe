// Svelte entry point. Mounts <App> on #app. The bundler injects the compiled
// IIFE as a string into dashboard.ts; at runtime the browser just sees a
// regular module script that imports App from the bundle root.
import { mount } from 'svelte';
import App from './App.svelte';

const target = document.getElementById('app');
if (target) {
  // Svelte 5: components are mounted with `mount()`, not `new Component()`.
  // The legacy `new App({ target })` API is gone unless the build sets
  // `compatibility.componentApi: 4` - and that shim isn't worth carrying.
  mount(App, { target });
} else {
  // Should never happen - the HTML template always emits #app. But if a
  // stale cached page is served alongside a new bundle, fail loud rather
  // than silent so the operator notices.
  document.body.textContent = 'pxpipe dashboard: mount target #app missing';
}
