import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, defineComponent } from 'vue';
import { useDictation } from '../../frontend/src/lib/useDictation';

// Exercise the real Vue composable and lifecycle without a microphone or external speech service.
class SpeechFixture {
  static last: SpeechFixture;
  static failStart = false;
  lang = ''; interimResults = true; continuous = true;
  onresult: ((e: { results: { transcript: string }[][] }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (()=>void)|null=null;
  aborted = false;
  constructor() { SpeechFixture.last = this; }
  start() { if (SpeechFixture.failStart) throw new Error('microphone unavailable'); this.onstart?.(); }
  stop() { this.onend?.(); }
  abort() { this.aborted = true; this.onend?.(); }
}
const renderer = createRenderer({
  patchProp() {}, insert() {}, remove() {},
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null,
});
function mount(speech = true) {
  vi.stubGlobal('window', { isSecureContext: true, ...(speech ? { SpeechRecognition: SpeechFixture } : {}) });
  const transcript = vi.fn();
  let control!: ReturnType<typeof useDictation>;
  const app = renderer.createApp(defineComponent({ setup() { control = useDictation(transcript); return () => null; } }));
  app.mount({});
  return { control, transcript, unmount: () => app.unmount() };
}
afterEach(() => { vi.unstubAllGlobals(); SpeechFixture.failStart = false; });
describe('voice input creates editable text and handles browser failure', () => {
  it('emits a transcript only, uses the selected language, and stops on unmount', () => {
    const h = mount();
    h.control.start('fil-PH');
    expect(h.control.listening.value).toBe(true);
    expect(SpeechFixture.last.lang).toBe('fil-PH');
    expect(SpeechFixture.last.continuous).toBe(false);
    SpeechFixture.last.onresult!({ results: [[{ transcript: 'Counted 12 pallets' }]] });
    expect(h.transcript).toHaveBeenCalledExactlyOnceWith('Counted 12 pallets');
    h.unmount();
    expect(SpeechFixture.last.aborted).toBe(true);
    expect(SpeechFixture.last.onresult).toBeNull();
  });
  it('falls back to typing when speech is unavailable', () => {
    const h = mount(false);
    expect(h.control.supported).toBe(false);
    h.control.start();
    expect(h.control.error.value).toContain('Type');
    expect(h.transcript).not.toHaveBeenCalled(); h.unmount();
  });
  it('explains denied permission and no-speech errors without submitting anything', () => {
    const h = mount(); h.control.start();
    SpeechFixture.last.onerror!({ error: 'not-allowed' });
    expect(h.control.listening.value).toBe(false);
    expect(h.control.error.value).toContain('denied');
    h.control.start();
    SpeechFixture.last.onerror!({ error: 'no-speech' });
    expect(h.control.error.value).toContain('No speech');
    expect(h.transcript).not.toHaveBeenCalled(); h.unmount();
  });
  it('handles start failures, normal ending and explicit stop', () => {
    const h = mount(); SpeechFixture.failStart = true; h.control.start();
    expect(h.control.listening.value).toBe(false);
    expect(h.control.error.value).toContain('Could not start');
    SpeechFixture.failStart = false; h.control.start();
    SpeechFixture.last.onend!(); expect(h.control.listening.value).toBe(false);
    h.control.start(); h.control.stop(); expect(h.control.listening.value).toBe(false);
    h.unmount();
  });
});
