export function cleanupWebsiteRuntimeState({ reload = true } = {}) {
  localStorage.clear();
  sessionStorage.clear();
  window.dispatchEvent(new CustomEvent('makhzan:dev-cleanup'));

  if (reload) {
    window.location.reload();
  }
}

if (import.meta.env.DEV) {
  window.makhzanDevCleanup = cleanupWebsiteRuntimeState;
}
