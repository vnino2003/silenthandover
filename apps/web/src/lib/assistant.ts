export function openWorkAssistant() { window.dispatchEvent(new CustomEvent('sh:assistant-open', { detail: 'prepare' })); }
